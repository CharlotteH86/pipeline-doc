/**
 * extension.ts
 *
 * VS Code-extensionens ingångspunkt.
 *
 * Registrerar två kommandon:
 *  - pipeline-doc.generateFromItem  (högerklick på .item-fil)
 *  - pipeline-doc.generateFromJson  (högerklick på .json-fil från parser.py)
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { type PipelineDocument } from "./parser.js";
import { PipelineDocSidebarProvider } from "./sidebarProvider.js";
import { type AiConfig, type AiProvider } from "./aiService.js";
import {
  discoverPipelineFiles,
  hasApiKey,
  parsePipelineFile,
  renderPipelineMarkdown,
} from "./pipelineRouter.js";
import { runBatchGeneration } from "./batchGenerator.js";

// ---------------------------------------------------------------------------
// Aktivering
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  const sidebar = new PipelineDocSidebarProvider(context);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("pipelineDocView", sidebar),
    vscode.commands.registerCommand(
      "pipeline-doc.generateFromItem",
      (uri?: vscode.Uri) => handleGenerateFromItem(context, sidebar, uri),
    ),
    vscode.commands.registerCommand(
      "pipeline-doc.generateFromJson",
      (uri?: vscode.Uri) => handleGenerateFromJson(context, sidebar, uri),
    ),
    vscode.commands.registerCommand(
      "pipeline-doc.generateBatch",
      (uri?: vscode.Uri) => handleGenerateBatch(context, sidebar, uri),
    ),
    vscode.commands.registerCommand("pipeline-doc.setOpenAIKey", () =>
      setApiKey(context, "openai"),
    ),
    vscode.commands.registerCommand("pipeline-doc.setAnthropicKey", () =>
      setApiKey(context, "anthropic"),
    ),
    vscode.commands.registerCommand("pipeline-doc.refreshSidebar", () =>
      sidebar.refresh(),
    ),
    vscode.commands.registerCommand("pipeline-doc.openSettings", () =>
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "pipelineDoc",
      ),
    ),
    vscode.commands.registerCommand(
      "pipeline-doc.openRecentDoc",
      async (filePath: string) => {
        if (!filePath) return;
        await vscode.commands.executeCommand(
          "markdown.showPreview",
          vscode.Uri.file(filePath),
        );
      },
    ),
  );

  // Show a one-time privacy notice so users know pipeline data is sent to AI APIs
  showPrivacyNoticeOnce(context);
}

export function deactivate(): void {}

// ---------------------------------------------------------------------------
// Privacy notice (shown once per install)
// ---------------------------------------------------------------------------

const PRIVACY_NOTICE_KEY = "pipelineDoc.privacyNoticeAccepted";

async function showPrivacyNoticeOnce(
  context: vscode.ExtensionContext,
): Promise<void> {
  const accepted = context.globalState.get<boolean>(PRIVACY_NOTICE_KEY);
  if (accepted) return;

  const choice = await vscode.window.showInformationMessage(
    "PipelineDoc sends pipeline content (including SQL queries and dataset names) " +
      "to your chosen AI provider (OpenAI or Anthropic) to generate documentation. " +
      "Do not use PipelineDoc with files containing secrets or passwords you cannot share with your AI provider.",
    { modal: true },
    "I understand — continue",
    "Open Privacy info",
  );

  if (choice === "Open Privacy info") {
    await vscode.env.openExternal(
      vscode.Uri.parse(
        "https://github.com/CharlotteH86/pipeline-doc#privacy--security",
      ),
    );
    // Ask again after they've read the info
    const confirm = await vscode.window.showInformationMessage(
      "Ready to continue with PipelineDoc?",
      { modal: true },
      "Yes, I understand",
    );
    if (confirm !== "Yes, I understand") return;
  } else if (choice !== "I understand — continue") {
    // User dismissed — ask again next time
    return;
  }

  await context.globalState.update(PRIVACY_NOTICE_KEY, true);
}

// ---------------------------------------------------------------------------
// Kommando: generera från .item-fil
// ---------------------------------------------------------------------------

async function handleGenerateFromItem(
  context: vscode.ExtensionContext,
  sidebar: PipelineDocSidebarProvider,
  uri?: vscode.Uri,
): Promise<void> {
  const filePath = await resolveFilePath(uri, {
    filters: { "Talend Item Files": ["item"] },
    title: "Select Talend/ADF pipeline file",
  });
  if (!filePath) return;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "PipelineDoc",
      cancellable: false,
    },
    async (progress) => {
      try {
        progress.report({ message: "Reading .item file..." });
        const jobData = parsePipelineFile(filePath);

        await generateAndSave(context, sidebar, jobData, filePath, progress);
      } catch (err) {
        vscode.window.showErrorMessage(`PipelineDoc: ${String(err)}`);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Kommando: generera från JSON-fil (output från parser.py)
// ---------------------------------------------------------------------------

async function handleGenerateFromJson(
  context: vscode.ExtensionContext,
  sidebar: PipelineDocSidebarProvider,
  uri?: vscode.Uri,
): Promise<void> {
  const filePath = await resolveFilePath(uri, {
    filters: { "JSON Files": ["json"] },
    title: "Select pipeline JSON file",
  });
  if (!filePath) return;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "PipelineDoc",
      cancellable: false,
    },
    async (progress) => {
      try {
        progress.report({ message: "Reading JSON file..." });
        const jobData = parsePipelineFile(filePath);

        await generateAndSave(context, sidebar, jobData, filePath, progress);
      } catch (err) {
        vscode.window.showErrorMessage(`PipelineDoc: ${String(err)}`);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Gemensam logik: generera + spara + öppna
// ---------------------------------------------------------------------------

async function generateAndSave(
  context: vscode.ExtensionContext,
  sidebar: PipelineDocSidebarProvider,
  jobData: PipelineDocument,
  sourceFilePath: string,
  progress: vscode.Progress<{ message?: string }>,
): Promise<void> {
  progress.report({ message: "Loading AI configuration..." });
  const config = await getAiConfig(context);

  // Om ingen nyckel finns – be användaren ange den direkt (sparas krypterat)
  if (config.provider !== "premium" && !hasApiKey(config)) {
    const key = await promptForApiKey(
      context,
      config.provider as "openai" | "anthropic",
    );
    if (!key) return;
    if (config.provider === "openai") config.openaiApiKey = key;
    else config.anthropicApiKey = key;
  }

  progress.report({
    message: `Generating documentation via ${config.provider}...`,
  });
  const { pipelineName, markdown: fullMarkdown } = await renderPipelineMarkdown(
    jobData,
    config,
    sourceFilePath,
  );

  // Build a timestamped filename so previous docs are never overwritten.
  // Format: {sourceBaseName}_doc_YYYY-MM-DD_HH-mm-ss.md
  const timestamp = new Date()
    .toISOString()
    .replace("T", "_")
    .replace(/:/g, "-")
    .slice(0, 19); // "2026-06-18_14-30-00"
  const sourceBaseName = path.basename(
    sourceFilePath,
    path.extname(sourceFilePath),
  );
  const outputFileName = `${sourceBaseName}_doc_${timestamp}.md`;
  const outputPath = path.join(path.dirname(sourceFilePath), outputFileName);

  fs.writeFileSync(outputPath, fullMarkdown, "utf-8");

  // Open the rendered Markdown preview directly so the Mermaid diagram is visible immediately
  await vscode.commands.executeCommand(
    "markdown.showPreview",
    vscode.Uri.file(outputPath),
  );

  // Add to Recent Documents in the sidebar
  await sidebar.addRecentDoc({
    label: pipelineName,
    filePath: outputPath,
    timestamp: new Date().toISOString(),
  });

  vscode.window.showInformationMessage(
    `PipelineDoc: Documentation saved → ${outputFileName}`,
  );
}

// ---------------------------------------------------------------------------
// Hjälpfunktioner
// ---------------------------------------------------------------------------

async function getAiConfig(
  context: vscode.ExtensionContext,
): Promise<AiConfig> {
  const cfg = vscode.workspace.getConfiguration("pipelineDoc");

  return {
    provider: (cfg.get<string>("aiProvider") ?? "premium") as AiProvider,
    openaiApiKey:
      (await context.secrets.get("pipelineDoc.openaiApiKey")) ?? undefined,
    anthropicApiKey:
      (await context.secrets.get("pipelineDoc.anthropicApiKey")) ?? undefined,
    openaiModel: cfg.get<string>("openaiModel") || undefined,
    anthropicModel: cfg.get<string>("anthropicModel") || undefined,
    outputLanguage: cfg.get<string>("outputLanguage") ?? "english",
    // Fas 3: hämtas från licens-flödet, hardcodat tillsvidare
    premiumApiUrl: "https://your-app.vercel.app/api/generate",
  };
}

async function resolveFilePath(
  uri: vscode.Uri | undefined,
  dialogOptions: { filters: Record<string, string[]>; title: string },
): Promise<string | null> {
  // Högerklick i Explorer ger oss en URI direkt
  if (uri?.fsPath) return uri.fsPath;

  // Annars: öppna filväljare
  const result = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Välj fil",
    filters: dialogOptions.filters,
    title: dialogOptions.title,
  });

  return result?.[0]?.fsPath ?? null;
}

// ---------------------------------------------------------------------------
// Kommando: Batch Generation (högerklick på katalog) — Premium-funktion
// ---------------------------------------------------------------------------

const LARGE_BATCH_WARNING_THRESHOLD = 10;

function isPremiumTier(): boolean {
  const cfg = vscode.workspace.getConfiguration("pipelineDoc");
  // TODO: ersätt med riktig licensvalidering. Lokal flagga tillsvidare —
  // Premium-funktioner kräver fortfarande användarens egen API-nyckel,
  // det finns ingen AI-proxybackend att validera mot.
  return (cfg.get<string>("tier") ?? "free") === "premium";
}

async function handleGenerateBatch(
  context: vscode.ExtensionContext,
  sidebar: PipelineDocSidebarProvider,
  uri?: vscode.Uri,
): Promise<void> {
  if (!isPremiumTier()) {
    const choice = await vscode.window.showWarningMessage(
      "Batch Generation is a Premium feature. Set 'pipelineDoc.tier' to \"premium\" in Settings to enable it.",
      "Open Settings",
    );
    if (choice === "Open Settings") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "pipelineDoc.tier",
      );
    }
    return;
  }

  let folderPath = uri?.fsPath;
  if (!folderPath) {
    const result = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Select folder",
      title: "Select a folder containing pipeline files",
    });
    folderPath = result?.[0]?.fsPath;
  }
  if (!folderPath) return;

  const files = discoverPipelineFiles(folderPath);
  if (files.length === 0) {
    vscode.window.showInformationMessage(
      "PipelineDoc: No .item or .json pipeline files found in this folder.",
    );
    return;
  }

  const config = await getAiConfig(context);
  if (config.provider !== "premium" && !hasApiKey(config)) {
    const key = await promptForApiKey(
      context,
      config.provider as "openai" | "anthropic",
    );
    if (!key) return;
    if (config.provider === "openai") config.openaiApiKey = key;
    else config.anthropicApiKey = key;
  }

  if (files.length > LARGE_BATCH_WARNING_THRESHOLD) {
    const confirm = await vscode.window.showWarningMessage(
      `This will generate documentation for ${files.length} pipelines using your ${config.provider} API key. ` +
        "Depending on your account's rate limits this may take several minutes and will incur API usage costs. Continue?",
      { modal: true },
      "Continue",
    );
    if (confirm !== "Continue") return;
  }

  const cfg = vscode.workspace.getConfiguration("pipelineDoc");
  const concurrency = cfg.get<number>("batchConcurrency") ?? 5;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "PipelineDoc: Batch Generation",
      cancellable: true,
    },
    async (progress, token) => {
      const summary = await runBatchGeneration({
        folderPath: folderPath!,
        files,
        config,
        concurrency,
        progress,
        token,
      });

      if (token.isCancellationRequested) {
        vscode.window.showInformationMessage(
          `PipelineDoc: Batch cancelled after ${summary.succeeded.length + summary.failed.length}/${files.length} pipelines.`,
        );
        return;
      }

      await vscode.commands.executeCommand(
        "markdown.showPreview",
        vscode.Uri.file(summary.readmePath),
      );

      await sidebar.addRecentDoc({
        label: `${path.basename(folderPath!)} (batch — ${summary.succeeded.length}/${files.length})`,
        filePath: summary.readmePath,
        timestamp: new Date().toISOString(),
      });

      const failedCount = summary.failed.length;
      vscode.window.showInformationMessage(
        failedCount === 0
          ? `PipelineDoc: Batch complete — ${summary.succeeded.length}/${files.length} pipelines documented.`
          : `PipelineDoc: Batch complete — ${summary.succeeded.length}/${files.length} succeeded, ${failedCount} failed. See README for details.`,
      );
    },
  );
}

// ---------------------------------------------------------------------------
// API-nyckel hantering (SecretStorage)
// ---------------------------------------------------------------------------

async function setApiKey(
  context: vscode.ExtensionContext,
  provider: "openai" | "anthropic",
): Promise<void> {
  const label = provider === "openai" ? "OpenAI" : "Anthropic";
  const key = await vscode.window.showInputBox({
    title: `PipelineDoc: Enter ${label} API key`,
    prompt: `Paste your ${label} API key (stored securely via the system keychain).`,
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) return;
  if (key === "") {
    await context.secrets.delete(`pipelineDoc.${provider}ApiKey`);
    vscode.window.showInformationMessage(
      `PipelineDoc: ${label} API key removed.`,
    );
  } else {
    await context.secrets.store(`pipelineDoc.${provider}ApiKey`, key);
    vscode.window.showInformationMessage(
      `PipelineDoc: ${label} API key saved securely.`,
    );
  }
}

async function promptForApiKey(
  context: vscode.ExtensionContext,
  provider: "openai" | "anthropic",
): Promise<string | null> {
  const label = provider === "openai" ? "OpenAI" : "Anthropic";
  const key = await vscode.window.showInputBox({
    title: `PipelineDoc: Enter ${label} API key`,
    prompt: `No ${label} API key found. Enter your key – stored securely and only asked once.`,
    password: true,
    ignoreFocusOut: true,
  });
  if (!key) return null;
  await context.secrets.store(`pipelineDoc.${provider}ApiKey`, key);
  return key;
}
