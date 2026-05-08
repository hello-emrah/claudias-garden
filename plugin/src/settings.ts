import { App, PluginSettingTab, Setting } from "obsidian";
import type ClaudeForObsidianPlugin from "./main";

export interface ClaudeForObsidianSettings {
  claudeBinaryPath: string;
  model: string;
  permissionMode: "acceptEdits" | "default" | "plan" | "bypassPermissions";
  activeSessionId: string | null;
}

export const DEFAULT_SETTINGS: ClaudeForObsidianSettings = {
  claudeBinaryPath: "/opt/homebrew/bin/claude",
  model: "",
  permissionMode: "acceptEdits",
  activeSessionId: null,
};

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
      .setDesc("Absolute path to the claude CLI. Obsidian doesn't inherit your shell PATH on macOS, so a full path is required.")
      .addText((text) =>
        text
          .setPlaceholder("/opt/homebrew/bin/claude")
          .setValue(this.plugin.settings.claudeBinaryPath)
          .onChange(async (value) => {
            this.plugin.settings.claudeBinaryPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Optional. Passed as --model. Leave empty to use the CLI default.")
      .addText((text) =>
        text
          .setPlaceholder("(CLI default)")
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Permission mode")
      .setDesc("How the CLI handles tool permissions. 'default' will prompt and likely hang in headless mode. 'acceptEdits' is a sane starting point.")
      .addDropdown((dd) =>
        dd
          .addOption("default", "default")
          .addOption("acceptEdits", "acceptEdits")
          .addOption("plan", "plan")
          .addOption("bypassPermissions", "bypassPermissions")
          .setValue(this.plugin.settings.permissionMode)
          .onChange(async (value) => {
            this.plugin.settings.permissionMode = value as ClaudeForObsidianSettings["permissionMode"];
            await this.plugin.saveSettings();
          })
      );
  }
}
