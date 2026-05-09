# Claude for Obsidian

> Unofficial. Drives the Claude Code CLI from inside Obsidian, so the agent loop, tool use, skills, and `CLAUDE.md` discovery you use in the terminal or the VS Code extension also work in your vault.

This plugin does not call the Anthropic API directly and does not handle API keys. It spawns the locally installed `claude` CLI as a subprocess, which means it uses whichever account that CLI is signed in to, including a Claude subscription.

## Highlights

The plugin's pitch isn't *Claude in your sidebar* — that's been done. It's *Claude that lives inside the vault graph*. Five features carry the weight:

### Wikilink autocomplete in the input

Type `[[` and a popup appears listing your vault notes, sorted by recently modified first. Filters live as you type, supports aliases (selecting an alias produces `[[Basename|Alias]]`), arrow keys navigate, Enter or Tab inserts. Same muscle memory as Obsidian's editor, in the chat box.

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

## Install

This section is written as a runbook. Copy any block into a terminal verbatim. Every command is platform-agnostic where possible; macOS and Linux deviations are called out.

> **For LLM agents.** This README is the install spec. Replace `<your-vault-path>` with the absolute path to the user's Obsidian vault and run the blocks in order. The only manual human step is the final Community Plugins toggle in Obsidian's UI.

### Platform support

- macOS (Apple Silicon and Intel) — primary
- Linux desktop — should work, lightly tested
- Windows — not supported yet (subprocess and PATH handling are macOS-first)

### Prerequisites

**Required.**

```bash
# 1. Node 18 or newer (needed only for the build-from-source path; skip if installing from the release zip)
node --version

# 2. Claude Code CLI, signed in
npm install -g @anthropic-ai/claude-code
claude login
which claude
claude --version
```

If `which claude` returns a path and `claude --version` prints a version string, the CLI is installed correctly.

**Recommended (for vault safety).**

The plugin doesn't need Obsidian's command-line interface to run. But once Claude is acting on the vault from inside the panel, file renames and moves should go through Obsidian's CLI to keep wikilinks resolved and frontmatter intact. Without it, Claude falls back to plain Edit/Write which can break Obsidian-flavoured links on rename.

Enable: **Obsidian → Settings → General → Command line interface**.

### Install path A — release zip (recommended for users)

```bash
# Set this once
VAULT="<your-vault-path>"

# Pull the latest release zip and unpack into the vault's plugins folder
mkdir -p "$VAULT/.obsidian/plugins/claude-for-obsidian"
cd "$VAULT/.obsidian/plugins/claude-for-obsidian"
curl -L -o cfob.zip https://github.com/hello-emrah/claude-for-obsidian/releases/latest/download/claude-for-obsidian.zip
unzip -o cfob.zip
rm cfob.zip
```

### Install path B — clone and build (for contributors)

```bash
# Set this once
VAULT="<your-vault-path>"

git clone https://github.com/hello-emrah/claude-for-obsidian.git ~/Developer/claude-for-obsidian
cd ~/Developer/claude-for-obsidian/plugin
npm install
npm run build

# Copy the build artefacts into the vault
mkdir -p "$VAULT/.obsidian/plugins/claude-for-obsidian"
cp main.js manifest.json styles.css "$VAULT/.obsidian/plugins/claude-for-obsidian/"
```

### Enable (manual step)

1. Open Obsidian on the vault you installed into.
2. **Settings → Community plugins**. If Restricted mode is on, turn it off.
3. Find **Claude for Obsidian** in the installed plugins list and toggle it on.
4. Click the bot icon in the left ribbon, or run the **Open Claude for Obsidian panel** command.

### Verify

The plugin auto-detects the `claude` binary on first run by walking your shell's PATH and a list of common install locations. If detection succeeds, settings will already point at the right binary. If you see a notice telling you to set the path manually:

```bash
which claude
```

Paste the result into **Settings → Claude for Obsidian → Claude binary path**.

Send a test message in the panel. If you get a reply, you're done.

## Configuration

Settings tab fields:

- **Claude binary path** — absolute path to the `claude` CLI. Auto-detected on first run. Override only if detection picked the wrong location.
- **Model** — optional, passed as `--model`. Leave empty to use the CLI default.
- **Permission mode** — how the CLI handles tool permissions. `acceptEdits` is the recommended default. `default` will surface a refusal rather than a permission prompt because there is no permission UI in the plugin yet (Increment 4).

Identity and skills come from your existing Claude Code setup, not from plugin settings:

- Global identity: `~/.claude/CLAUDE.md`
- Per vault identity: `CLAUDE.md` at the vault root
- Global skills: `~/.claude/skills/`
- Per vault skills: `<vault>/.claude/skills/`

The plugin does not duplicate or override these. It inherits them by setting the subprocess working directory to the active vault.

## Status

Early. Built for one operator, shared because it might help others. Current tag: `v0.4.2`.

Shipped:

- **Increment 1** — chat panel, streaming markdown, autogrow input, vault scoped cwd
- **Increment 2** — session continuity, history dropdown, new and delete chat, unified send/stop
- **Increment 3** — Obsidian-native chat: wikilink click and hover, save chat to vault, typography pass, history popup with search/rename/per-row delete, auto-resume replay on boot, **wikilink autocomplete on `[[`**
- **Polish + bug pass** — two-box input layout, animated thinking text with rotating verb pool, gated context counter, header redesign with chat title pill, popout-window history fix, cross-vault session leakage closed
- **Wikilinked date dividers and per-message timestamps** — every chat shows clickable date markers and user-message times; replays reconstruct historical times from the jsonl

Planned:

- **Increment 4** — model picker, slash command palette, plus menu (attach, mention file, clear, rewind), permission mode toggle, active file context injection. Permission UI is the largest piece and likely earns its own increment
- **Increment 5** — UI refinement borrowing organisation from the Claude native desktop app: dropdown chat title with history search and rename/delete, top-right transcript view-mode toggle alongside new-chat and download, microphone inline in the textbox, single circular button on the bottom-right collapsing model picker + effort slider + plan usage meters

## Hacking

Plugin source lives under `plugin/`. To work on it:

1. Clone the repo.
2. `cd plugin && npm install && npm run build` (or `npm run dev` for watch mode).
3. Set up a dev vault and symlink the `plugin/` folder into its `.obsidian/plugins/claude-for-obsidian/`. The repo's `dev-vault/` path is gitignored.

```bash
ln -s "$(pwd)/plugin" /path/to/dev-vault/.obsidian/plugins/claude-for-obsidian
```

**Symlinks belong in dev vaults only, never in your live vault.** If your vault is on iCloud or any other sync, the sync layer treats a symlink as a symlink, not as the resolved target. Every other machine paired to that vault will inherit a dead link. For live vaults always copy the build artefacts (`main.js`, `manifest.json`, `styles.css`) — the install matrix above does this correctly.

## Licence

MIT. See [LICENSE](LICENSE).

## Disclaimer

Not affiliated with Anthropic or the Obsidian team. "Claude" and "Obsidian" are trademarks of their respective owners. Use of the Claude Code CLI is subject to its own terms.
