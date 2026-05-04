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

    this.addSettingTab(new ClaudeForObsidianSettingTab(this.app, this));
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
