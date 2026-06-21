/**
 * adfParser.ts
 *
 * Parses Azure Data Factory (ADF) and Microsoft Fabric Data Pipeline JSON
 * into the shared PipelineDocument format.
 *
 * Both ADF and Fabric use an identical pipeline JSON schema, so a single
 * parser handles both. The caller provides the pipeline_type ("adf" or
 * "fabric") based on how the file was detected.
 *
 * Supports:
 *  - Standalone pipeline JSON  (exported from Azure Portal / Fabric)
 *  - ARM template format       (resources[*].type == ".../pipelines")
 *
 * Nested activities inside ForEach and IfCondition are flattened, with
 * the parent activity name recorded in parameters.parent_context.
 */

import type {
  ApiInfo,
  Component,
  Connection,
  DataEndpoint,
  JobMetadata,
  PipelineDocument,
  SqlInfo,
} from "./parser.js";

// ---------------------------------------------------------------------------
// Raw ADF JSON types (loose — we validate at runtime)
// ---------------------------------------------------------------------------

interface RawActivity {
  name?: string;
  type?: string;
  description?: string;
  dependsOn?: Array<{ activity?: string; dependencyConditions?: string[] }>;
  typeProperties?: Record<string, unknown>;
  inputs?: Array<{ referenceName?: string; type?: string }>;
  outputs?: Array<{ referenceName?: string; type?: string }>;
  linkedServiceName?: { referenceName?: string; type?: string };
  policy?: Record<string, unknown>;
}

interface RawPipelineProperties {
  description?: string;
  activities?: RawActivity[];
  parameters?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  annotations?: string[];
}

interface RawPipeline {
  name?: string;
  properties?: RawPipelineProperties;
}

// ARM template resource entry
interface RawArmResource {
  type?: string;
  name?: string;
  properties?: RawPipelineProperties;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parses an ADF or Fabric pipeline JSON into a PipelineDocument.
 *
 * @param raw         - Parsed JSON object (unknown shape — validated here)
 * @param pipelineType - "adf" or "fabric"
 */
export function parseAdfPipeline(
  raw: unknown,
  pipelineType: "adf" | "fabric",
): PipelineDocument {
  const pipeline = extractPipelineRoot(raw);
  const props = pipeline.properties ?? {};

  // Flatten all activities, including nested ones inside ForEach / IfCondition
  const allActivities = flattenActivities(props.activities ?? []);

  const components = buildComponents(allActivities);
  const connections = buildConnections(allActivities);
  const sql = buildSqlInfo(allActivities);
  const apis = buildApiInfo(allActivities);
  const { sources, targets } = buildEndpoints(allActivities);

  return {
    pipeline_type: pipelineType,
    job: buildJobMetadata(pipeline, props),
    components,
    connections,
    sql,
    apis,
    sources,
    targets,
  };
}

// ---------------------------------------------------------------------------
// Root extraction (standalone JSON or ARM template)
// ---------------------------------------------------------------------------

function extractPipelineRoot(raw: unknown): RawPipeline {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid pipeline JSON: not an object.");
  }

  const obj = raw as Record<string, unknown>;

  // ARM template: { "$schema": "...", "resources": [ { "type": ".../pipelines", ... } ] }
  if (Array.isArray(obj["resources"])) {
    const pipelineResource = (obj["resources"] as RawArmResource[]).find(
      (r) =>
        typeof r.type === "string" &&
        r.type.toLowerCase().endsWith("/pipelines"),
    );
    if (pipelineResource) {
      return {
        name: extractSimpleName(pipelineResource.name),
        properties: pipelineResource.properties,
      };
    }
  }

  // Standalone pipeline JSON: { "name": "...", "properties": { "activities": [...] } }
  if (obj["properties"] && typeof obj["properties"] === "object") {
    const props = obj["properties"] as Record<string, unknown>;
    if (Array.isArray(props["activities"])) {
      return obj as RawPipeline;
    }
  }

  throw new Error(
    "Unrecognised ADF/Fabric JSON format. Expected { name, properties: { activities: [...] } } " +
      "or an ARM template with a pipeline resource.",
  );
}

/**
 * ARM template names can be expressions like "[concat(parameters('factoryName'), '/MyPipeline')]".
 * Extract the last segment after '/' as the human-readable name.
 */
function extractSimpleName(name?: string): string | undefined {
  if (!name) return undefined;
  const match = name.match(/\/([^/']+)[')]?\s*$/);
  return match ? match[1] : name;
}

// ---------------------------------------------------------------------------
// Flatten nested activities
// ---------------------------------------------------------------------------

