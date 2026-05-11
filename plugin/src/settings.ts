import { App, PluginSettingTab, Setting } from "obsidian";
import type ClaudeForObsidianPlugin from "./main";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

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

// Model IDs the `claude --model` flag accepts. Re-verified 2026-05-12
// against CLI v2.1.139 (native binary). The `opus[1m]` alias resolves
// to `claude-opus-4-7` with the `context-1m-2025-08-07` beta header
// applied — that's how the 1M context window is selected. Same shape
// works for `sonnet[1m]` (Sonnet 4.6 with 1M). Both versions of Opus
// 4.7 (standard 200k and 1M) are present in the native model picker;
// CFOB now mirrors that. Earlier note about `claude-opus-4-7-1m`
// being phantom still stands — `[1m]` is an alias suffix, not a model
// ID suffix.
export const MODEL_OPTIONS: { id: string; label: string; sublabel?: string; legacy?: boolean }[] = [
  { id: "claude-opus-4-7", label: "Opus 4.7" },
  { id: "opus[1m]", label: "Opus 4.7", sublabel: "1M context" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "sonnet[1m]", label: "Sonnet 4.6", sublabel: "1M context" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5" },
  { id: "claude-opus-4-6", label: "Opus 4.6", sublabel: "Legacy", legacy: true },
];

// Effort levels the `claude --effort` flag accepts. Re-verified
// 2026-05-12 against CLI v2.1.139: `low | medium | high | xhigh | max`.
// `xhigh` is the new fifth level that 2.1.74 didn't expose; it sits
// between `high` and `max` and matches the native picker's "Extra high".
export const EFFORT_OPTIONS: { id: ClaudeEffort; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
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
