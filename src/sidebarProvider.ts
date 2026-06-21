/**
 * sidebarProvider.ts
 *
 * Activity Bar panel for PipelineDoc.
 * Shows three collapsible sections:
 *   - Account    : license tier + current provider
 *   - Settings   : quick links to set API keys and open settings
 *   - Recent Documents : last 10 generated markdown files
 */

import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecentDoc {
  label: string; // pipeline name
  filePath: string; // absolute path to the generated .md file
  timestamp: string; // ISO 8601 string
}

const MAX_RECENT = 10;
const RECENT_STORAGE_KEY = "pipelineDoc.recentDocs";

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class PipelineDocSidebarProvider implements vscode.TreeDataProvider<SidebarItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    SidebarItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Force the tree to re-render. */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SidebarItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SidebarItem): SidebarItem[] {
    // Root level — return the three section headers
    if (!element) {
      return [
        SidebarItem.section("account", "Account"),
        SidebarItem.section("settings", "Settings"),
        SidebarItem.section("recent", "Recent Documents"),
      ];
    }

    switch (element.sectionId) {
      case "account":
        return this.buildAccountItems();
      case "settings":
        return this.buildSettingsItems();
      case "recent":
        return this.buildRecentItems();
      default:
        return [];
    }
  }

  // ---- Section builders ---------------------------------------------------

  private buildAccountItems(): SidebarItem[] {
    const cfg = vscode.workspace.getConfiguration("pipelineDoc");
    const provider = cfg.get<string>("aiProvider") ?? "premium";
    const isPremium = provider === "premium";

    return [
      SidebarItem.info(
        isPremium ? "License: Premium ✓" : "License: Freemium (BYOK)",
        isPremium ? "verified" : "account",
      ),
      SidebarItem.info(`Provider: ${provider}`, "server"),
    ];
  }

  private buildSettingsItems(): SidebarItem[] {
    const cfg = vscode.workspace.getConfiguration("pipelineDoc");
    const language = cfg.get<string>("outputLanguage") ?? "english";

    return [
      SidebarItem.info(`Language: ${language}`, "globe"),
      SidebarItem.action(
        "Set OpenAI API Key",
        "pipeline-doc.setOpenAIKey",
        "key",
      ),
      SidebarItem.action(
        "Set Anthropic API Key",
        "pipeline-doc.setAnthropicKey",
        "key",
      ),
      SidebarItem.action(
        "Open Settings",
        "pipeline-doc.openSettings",
        "settings-gear",
      ),
    ];
  }

  private buildRecentItems(): SidebarItem[] {
    const docs = this.getRecentDocs();
    if (docs.length === 0) {
      return [SidebarItem.info("No documents generated yet", "info")];
    }
    return docs.map((d) =>
      SidebarItem.recentDoc(d.label, d.filePath, d.timestamp),
    );
  }

  // ---- Recent docs persistence --------------------------------------------

  getRecentDocs(): RecentDoc[] {
    return this.context.globalState.get<RecentDoc[]>(RECENT_STORAGE_KEY) ?? [];
  }

  async addRecentDoc(doc: RecentDoc): Promise<void> {
    // Remove any existing entry for the same file, then prepend the new one
    const existing = this.getRecentDocs().filter(
      (d) => d.filePath !== doc.filePath,
    );
    existing.unshift(doc);
    await this.context.globalState.update(
      RECENT_STORAGE_KEY,
      existing.slice(0, MAX_RECENT),
    );
    this.refresh();
  }
}

// ---------------------------------------------------------------------------
// Tree item
// ---------------------------------------------------------------------------

export class SidebarItem extends vscode.TreeItem {
  /** Set on section-level items so getChildren can branch correctly. */
  sectionId?: string;

  static section(id: string, label: string): SidebarItem {
    const item = new SidebarItem(
      label,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    item.sectionId = id;
    item.contextValue = "section";
    return item;
  }

  static info(label: string, codicon: string): SidebarItem {
    const item = new SidebarItem(label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(codicon);
    item.contextValue = "info";
    return item;
  }

  static action(
    label: string,
    commandId: string,
    codicon: string,
  ): SidebarItem {
    const item = new SidebarItem(label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(codicon);
    item.command = { command: commandId, title: label };
    item.contextValue = "action";
    return item;
  }

  static recentDoc(
    label: string,
    filePath: string,
    timestamp: string,
  ): SidebarItem {
    const item = new SidebarItem(label, vscode.TreeItemCollapsibleState.None);
    // Show just the date part (e.g. "2026-06-21") as secondary text
    item.description = timestamp.slice(0, 10);
    item.tooltip = new vscode.MarkdownString(`**${label}**\n\n\`${filePath}\``);
    item.iconPath = new vscode.ThemeIcon("file-text");
    item.command = {
      command: "pipeline-doc.openRecentDoc",
      title: "Open Document",
      arguments: [filePath],
    };
    item.contextValue = "recentDoc";
    return item;
  }
}
