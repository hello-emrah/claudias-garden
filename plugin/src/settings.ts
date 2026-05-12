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
  // Once the user has confirmed bypassPermissions for this vault
  // ("Bypass all permissions?" modal), don't re-prompt on subsequent
  // mode picks. Per-vault state — `data.json` is per-vault by Obsidian
  // convention, so this naturally scopes to the workspace.
  bypassPermissionsConfirmed: boolean;
}

export const DEFAULT_SETTINGS: ClaudeForObsidianSettings = {
  claudeBinaryPath: "/opt/homebrew/bin/claude",
  model: "",
  effort: "high",
  permissionMode: "acceptEdits",
  activeSessionId: null,
  sessionLabels: {},
  bypassPermissionsConfirmed: false,
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

    // Model, effort, and permission mode are managed via the
    // bottom-nav pickers in the chat panel — they are the canonical
    // surface. The Settings tab dropdowns were retired:
    //   - Model field on 2026-05-11 (prevent stale free-form strings
    //     ending up in settings.model).
    //   - Permission mode on 2026-05-12 (same reason — and the bypass
    //     confirmation modal lives on the panel-side picker only).
    // What remains in the Settings tab is genuinely system-level
    // configuration (binary path).
  }
}
