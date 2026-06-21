/**
 * parser.ts
 *
 * TypeScript-port av parser.py — läser Talend .item-filer (XML)
 * och returnerar ett strukturerat JSON-objekt.
 *
 * Använder `fast-xml-parser` (npm) istället för Pythons
 * xml.etree.ElementTree, men logiken är identisk.
 */

import { XMLParser } from "fast-xml-parser";

// ---------------------------------------------------------------------------
// Typer — speglar dataklasserna i parser.py
// ---------------------------------------------------------------------------

export interface JobMetadata {
  name: string | null;
  version: string | null;
  description: string | null;
  author: string | null;
  created_date: string | null;
  modified_date: string | null;
  purpose: string | null;
  status: string | null;
}

export interface Component {
  component_id: string | null;
  component_name: string | null;
  component_type: string | null;
  position: { x: number; y: number } | null;
  parameters: Record<string, string>;
}

export interface Connection {
  source: string | null;
  target: string | null;
  connection_type: string | null;
  label: string | null;
}

export interface SqlInfo {
  component_id: string | null;
  component_type: string | null;
  query: string | null;
  table_name: string | null;
  database_type: string | null;
}

export interface ApiInfo {
  component_id: string | null;
  component_type: string | null;
  endpoint: string | null;
  http_method: string | null;
  headers: Record<string, string>;
}

export interface DataEndpoint {
  component_id: string | null;
  component_type: string | null;
  kind: "database" | "file" | "api";
  details: Record<string, string>;
}

export interface PipelineDocument {
  pipeline_type: "talend" | "adf" | "fabric";
  job: JobMetadata;
  components: Component[];
  connections: Connection[];
  sql: SqlInfo[];
  apis: ApiInfo[];
  sources: DataEndpoint[];
  targets: DataEndpoint[];
}

// ---------------------------------------------------------------------------
// Konfiguration — identisk med parser.py
// ---------------------------------------------------------------------------

const DATABASE_INPUT = new Set([
  "tMysqlInput",
  "tOracleInput",
  "tPostgresqlInput",
  "tMSSqlInput",
  "tDBInput",
  "tSnowflakeInput",
  "tRedshiftInput",
  "tTeradataInput",
]);

const DATABASE_OUTPUT = new Set([
  "tMysqlOutput",
  "tOracleOutput",
  "tPostgresqlOutput",
  "tMSSqlOutput",
  "tDBOutput",
  "tSnowflakeOutput",
  "tRedshiftOutput",
  "tTeradataOutput",
]);

const FILE_INPUT = new Set([
  "tFileInputDelimited",
  "tFileInputExcel",
  "tFileInputJSON",
  "tFileInputXML",
  "tFileInputParquet",
  "tFileInputAvro",
]);

const FILE_OUTPUT = new Set([
  "tFileOutputDelimited",
  "tFileOutputExcel",
  "tFileOutputJSON",
  "tFileOutputXML",
  "tFileOutputParquet",
  "tFileOutputAvro",
  "tFileOutputRaw",
]);

const API_COMPONENTS = new Set([
  "tRESTClient",
  "tHttpRequest",
  "tWebServiceInput",
  "tSoap",
]);

const DB_TYPE_BY_PREFIX: Record<string, string> = {
  tMysql: "MySQL",
  tOracle: "Oracle",
  tPostgresql: "PostgreSQL",
  tMSSql: "SQL Server",
  tSnowflake: "Snowflake",
  tRedshift: "Redshift",
  tTeradata: "Teradata",
  tDB: "Generic JDBC",
};

const SQL_PARAM_NAMES = new Set(["QUERY", "SQL_QUERY", "QUERY_TEXT"]);
const TABLE_PARAM_NAMES = new Set(["TABLE", "TABLE_NAME"]);
const API_URL_PARAM_NAMES = new Set(["URL", "HTTP_HOST", "URI", "ENDPOINT"]);
const API_METHOD_PARAM_NAMES = new Set(["HTTP_METHOD", "METHOD"]);
const FILE_PATH_PARAM_NAMES = new Set(["FILENAME", "FILE_NAME", "FILEPATH"]);

