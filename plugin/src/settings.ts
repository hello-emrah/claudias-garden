import { App, PluginSettingTab, Setting } from "obsidian";
import type ClaudeForObsidianPlugin from "./main";

export type ClaudeEffort = "low" | "medium" | "high" | "max";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "auto"
  | "bypassPermissions";

export interface ClaudeForObsidianSettings {
  claudeBinaryPath: string;
  model: string;
  effort: ClaudeEffort;
  permissionMode: PermissionMode;
  activeSessionId: string | null;
  sessionLabels: Record<string, string>;
}

export const DEFAULT_SETTINGS: ClaudeForObsidianSettings = {
  claudeBinaryPath: "/opt/homebrew/bin/claude",
  model: "",
  effort: "high",
  permissionMode: "acceptEdits",
  activeSessionId: null,
  sessionLabels: {},
};

// Model IDs the `claude --model` flag actually accepts. Verified
// 2026-05-11 against `claude --help`: the flag takes an alias
// (`sonnet`, `opus`, `haiku`) or a full model name. The phantom `1m`
// suffix (e.g. `claude-opus-4-7-1m`) was removed — it isn't a real
// CLI-selectable model ID and the CLI returns "It may not exist or
// you may not have access to it" when passed.
export const MODEL_OPTIONS: { id: string; label: string; sublabel?: string; legacy?: boolean }[] = [
  { id: "claude-opus-4-7", label: "Opus 4.7" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5" },
  { id: "claude-opus-4-6", label: "Opus 4.6", sublabel: "Legacy", legacy: true },
];

// Effort levels the `claude --effort` flag accepts. Verified
// 2026-05-11 against `claude --help`: `low | medium | high | max`.
// The previous `extra-high` was invented and isn't accepted by the CLI.
export const EFFORT_OPTIONS: { id: ClaudeEffort; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
];

export const MODE_OPTIONS: { id: PermissionMode; label: string }[] = [
  { id: "default", label: "Ask permissions" },
  { id: "acceptEdits", label: "Accept edits" },
  { id: "plan", label: "Plan mode" },
  { id: "auto", label: "Auto mode" },
  { id: "bypassPermissions", label: "Bypass permissions" },
];

export class ClaudeForObsidianSettingTab extends PluginSettingTab {
  plugin: ClaudeForObsidianPlugin;

  constructor(app: App, plugin: ClaudeForObsidianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Claude binary path")
      .setDesc("Absolute path to the claude CLI. Auto-detected on first run via `which claude`. Override here if detection picked the wrong location or failed.")
      .addText((text) =>
        text
          .setPlaceholder("/opt/homebrew/bin/claude")
          .setValue(this.plugin.settings.claudeBinaryPath)
          .onChange(async (value) => {
            this.plugin.settings.claudeBinaryPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // Model and effort are managed via the bottom-nav popup in the
    // chat panel — they are the canonical surface. The Settings tab
    // text-field for Model was retired 2026-05-11 to prevent stale
    // free-form strings ending up in `settings.model`.

    new Setting(containerEl)
      .setName("Permission mode")
      .setDesc("How the CLI handles tool permissions. 'default' will prompt and likely hang in headless mode until permission UI lands. 'acceptEdits' is a sane starting point. The bottom-nav mode picker in the chat panel is the day-to-day surface.")
      .addDropdown((dd) => {
        for (const m of MODE_OPTIONS) dd.addOption(m.id, m.label);
        dd.setValue(this.plugin.settings.permissionMode);
        dd.onChange(async (value) => {
          this.plugin.settings.permissionMode = value as PermissionMode;
          await this.plugin.saveSettings();
        });
      });
  }
}
