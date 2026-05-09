import { Plugin, WorkspaceLeaf, Notice } from "obsidian";
import { execSync } from "child_process";
import * as fs from "fs";
import { DEFAULT_SETTINGS, ClaudeForObsidianSettings, ClaudeForObsidianSettingTab } from "./settings";
import { CLAUDE_FOR_OBSIDIAN_VIEW, ClaudeForObsidianView } from "./view";

const COMMON_CLAUDE_PATHS = [
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
  `${process.env.HOME ?? ""}/.npm-global/bin/claude`,
  `${process.env.HOME ?? ""}/.volta/bin/claude`,
  `${process.env.HOME ?? ""}/.bun/bin/claude`,
];

export default class ClaudeForObsidianPlugin extends Plugin {
  settings!: ClaudeForObsidianSettings;

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.ensureClaudeBinaryPath();

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

    this.addCommand({
      id: "claude-for-obsidian-save-chat",
      name: "Save chat to vault",
      callback: () => this.withView((v) => v.saveChatToVault()),
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

  /**
   * Resolve the claude binary path on first run or whenever the saved path
   * no longer points at an executable file. Order: saved path (if valid) →
   * `which claude` via login shell → common install locations. If none
   * resolve, leave the default in place and surface a Notice telling the
   * user to run `which claude` themselves.
   */
  private async ensureClaudeBinaryPath(): Promise<void> {
    const current = this.settings.claudeBinaryPath;
    if (current && fs.existsSync(current)) return;

    const detected = this.detectClaudeBinary();
    if (detected) {
      this.settings.claudeBinaryPath = detected;
      await this.saveSettings();
      return;
    }

    new Notice(
      "Claude for Obsidian: could not find the claude CLI. Run `which claude` in a terminal and paste the result into Settings → Claude for Obsidian → Claude binary path.",
      10000,
    );
  }

  private detectClaudeBinary(): string | null {
    // Try the user's login shell first; it inherits the shell's PATH which
    // is what `which claude` would normally see.
    const shell = process.env.SHELL || "/bin/zsh";
    try {
      const out = execSync(`${shell} -lic 'command -v claude'`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      })
        .trim()
        .split("\n")
        .pop();
      if (out && fs.existsSync(out)) return out;
    } catch {
      // shell exec failed; fall through to common paths
    }

    for (const candidate of COMMON_CLAUDE_PATHS) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }

    return null;
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