// ---------------------------------------------------------------------------
// Hjälpfunktioner
// ---------------------------------------------------------------------------

function cleanValue(value: string | undefined | null): string | null {
  if (value == null) return null;
  let v = value.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    v = v.slice(1, -1);
  }
  return v.replace(/\\"/g, '"');
}

function detectDbType(componentType: string | null): string | null {
  if (!componentType) return null;
  for (const [prefix, dbType] of Object.entries(DB_TYPE_BY_PREFIX)) {
    if (componentType.startsWith(prefix)) return dbType;
  }
  return null;
}

function detectFileFormat(componentType: string | null): string | null {
  if (!componentType) return null;
  const suffixes = [
    "Delimited",
    "Excel",
    "JSON",
    "XML",
    "FullRow",
    "Positional",
    "Parquet",
    "Avro",
    "Raw",
  ];
  return suffixes.find((s) => componentType.endsWith(s)) ?? null;
}

function firstOf(
  keys: string[],
  ...sources: Array<Record<string, string | undefined>>
): string | null {
  for (const source of sources) {
    for (const key of keys) {
      const val = source[key];
      if (val != null && val !== "") return val;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// XML-traversering
// ---------------------------------------------------------------------------

/**
 * Rekursivt platta ut alla noder med ett visst taggnamn ur ett parsat
 * XML-objekt (fast-xml-parser returnerar nästlade plain objects).
 */
function findAll(obj: unknown, tagName: string): unknown[] {
  const results: unknown[] = [];

  function walk(node: unknown): void {
    if (node == null || typeof node !== "object") return;

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      // fast-xml-parser prefixar attribut med "@_"
      if (key === tagName) {
        if (Array.isArray(value)) results.push(...value);
        else results.push(value);
      }
      walk(value);
    }
  }

  walk(obj);
  return results;
}

/**
 * Extraherar elementParameter-poster (name→value) från en XML-nod.
 * fast-xml-parser ger oss attribut som "@_name", "@_value".
 */
function extractParameters(node: unknown): Record<string, string> {
  const params: Record<string, string> = {};
  const paramNodes = findAll(node, "elementParameter");

  for (const p of paramNodes) {
    if (p == null || typeof p !== "object" || Array.isArray(p)) continue;
    const rec = p as Record<string, unknown>;
    const name = rec["@_name"];
    const value = rec["@_value"];
    if (typeof name === "string" && typeof value === "string") {
      params[name] = value;
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// Extraktorer
// ---------------------------------------------------------------------------

function extractJobMetadata(
  root: Record<string, unknown>,
  rootAttribs: Record<string, string>,
): JobMetadata {
  // Hitta <property>-elementet
  const propertyNodes = findAll(root, "property");
  const propAttribs: Record<string, string> = {};
  if (propertyNodes.length > 0) {
    const p = propertyNodes[0] as Record<string, unknown>;
    for (const [k, v] of Object.entries(p)) {
      if (k.startsWith("@_") && typeof v === "string") {
        propAttribs[k.slice(2)] = v;
      }
    }
  }

  return {
    name: firstOf(["label", "name"], propAttribs, rootAttribs),
    version: firstOf(["version"], propAttribs, rootAttribs),
    description: firstOf(["description", "comment"], propAttribs, rootAttribs),
    author: firstOf(["author"], propAttribs, rootAttribs),
    created_date: firstOf(["creationDate"], propAttribs, rootAttribs),
    modified_date: firstOf(["modificationDate"], propAttribs, rootAttribs),
    purpose: firstOf(["purpose"], propAttribs, rootAttribs),
    status: firstOf(["status", "statusCode"], propAttribs, rootAttribs),
  };
}

function extractComponents(root: Record<string, unknown>): Component[] {
  const nodeList = findAll(root, "node");
  const components: Component[] = [];

  for (const n of nodeList) {
    if (n == null || typeof n !== "object") continue;
    const rec = n as Record<string, unknown>;

    const componentType =
      (rec["@_componentName"] as string | undefined) ?? null;
    const posX = rec["@_posX"];
    const posY = rec["@_posY"];

    const params = extractParameters(n);
    const componentId = params["UNIQUE_NAME"] ?? null;

    let position: { x: number; y: number } | null = null;
    if (posX != null && posY != null) {
      const x = Number(posX),
        y = Number(posY);
      if (!isNaN(x) && !isNaN(y)) position = { x, y };
    }

    components.push({
      component_id: componentId,
      component_name: componentId ?? componentType,
      component_type: componentType,
      position,
      parameters: params,
    });
  }
  return components;
}

function extractConnections(root: Record<string, unknown>): Connection[] {
  const connList = findAll(root, "connection");
  return connList
    .filter((c) => c != null && typeof c === "object")
    .map((c) => {
      const rec = c as Record<string, unknown>;
      return {
        source: (rec["@_source"] as string) ?? null,
        target: (rec["@_target"] as string) ?? null,
        connection_type:
          (rec["@_connectorName"] as string) ??
          (rec["@_lineStyle"] as string) ??
          null,
        label: (rec["@_label"] as string) ?? null,
      };
    });
}

function extractSqlInfo(components: Component[]): SqlInfo[] {
  return components.flatMap((comp) => {
    const params = comp.parameters;
    const query =
      [...SQL_PARAM_NAMES].map((k) => params[k]).find((v) => v != null) ?? null;
    const table =
      [...TABLE_PARAM_NAMES].map((k) => params[k]).find((v) => v != null) ??
      null;
    if (!query && !table) return [];
    return [
      {
        component_id: comp.component_id,
        component_type: comp.component_type,
        query: cleanValue(query),
        table_name: cleanValue(table),
        database_type: detectDbType(comp.component_type),
      },
    ];
  });
}

function extractHttpHeaders(
  params: Record<string, string>,
): Record<string, string> {
  const indexed: Record<string, Record<string, string>> = {};
  const pattern = /^HEADER\[(\d+)\]\.HEADER_(KEY|VALUE)$/i;

  for (const [paramName, paramValue] of Object.entries(params)) {
    const match = paramName.match(pattern);
    if (!match) continue;
    const [, index, role] = match;
    if (!indexed[index]) indexed[index] = {};
    indexed[index][role.toUpperCase()] = paramValue;
  }

  const headers: Record<string, string> = {};
  for (const entry of Object.values(indexed)) {
    const key = cleanValue(entry["KEY"]);
    const value = cleanValue(entry["VALUE"]);
    if (key) headers[key] = value ?? "";
  }
  return headers;
}

function extractApiInfo(components: Component[]): ApiInfo[] {
  return components
    .filter((c) => API_COMPONENTS.has(c.component_type ?? ""))
    .map((comp) => {
      const params = comp.parameters;
      const endpoint =
        [...API_URL_PARAM_NAMES].map((k) => params[k]).find((v) => v) ?? null;
      const method =
        [...API_METHOD_PARAM_NAMES].map((k) => params[k]).find((v) => v) ??
        null;
      return {
        component_id: comp.component_id,
        component_type: comp.component_type,
        endpoint: cleanValue(endpoint),
        http_method: cleanValue(method),
        headers: extractHttpHeaders(params),
      };
    });
}

function extractSourcesAndTargets(components: Component[]): {
  sources: DataEndpoint[];
  targets: DataEndpoint[];
} {
  const sources: DataEndpoint[] = [];
  const targets: DataEndpoint[] = [];

  for (const comp of components) {
    const ctype = comp.component_type ?? "";
    const params = comp.parameters;

    if (DATABASE_INPUT.has(ctype)) {
      const table = [...TABLE_PARAM_NAMES].map((k) => params[k]).find((v) => v);
      sources.push({
        component_id: comp.component_id,
        component_type: comp.component_type,
        kind: "database",
        details: Object.fromEntries(
          Object.entries({
            table: cleanValue(table ?? null),
            database_type: detectDbType(ctype),
            host: cleanValue(params["HOST"] ?? null),
            database: cleanValue(
              params["DBNAME"] ?? params["DATABASE"] ?? null,
            ),
          }).filter(([, v]) => v != null) as [string, string][],
        ),
      });
    } else if (DATABASE_OUTPUT.has(ctype)) {
      const table = [...TABLE_PARAM_NAMES].map((k) => params[k]).find((v) => v);
      targets.push({
        component_id: comp.component_id,
        component_type: comp.component_type,
        kind: "database",
        details: Object.fromEntries(
          Object.entries({
            table: cleanValue(table ?? null),
            database_type: detectDbType(ctype),
            host: cleanValue(params["HOST"] ?? null),
            database: cleanValue(
              params["DBNAME"] ?? params["DATABASE"] ?? null,
            ),
          }).filter(([, v]) => v != null) as [string, string][],
        ),
      });
    } else if (FILE_INPUT.has(ctype)) {
      const filePath = [...FILE_PATH_PARAM_NAMES]
        .map((k) => params[k])
        .find((v) => v);
      sources.push({
        component_id: comp.component_id,
        component_type: comp.component_type,
        kind: "file",
        details: Object.fromEntries(
          Object.entries({
            file_path: cleanValue(filePath ?? null),
            format: detectFileFormat(ctype),
          }).filter(([, v]) => v != null) as [string, string][],
        ),
      });
    } else if (FILE_OUTPUT.has(ctype)) {
      const filePath = [...FILE_PATH_PARAM_NAMES]
        .map((k) => params[k])
        .find((v) => v);
      targets.push({
        component_id: comp.component_id,
        component_type: comp.component_type,
        kind: "file",
        details: Object.fromEntries(
          Object.entries({
            file_path: cleanValue(filePath ?? null),
            format: detectFileFormat(ctype),
          }).filter(([, v]) => v != null) as [string, string][],
        ),
      });
    } else if (API_COMPONENTS.has(ctype)) {
      const endpoint = [...API_URL_PARAM_NAMES]
        .map((k) => params[k])
        .find((v) => v);
      const method = [...API_METHOD_PARAM_NAMES]
        .map((k) => params[k])
        .find((v) => v);
      sources.push({
        component_id: comp.component_id,
        component_type: comp.component_type,
        kind: "api",
        details: Object.fromEntries(
          Object.entries({
            endpoint: cleanValue(endpoint ?? null),
            http_method: cleanValue(method ?? null),
          }).filter(([, v]) => v != null) as [string, string][],
        ),
      });
    }
  }

  return { sources, targets };
}

// ---------------------------------------------------------------------------
// Huvudfunktion
// ---------------------------------------------------------------------------

/**
 * Parsar XML-innehållet i en Talend .item-fil och returnerar
 * ett strukturerat TalendJobDocument-objekt.
 *
 * @param xmlContent - Rå XML-sträng från .item-filen
 * @returns Strukturerad jobb-data redo att skickas till AI-API
 */
export function parseTalendItem(xmlContent: string): PipelineDocument {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (tagName) =>
      [
        "node",
        "connection",
        "elementParameter",
        "elementValue",
        "property",
      ].includes(tagName),
    removeNSPrefix: true,
  });

  const parsed = parser.parse(xmlContent) as Record<string, unknown>;

  // Hitta root-elementet (ProcessType eller liknande, oavsett namespace)
  const rootKey = Object.keys(parsed).find((k) => k !== "?xml") ?? "";
  const root = (parsed[rootKey] ?? {}) as Record<string, unknown>;

  // Root-attribut (metadata som sitter direkt på root-elementet)
  const rootAttribs: Record<string, string> = {};
  for (const [k, v] of Object.entries(root)) {
    if (k.startsWith("@_") && typeof v === "string") {
      rootAttribs[k.slice(2)] = v;
    }
  }

  const components = extractComponents(root);
  const { sources, targets } = extractSourcesAndTargets(components);

  return {
    pipeline_type: "talend",
    job: extractJobMetadata(root, rootAttribs),
    components,
    connections: extractConnections(root),
    sql: extractSqlInfo(components),
    apis: extractApiInfo(components),
    sources,
    targets,
  };
}