function flattenActivities(
  activities: RawActivity[],
  parentContext?: string,
): RawActivity[] {
  const result: RawActivity[] = [];

  for (const act of activities) {
    const annotated: RawActivity = parentContext
      ? {
          ...act,
          typeProperties: {
            ...((act.typeProperties as Record<string, unknown>) ?? {}),
            parent_context: parentContext,
          },
        }
      : act;

    result.push(annotated);

    const tp = act.typeProperties as Record<string, unknown> | undefined;
    if (!tp) continue;

    // ForEach: typeProperties.activities
    if (Array.isArray(tp["activities"])) {
      result.push(
        ...flattenActivities(
          tp["activities"] as RawActivity[],
          act.name ?? "ForEach",
        ),
      );
    }

    // IfCondition: typeProperties.ifTrueActivities + ifFalseActivities
    if (Array.isArray(tp["ifTrueActivities"])) {
      result.push(
        ...flattenActivities(
          tp["ifTrueActivities"] as RawActivity[],
          `${act.name ?? "IfCondition"} (true)`,
        ),
      );
    }
    if (Array.isArray(tp["ifFalseActivities"])) {
      result.push(
        ...flattenActivities(
          tp["ifFalseActivities"] as RawActivity[],
          `${act.name ?? "IfCondition"} (false)`,
        ),
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Builders — each maps a list of RawActivity → part of PipelineDocument
// ---------------------------------------------------------------------------

function buildJobMetadata(
  pipeline: RawPipeline,
  props: RawPipelineProperties,
): JobMetadata {
  const paramNames = props.parameters
    ? Object.keys(props.parameters).join(", ") || null
    : null;

  return {
    name: (pipeline.name as string | null | undefined) ?? null,
    version: null,
    description: props.description ?? null,
    author: null,
    created_date: null,
    modified_date: null,
    purpose: paramNames ? `Pipeline parameters: ${paramNames}` : null,
    status: null,
  };
}

function buildComponents(activities: RawActivity[]): Component[] {
  return activities.map((act) => {
    const tp = (act.typeProperties as Record<string, unknown>) ?? {};

    // Collect a flat key→value summary of typeProperties for the parameters bag
    const parameters: Record<string, string> = {};
    for (const [k, v] of Object.entries(tp)) {
      if (
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean"
      ) {
        parameters[k] = String(v);
      }
    }

    // Linked service name
    const linkedService = act.linkedServiceName?.referenceName;
    if (linkedService) parameters["linked_service"] = linkedService;

    // Retry policy
    const policy = act.policy as Record<string, unknown> | undefined;
    if (policy) {
      if (typeof policy["retry"] !== "undefined")
        parameters["retry"] = String(policy["retry"]);
      if (typeof policy["timeout"] === "string")
        parameters["timeout"] = policy["timeout"];
    }

    return {
      component_id: act.name ?? null,
      component_name: act.name ?? null,
      component_type: act.type ?? null,
      position: null,
      parameters,
    };
  });
}

function buildConnections(activities: RawActivity[]): Connection[] {
  const connections: Connection[] = [];

  for (const act of activities) {
    for (const dep of act.dependsOn ?? []) {
      connections.push({
        source: dep.activity ?? null,
        target: act.name ?? null,
        connection_type: dep.dependencyConditions?.join(", ") ?? "Succeeded",
        label: null,
      });
    }
  }

  return connections;
}

function buildSqlInfo(activities: RawActivity[]): SqlInfo[] {
  const result: SqlInfo[] = [];

  for (const act of activities) {
    const tp = (act.typeProperties as Record<string, unknown>) ?? {};

    // Copy source SQL
    const source = tp["source"] as Record<string, unknown> | undefined;
    if (source) {
      const query = stringField(source, ["sqlReaderQuery", "query"]);
      const table = stringField(source, ["sqlReaderStoredProcedureName"]);
      if (query || table) {
        result.push({
          component_id: act.name ?? null,
          component_type: act.type ?? null,
          query,
          table_name: table,
          database_type: inferDbType(source["type"] as string | undefined),
        });
      }
    }

    // Lookup source SQL
    const lookupSource = tp["source"] as Record<string, unknown> | undefined;
    if (act.type === "Lookup" && lookupSource) {
      const query = stringField(lookupSource, ["sqlReaderQuery", "query"]);
      if (query) {
        result.push({
          component_id: act.name ?? null,
          component_type: "Lookup",
          query,
          table_name: null,
          database_type: inferDbType(
            lookupSource["type"] as string | undefined,
          ),
        });
      }
    }

    // Stored procedure
    if (
      act.type === "SqlServerStoredProcedure" ||
      act.type === "AzureFunctionActivity"
    ) {
      const procName = stringField(tp, ["storedProcedureName"]);
      if (procName) {
        result.push({
          component_id: act.name ?? null,
          component_type: act.type,
          query: null,
          table_name: procName,
          database_type: inferDbType(act.linkedServiceName?.referenceName),
        });
      }
    }

    // Script activity
    if (act.type === "Script") {
      const scripts = tp["scripts"] as
        | Array<Record<string, unknown>>
        | undefined;
      if (Array.isArray(scripts)) {
        for (const s of scripts) {
          const text = stringField(s, ["text"]);
          if (text) {
            result.push({
              component_id: act.name ?? null,
              component_type: "Script",
              query: text,
              table_name: null,
              database_type: null,
            });
          }
        }
      }
    }
  }

  return result;
}

function buildApiInfo(activities: RawActivity[]): ApiInfo[] {
  return activities
    .filter((act) => act.type === "WebActivity" || act.type === "HttpActivity")
    .map((act) => {
      const tp = (act.typeProperties as Record<string, unknown>) ?? {};
      const rawHeaders = tp["headers"] as Record<string, unknown> | undefined;
      const headers: Record<string, string> = {};
      if (rawHeaders) {
        for (const [k, v] of Object.entries(rawHeaders)) {
          headers[k] = typeof v === "string" ? v : JSON.stringify(v);
        }
      }
      return {
        component_id: act.name ?? null,
        component_type: act.type ?? null,
        endpoint: stringField(tp, ["url", "endpoint"]),
        http_method: stringField(tp, ["method"]),
        headers,
      };
    });
}

function buildEndpoints(activities: RawActivity[]): {
  sources: DataEndpoint[];
  targets: DataEndpoint[];
} {
  const sources: DataEndpoint[] = [];
  const targets: DataEndpoint[] = [];

  for (const act of activities) {
    const tp = (act.typeProperties as Record<string, unknown>) ?? {};

    // Sources from inputs array
    for (const input of act.inputs ?? []) {
      if (!input.referenceName) continue;
      sources.push({
        component_id: act.name ?? null,
        component_type: act.type ?? null,
        kind: inferEndpointKind(input.referenceName, tp["source"]),
        details: buildEndpointDetails(
          input.referenceName,
          tp["source"],
          act.linkedServiceName?.referenceName,
        ),
      });
    }

    // Targets from outputs array
    for (const output of act.outputs ?? []) {
      if (!output.referenceName) continue;
      targets.push({
        component_id: act.name ?? null,
        component_type: act.type ?? null,
        kind: inferEndpointKind(output.referenceName, tp["sink"]),
        details: buildEndpointDetails(
          output.referenceName,
          tp["sink"],
          act.linkedServiceName?.referenceName,
        ),
      });
    }

    // ExecutePipeline: treat child pipeline as a "target" (call-out)
    if (act.type === "ExecutePipeline") {
      const ref = (tp["pipeline"] as Record<string, unknown> | undefined)?.[
        "referenceName"
      ];
      if (typeof ref === "string") {
        targets.push({
          component_id: act.name ?? null,
          component_type: "ExecutePipeline",
          kind: "api",
          details: { child_pipeline: ref },
        });
      }
    }
  }

  return { sources, targets };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stringField(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return null;
}

const SQL_SOURCE_SUFFIXES = [
  "SqlSource",
  "SqlSink",
  "AzureSql",
  "MySql",
  "Oracle",
  "Synapse",
  "Warehouse",
];
const FILE_SOURCE_SUFFIXES = [
  "Blob",
  "Adls",
  "Datalake",
  "Lakehouse",
  "Delimited",
  "Parquet",
  "Excel",
  "Json",
  "File",
];

function inferEndpointKind(
  datasetName: string,
  typeProps: unknown,
): "database" | "file" | "api" {
  const typeName =
    ((typeProps as Record<string, unknown> | undefined)?.["type"] as string) ??
    datasetName;
  if (SQL_SOURCE_SUFFIXES.some((s) => typeName.includes(s))) return "database";
  if (FILE_SOURCE_SUFFIXES.some((s) => typeName.includes(s))) return "file";
  return "database"; // safe default for ADF (most sources are databases)
}

function buildEndpointDetails(
  datasetName: string,
  typeProps: unknown,
  linkedService?: string,
): Record<string, string> {
  const details: Record<string, string> = { dataset: datasetName };
  if (linkedService) details["linked_service"] = linkedService;
  const tp = typeProps as Record<string, unknown> | undefined;
  if (tp) {
    const table = stringField(tp, ["tableName", "table"]);
    if (table) details["table"] = table;
    const schema = stringField(tp, ["schema"]);
    if (schema) details["schema"] = schema;
    const folder = stringField(tp, ["folderPath", "fileName"]);
    if (folder) details["path"] = folder;
  }
  return details;
}

function inferDbType(hint?: string): string | null {
  if (!hint) return null;
  if (hint.toLowerCase().includes("sql")) return "Azure SQL";
  if (hint.toLowerCase().includes("synapse")) return "Azure Synapse";
  if (hint.toLowerCase().includes("mysql")) return "MySQL";
  if (hint.toLowerCase().includes("oracle")) return "Oracle";
  if (hint.toLowerCase().includes("snowflake")) return "Snowflake";
  if (hint.toLowerCase().includes("warehouse")) return "Fabric Warehouse";
  if (hint.toLowerCase().includes("lakehouse")) return "Fabric Lakehouse";
  return null;
}
