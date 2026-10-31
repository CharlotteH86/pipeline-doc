/**
 * batchGenerator.ts
 *
 * Batch Generation — Premium-funktion som genererar dokumentation för
 * samtliga pipeline-filer i en katalog i ett svep, plus ett samlat
 * `README.md`-index.
 *
 * Ansvarar för:
 *  - Adaptiv samtidighetsbegränsning (sänks automatiskt vid 429-fel)
 *  - Felisolering per fil (en trasig pipeline stoppar inte resten av batchen)
 *  - Att spegla källkatalogens struktur i en separat `pipeline-docs/`-mapp
 *  - Att bygga ett deterministiskt index-README (ingen AI inblandad i det steget)
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import type { AiConfig } from "./aiService.js";
import { RateLimitError } from "./aiService.js";
import { parsePipelineFile, renderPipelineMarkdown } from "./pipelineRouter.js";

// ---------------------------------------------------------------------------
// Typer
// ---------------------------------------------------------------------------

export interface BatchSuccessEntry {
  pipelineName: string;
  pipelineType: string;
  sourceFile: string;
  /** Sökväg relativt pipeline-docs-roten, för länkning i README. */
  relativeOutputPath: string;
}

export interface BatchFailureEntry {
  sourceFile: string;
  error: string;
}

export interface BatchSummary {
  succeeded: BatchSuccessEntry[];
  failed: BatchFailureEntry[];
  readmePath: string;
}

export interface RunBatchOptions {
  folderPath: string;
  files: string[];
  config: AiConfig;
  concurrency: number;
  progress: vscode.Progress<{ message?: string; increment?: number }>;
  token: vscode.CancellationToken;
}

const DEFAULT_RATE_LIMIT_BACKOFF_MS = 15_000;

// ---------------------------------------------------------------------------
// Huvudflöde
// ---------------------------------------------------------------------------

export async function runBatchGeneration(
  options: RunBatchOptions,
): Promise<BatchSummary> {
  const { folderPath, files, config, token } = options;
  const outputRoot = path.join(folderPath, "pipeline-docs");
  fs.mkdirSync(outputRoot, { recursive: true });

  const succeeded: BatchSuccessEntry[] = [];
  const failed: BatchFailureEntry[] = [];
  const increment = 100 / files.length;

  let nextIndex = 0;
  let activeSlots = Math.max(1, options.concurrency);

  async function processFile(filePath: string): Promise<void> {
    const relativeDir = path.relative(folderPath, path.dirname(filePath));
    const outDir = path.join(outputRoot, relativeDir);
    const baseName = path.basename(filePath, path.extname(filePath));

    try {
      const jobData = parsePipelineFile(filePath);
      const rendered = await renderWithRateLimitRetry(
        jobData,
        config,
        filePath,
        () => {
          // Sänk taket för resten av batchen istället för att ge upp helt.
          activeSlots = Math.max(1, activeSlots - 2);
        },
      );

      fs.mkdirSync(outDir, { recursive: true });
      const outputPath = path.join(outDir, `${baseName}.md`);
      fs.writeFileSync(outputPath, rendered.markdown, "utf-8");

      succeeded.push({
        pipelineName: rendered.pipelineName,
        pipelineType: jobData.pipeline_type,
        sourceFile: filePath,
        relativeOutputPath: path.relative(outputRoot, outputPath),
      });
    } catch (err) {
      failed.push({ sourceFile: filePath, error: String(err) });
    } finally {
      options.progress.report({
        message: `${succeeded.length + failed.length}/${files.length} pipelines processed`,
        increment,
      });
    }
  }

  async function workerLoop(slot: number): Promise<void> {
    while (true) {
      if (token.isCancellationRequested) return;
      if (slot >= activeSlots) return; // denna worker stängdes ner pga rate-limit
      if (nextIndex >= files.length) return;
      const myIndex = nextIndex++;
      await processFile(files[myIndex]);
    }
  }

  const slotCount = Math.max(1, options.concurrency);
  await Promise.all(
    Array.from({ length: slotCount }, (_, slot) => workerLoop(slot)),
  );

  const readmePath = path.join(outputRoot, "README.md");
  const readme = buildProjectIndexMarkdown({
    folderName: path.basename(folderPath),
    totalFiles: files.length,
    succeeded,
    failed,
    cancelled: token.isCancellationRequested,
  });
  fs.writeFileSync(readmePath, readme, "utf-8");

  return { succeeded, failed, readmePath };
}

// ---------------------------------------------------------------------------
// Rate-limit-medveten rendering (en retry efter Retry-After/backoff)
// ---------------------------------------------------------------------------

async function renderWithRateLimitRetry(
  jobData: Parameters<typeof renderPipelineMarkdown>[0],
  config: AiConfig,
  sourceFilePath: string,
  onRateLimited: () => void,
) {
  try {
    return await renderPipelineMarkdown(jobData, config, sourceFilePath);
  } catch (err) {
    if (!(err instanceof RateLimitError)) throw err;

    onRateLimited();
    const waitMs = err.retryAfterMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS;
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    // En enda retry — om det fortfarande är rate-limitat ger vi upp på
    // just denna fil och markerar den som misslyckad i README:n.
    return await renderPipelineMarkdown(jobData, config, sourceFilePath);
  }
}

// ---------------------------------------------------------------------------
// Index-README (deterministiskt — ingen AI)
// ---------------------------------------------------------------------------

function buildProjectIndexMarkdown(input: {
  folderName: string;
  totalFiles: number;
  succeeded: BatchSuccessEntry[];
  failed: BatchFailureEntry[];
  cancelled: boolean;
}): string {
  const { folderName, totalFiles, succeeded, failed, cancelled } = input;
  const generatedAt = new Date().toISOString();

  const lines: string[] = [
    `# Pipeline Documentation — ${folderName}`,
    "",
    `Generated: ${generatedAt}`,
    `Pipelines processed: ${succeeded.length + failed.length}/${totalFiles}` +
      (cancelled ? " (batch was cancelled before completion)" : ""),
    "",
    "## Index",
    "",
    "| Pipeline | Type | Documentation |",
    "| --- | --- | --- |",
  ];

  for (const entry of succeeded) {
    const link = entry.relativeOutputPath.replace(/\\/g, "/");
    lines.push(`| ${entry.pipelineName} | ${entry.pipelineType} | [${link}](./${link}) |`);
  }

  if (failed.length > 0) {
    lines.push("", "## Failed", "", "| Source file | Error |", "| --- | --- |");
    for (const entry of failed) {
      const safeError = entry.error.replace(/\|/g, "\\|").replace(/\n/g, " ");
      lines.push(`| ${entry.sourceFile} | ${safeError} |`);
    }
  }

  return lines.join("\n") + "\n";
}
