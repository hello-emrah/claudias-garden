# Claude for Obsidian

> Unofficial. Drives the Claude Code CLI from inside Obsidian, so the agent loop, tool use, skills, and `CLAUDE.md` discovery you use in the terminal or the VS Code extension also work in your vault.

This plugin does not call the Anthropic API directly and does not handle API keys. It spawns the locally installed `claude` CLI as a subprocess, which means it uses whichever account that CLI is signed in to, including a Claude subscription.

## Highlights

The plugin's pitch isn't *Claude in your sidebar* — that's been done. It's *Claude that lives inside the vault graph*. Four features carry the weight:

### Live wikilinks and hashtags in the chat stream

Anything Claude (or you) writes that looks like `[[Some Note]]` renders as an Obsidian wikilink in the conversation. Click opens the note. Cmd-hover triggers Page Preview. `#tag` clicks through to a global tag search. The chat isn't a transcript pretending to be markdown — it's the same graph fabric as the rest of your vault.

### Wikilinked dates and per-message timestamps

Every chat shows a `─── [[YYYY-MM-DD]] ───` divider at the top, and another at every midnight crossing if a chat runs across days. The date is a clickable wikilink, opening the daily note. User messages carry an `HH:MM` timestamp right-aligned next to the speaker label. Replays reconstruct historical times accurately from the underlying jsonl. As far as I know, no other LLM chat surface ties chats into the vault's calendar this way.

### Save chat to vault

A button on the panel exports the current conversation as a structured markdown transcript with proper speaker headings, time-stamped, frontmatter included, ready to drop into a daily note, project folder, or a permanent record. The export schema is locked and used vault-wide.

### Cross-client session visibility

All Claude Code sessions for a given working directory write to the same `~/.claude/projects/<encoded-cwd>/` folder regardless of which surface created them — terminal CLI, VS Code extension, or this plugin. The history dropdown surfaces the lot. You can browse and continue chats started in any of those surfaces from inside Obsidian.

## Other things it does

- Sidebar chat panel; streams responses with live markdown rendering
- Working directory locked to the active vault, so `CLAUDE.md` and skills in `~/.claude/` and `<vault>/.claude/` are picked up automatically
- Tool calls render inline as collapsible blocks
- Session continuity: switch between recent chats with replay, auto-resume across panel reopens and app relaunches
- Animated thinking text while the agent is working, drawn from a small lexicon (foraging, frolicking, weeding, musing, …)
- Context-remaining counter that only surfaces when 50% of the window has been consumed, so you aren't counted while you write
- Auto-growing input, one to ten lines, Enter to send, Shift-Enter for newline

## Requirements

- macOS or Linux desktop
- Obsidian 1.5 or newer
- Claude Code CLI installed and signed in. Confirm with `which claude` and a test run in your terminal first.

Windows is not yet supported. The subprocess and PATH handling are macOS first today.

## Install

Manual install for now (the plugin is not in the community store).

1. Clone this repo somewhere outside your vault.
2. `cd plugin && npm install && npm run build`
3. Copy or symlink the `plugin/` folder into `<your-vault>/.obsidian/plugins/claude-for-obsidian/`.
4. In Obsidian: Settings, Community plugins, turn off Restricted mode, enable Claude for Obsidian.
5. Click the bot icon in the left ribbon, or run the `Open Claude for Obsidian panel` command.

## Configuration

Settings tab fields:

- **Claude binary path**: absolute path to the `claude` CLI. Defaults to `/opt/homebrew/bin/claude`. Obsidian does not inherit your shell PATH on macOS, so an absolute path is required.
- **Model**: optional. Passed as `--model`. Leave empty to use the CLI default.
- **Permission mode**: how the CLI handles tool permissions. `acceptEdits` is the recommended default. `default` will surface a refusal rather than a permission prompt because there is no permission UI in the plugin yet (Increment 4).

Identity and skills come from your existing Claude Code setup, not from plugin settings:

- Global identity: `~/.claude/CLAUDE.md`
- Per vault identity: `CLAUDE.md` at the vault root
- Global skills: `~/.claude/skills/`
- Per vault skills: `<vault>/.claude/skills/`

The plugin does not duplicate or override these. It inherits them by setting the subprocess working directory to the active vault.

## Status

Early. Built for one operator, shared because it might help others. Current tag: `v0.4.0`.

Shipped:

- **Increment 1** — chat panel, streaming markdown, autogrow input, vault scoped cwd
- **Increment 2** — session continuity, history dropdown, new and delete chat, unified send/stop
- **Increment 3** (mostly) — Obsidian-native chat: wikilink click and hover, save chat to vault, typography pass, history popup with search/rename/per-row delete, auto-resume replay on boot
- **Polish + bug pass** — two-box input layout, animated thinking text with rotating verb pool, gated context counter, header redesign with chat title pill, popout-window history fix, cross-vault session leakage closed
- **Wikilinked date dividers and per-message timestamps** — every chat shows clickable date markers and user-message times; replays reconstruct historical times from the jsonl

Outstanding for Increment 3: wikilink autocomplete on `[[`.

Planned:

- **Increment 4** — model picker, slash command palette, plus menu (attach, mention file, clear, rewind), permission mode toggle, active file context injection. Permission UI is the largest piece and likely earns its own increment
- **Increment 5** — multi-chat tabs, mic toggle, sticky last operator message with fold and rewind

## Hacking

Plugin source lives under `plugin/`. To work on it:

1. Clone the repo.
2. `cd plugin && npm install && npm run build` (or `npm run dev` for watch mode).
3. Set up a dev vault wherever suits you and symlink the `plugin/` folder into its `.obsidian/plugins/claude-for-obsidian/`. The repo's `dev-vault/` path is gitignored — keep your scratch vault out of source control.

## Licence

MIT. See [LICENSE](LICENSE).

## Disclaimer

Not affiliated with Anthropic or the Obsidian team. "Claude" and "Obsidian" are trademarks of their respective owners. Use of the Claude Code CLI is subject to its own terms.
