/**
 * diagramGenerator.ts
 *
 * Generates a deterministic Mermaid flowchart from a PipelineDocument.
 * No AI involved — always produces valid Mermaid syntax.
 *
 * Node shapes:
 *   [("label")]  — cylinder  — database / data warehouse
 *   [/"label"/]  — parallelogram — file / blob / lakehouse
 *   {{"label"}}  — hexagon   — child pipeline (ExecutePipeline)
 *   ["label"]    — rectangle — activity / component
 */

import type { PipelineDocument } from "./parser.js";

// Diagrams with more nodes than this become unreadable — show a fallback note.
const MAX_NODES = 40;

// Connection type labels that add no value in the diagram.
const TRIVIAL_CONNECTION_TYPES = new Set([
  "Succeeded",
  "SUBJOB_OK",
  "MAIN",
  "ITERATE",
  "Completed",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a complete Mermaid fenced code block (```mermaid … ```) ready to
 * embed in a Markdown document.
 */
export function generateMermaidDiagram(doc: PipelineDocument): string {
  const totalNodes =
    doc.sources.length + doc.components.length + doc.targets.length;

  if (totalNodes === 0) {
    return ""; // Nothing to draw
  }

  if (totalNodes > MAX_NODES) {
    return (
      "```mermaid\n" +
      `flowchart LR\n` +
      `  note["Pipeline has ${doc.components.length} activities — too large to diagram.\\nSee the Data Flow section for details."]\n` +
      "```"
    );
  }

  const lines: string[] = ["flowchart LR"];
  const definedIds = new Set<string>();
  const addedEdges = new Set<string>();

  // ---- helpers ----

  function def(id: string, shapeLine: string): void {
    if (!definedIds.has(id)) {
      lines.push(shapeLine);
      definedIds.add(id);
    }
  }

  function edge(from: string, to: string, label?: string): void {
    if (!from || !to) return;
    const key = `${from}→${to}`;
    if (addedEdges.has(key)) return;
    addedEdges.add(key);
    const arrow = label ? `-- "${label}" -->` : "-->";
    lines.push(`  ${from} ${arrow} ${to}`);
  }

  // ---- build the set of component IDs for quick lookup ----

  const componentIdSet = new Set(
    doc.components
      .map((c) => c.component_id ?? c.component_name ?? "")
      .filter(Boolean),
  );

  // ---- source nodes ----

  const sourceNodeMap = new Map<string, string>(); // component_id → node id

  for (const src of doc.sources) {
    const rawLabel =
      src.details["dataset"] ??
      src.details["linked_service"] ??
      src.details["file_path"] ??
      "Source";
    const nodeId = sid(`src_${rawLabel}`);
    const label = trunc(rawLabel);
    const shape = src.kind === "file" ? `[/"${label}"/]` : `[("${label}")]`;
    def(nodeId, `  ${nodeId}${shape}`);
    if (src.component_id) sourceNodeMap.set(src.component_id, nodeId);
  }

  // ---- activity / component nodes ----

  for (const comp of doc.components) {
    const rawId = comp.component_id ?? comp.component_name ?? "unknown";
    const nodeId = sid(rawId);
    const name = trunc(comp.component_name ?? rawId, 22);
    const type = comp.component_type ? trunc(comp.component_type, 18) : "";
    const label = type ? `${name}\\n[${type}]` : name;
    def(nodeId, `  ${nodeId}["${label}"]`);
  }

  // ---- target nodes ----

  const targetNodeMap = new Map<string, string>(); // component_id → node id

  for (const tgt of doc.targets) {
    const rawLabel =
      tgt.details["dataset"] ??
      tgt.details["linked_service"] ??
      tgt.details["child_pipeline"] ??
      tgt.details["file_path"] ??
      "Target";
    const nodeId = sid(`tgt_${rawLabel}`);
    const label = trunc(rawLabel);

    let shape: string;
    if (tgt.component_type === "ExecutePipeline") {
      shape = `{{"${label}"}}`;
    } else if (tgt.kind === "file") {
      shape = `[/"${label}"/]`;
    } else {
      shape = `[("${label}")]`;
    }
    def(nodeId, `  ${nodeId}${shape}`);
    if (tgt.component_id) targetNodeMap.set(tgt.component_id, nodeId);
  }

  // ---- edges: component → component (from connections array) ----

  for (const conn of doc.connections) {
    if (!conn.source || !conn.target) continue;
    const fromId = sid(conn.source);
    const toId = sid(conn.target);
    if (!definedIds.has(fromId) || !definedIds.has(toId)) continue;
    const label =
      conn.connection_type &&
      !TRIVIAL_CONNECTION_TYPES.has(conn.connection_type)
        ? conn.connection_type
        : undefined;
    edge(fromId, toId, label);
  }

  // ---- edges: source node → its activity ----

  for (const [compId, srcNodeId] of sourceNodeMap) {
    if (componentIdSet.has(compId)) {
      edge(srcNodeId, sid(compId));
    }
  }

  // ---- edges: activity → target node ----

  for (const [compId, tgtNodeId] of targetNodeMap) {
    if (componentIdSet.has(compId)) {
      edge(sid(compId), tgtNodeId);
    }
  }

  return "```mermaid\n" + lines.join("\n") + "\n```";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sanitize a string to a valid Mermaid node ID (alphanumeric + underscore). */
function sid(name: string): string {
  const s = name.replace(/[^a-zA-Z0-9_]/g, "_");
  return /^\d/.test(s) ? `_${s}` : s;
}

/** Truncate a label so nodes stay readable. */
function trunc(label: string, max = 26): string {
  return label.length > max ? label.slice(0, max - 1) + "…" : label;
}
