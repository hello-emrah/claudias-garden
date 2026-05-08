import { Plugin, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS, ClaudeForObsidianSettings, ClaudeForObsidianSettingTab } from "./settings";
import { CLAUDE_FOR_OBSIDIAN_VIEW, ClaudeForObsidianView } from "./view";

export default class ClaudeForObsidianPlugin extends Plugin {
  settings!: ClaudeForObsidianSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(CLAUDE_FOR_OBSIDIAN_VIEW, (leaf: WorkspaceLeaf) => new ClaudeForObsidianView(leaf, this));

    this.addRibbonIcon("bot", "Open Claude for Obsidian", () => this.activateView());

    this.addCommand({
      id: "open-claude-for-obsidian",
      name: "Open Claude for Obsidian panel",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "claude-for-obsidian-new-chat",
      name: "New chat",
      callback: () => this.withView((v) => v.newChat()),
    });

    this.addCommand({
      id: "claude-for-obsidian-delete-current-chat",
      name: "Delete current chat",
      callback: () => this.withView((v) => v.deleteCurrentChat()),
    });

    this.addSettingTab(new ClaudeForObsidianSettingTab(this.app, this));
  }

  private withView(fn: (view: ClaudeForObsidianView) => void): void {
    const leaves = this.app.workspace.getLeavesOfType(CLAUDE_FOR_OBSIDIAN_VIEW);
    if (leaves.length === 0) {
      this.activateView().then(() => {
        const after = this.app.workspace.getLeavesOfType(CLAUDE_FOR_OBSIDIAN_VIEW);
        if (after.length > 0 && after[0].view instanceof ClaudeForObsidianView) {
          fn(after[0].view as ClaudeForObsidianView);
        }
      });
      return;
    }
    if (leaves[0].view instanceof ClaudeForObsidianView) {
      fn(leaves[0].view as ClaudeForObsidianView);
    }
  }

  async onunload(): Promise<void> {
    // Leaves are cleaned up by Obsidian on unload.
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(CLAUDE_FOR_OBSIDIAN_VIEW);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: CLAUDE_FOR_OBSIDIAN_VIEW, active: true });
    workspace.revealLeaf(leaf);
  }
}
