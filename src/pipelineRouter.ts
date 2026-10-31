/**
 * pipelineRouter.ts
 *
 * Delad logik för att upptäcka pipeline-format, parsa en enskild
 * källfil (.item/.json) och rendera dess Markdown-dokumentation.
 *
 * Används både av enstaka-fil-kommandona och av Batch Generation,
 * så att de två flödena aldrig kan divergera i hur en pipeline tolkas.
 */

import * as fs from "fs";
import * as path from "path";

import { parseTalendItem, type PipelineDocument } from "./parser.js";
import { parseAdfPipeline } from "./adfParser.js";
import { generateMermaidDiagram } from "./diagramGenerator.js";
import { generateDocumentation, type AiConfig } from "./aiService.js";

// ---------------------------------------------------------------------------
// Format-detektering (flyttad oförändrad från extension.ts)
// ---------------------------------------------------------------------------

export function detectPipelineFormat(
  json: unknown,
): "adf" | "fabric" | "talend-json" | "unknown" {
  if (!json || typeof json !== "object") return "unknown";
  const obj = json as Record<string, unknown>;

  // ADF standalone: { name, properties: { activities: [...] } }
  // Fabric: identical structure
  const props = obj["properties"] as Record<string, unknown> | undefined;
  if (props && Array.isArray(props["activities"])) {
    // Fabric pipelines often have annotations referencing Fabric, but the
    // structure is identical — we rely on file origin or a "fabric" hint in
    // the schema field if present.
    const schema = (obj["\$schema"] as string | undefined) ?? "";
    return schema.toLowerCase().includes("fabric") ? "fabric" : "adf";
  }

  // ARM template: { resources: [ { type: ".../pipelines" } ] }
  if (Array.isArray(obj["resources"])) {
    const hasPipeline = (
      obj["resources"] as Array<Record<string, unknown>>
    ).some(
      (r) =>
        typeof r["type"] === "string" &&
        r["type"].toLowerCase().endsWith("/pipelines"),
    );
    if (hasPipeline) return "adf";
  }

  // Talend JSON export from parser.py: { job: {...}, components: [...] }
  if (obj["job"] && Array.isArray(obj["components"])) return "talend-json";

  return "unknown";
}

export function parseJsonPipeline(json: unknown): PipelineDocument {
  const format = detectPipelineFormat(json);

  switch (format) {
    case "adf":
    case "fabric":
      return parseAdfPipeline(json, format);
    case "talend-json":
      return json as PipelineDocument;
    default:
      throw new Error(
        "Unrecognised JSON format. Expected an ADF/Fabric pipeline JSON or a Talend JSON export.",
      );
  }
}

/** Läser och parsar en enskild pipeline-källfil baserat på dess filändelse. */
export function parsePipelineFile(filePath: string): PipelineDocument {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".item") {
    const xmlContent = fs.readFileSync(filePath, "utf-8");
    return parseTalendItem(xmlContent);
  }

  if (ext === ".json") {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return parseJsonPipeline(parsed);
  }

  throw new Error(`Filtyp stöds inte: ${ext}`);
}

// ---------------------------------------------------------------------------
// Markdown-rendering (AI-dokumentation + Mermaid-diagram)
// ---------------------------------------------------------------------------

export interface RenderedPipelineDoc {
  pipelineName: string;
  markdown: string;
}

/**
 * Genererar AI-dokumentationen för en redan parsad pipeline och
 * prependar ett deterministiskt Mermaid-arkitekturdiagram.
 *
 * Delad av både enstaka-fil-flödet (generateAndSave) och Batch Generation,
 * så att output-formatet alltid är identiskt oavsett vilken väg man tar.
 */
export async function renderPipelineMarkdown(
  jobData: PipelineDocument,
  config: AiConfig,
  sourceFilePath: string,
): Promise<RenderedPipelineDoc> {
  const markdown = await generateDocumentation(jobData, config);

  const diagram = generateMermaidDiagram(jobData);
  const pipelineName =
    jobData.job.name ??
    path.basename(sourceFilePath, path.extname(sourceFilePath));
  const fullMarkdown = diagram
    ? `# ${pipelineName}\n\n## Architecture Overview\n\n${diagram}\n\n---\n\n${markdown}`
    : markdown;

  return { pipelineName, markdown: fullMarkdown };
}

// ---------------------------------------------------------------------------
// Filupptäckt (för Batch Generation)
// ---------------------------------------------------------------------------

const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "out",
  "dist",
  "pipeline-docs",
]);

/**
 * Söker rekursivt igenom en katalog efter kandidatfiler (.item/.json).
 * Själva format-/parse-valideringen görs per fil vid generering, så att
 * ett ogiltigt JSON-dokument i katalogen inte stoppar hela sökningen.
 */
export function discoverPipelineFiles(rootPath: string): string[] {
  const found: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // otillgänglig katalog (behörighet, symlink-loop etc.) — hoppa över
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIR_NAMES.has(entry.name) && !entry.name.startsWith(".")) {
          walk(path.join(dir, entry.name));
        }
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === ".item" || ext === ".json") {
        found.push(path.join(dir, entry.name));
      }
    }
  }

  walk(rootPath);
  return found;
}

/** Läser aiProvider-inställningen ("premium" använder numera också egen nyckel, se aiService.ts). */
export function hasApiKey(config: AiConfig): boolean {
  if (config.provider === "openai") return Boolean(config.openaiApiKey);
  if (config.provider === "anthropic") return Boolean(config.anthropicApiKey);
  return true;
}
