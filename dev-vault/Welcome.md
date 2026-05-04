# Claude for Obsidian Dev Vault

Development vault for the Claude for Obsidian plugin. The plugin is symlinked at `.obsidian/plugins/claude-for-obsidian/` and points back to the source at `~/@Sandbox/ObsidiClaude/plugin/`. The on-disk build folder still uses the old `ObsidiClaude` name; alignment is a later cleanup.

## First run

1. Open this vault in Obsidian.
2. Settings → Community plugins → turn off Restricted mode.
3. Enable Claude for Obsidian in the Installed plugins list.
4. Click the bot icon in the left ribbon, or run the `Open Claude for Obsidian panel` command.
5. Confirm the binary path in plugin settings (default `/opt/homebrew/bin/claude`).
6. Send a message. The first send initialises a CLI session under your Claude subscription.
