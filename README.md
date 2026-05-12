# Claude for Obsidian

> Unofficial. Drives the Claude Code CLI from inside Obsidian, so the agent loop, tool use, skills, and `CLAUDE.md` discovery you use in the terminal or the VS Code extension also work in your vault.

This plugin does not call the Anthropic API directly and does not handle API keys. It spawns the locally installed `claude` CLI as a subprocess, which means it uses whichever account that CLI is signed in to, including a Claude subscription.

## Highlights

The plugin's pitch isn't *Claude in your sidebar* — that's been done. It's *Claude that lives inside the vault graph*. Four features carry the weight:

### Wikilink autocomplete in the input

Type `[[` and a popup appears listing your vault notes, sorted by recently modified first. Filters live as you type, supports aliases (selecting an alias produces `[[Basename|Alias]]`), arrow keys navigate, Enter or Tab inserts. Same muscle memory as Obsidian's editor, in the chat box.

### Live wikilinks and hashtags in the chat stream

Anything Claude (or you) writes that looks like `[[Some Note]]` renders as an Obsidian wikilink in the conversation. Click opens the note. Cmd-hover triggers Page Preview. `#tag` clicks through to a global tag search. The chat isn't a transcript pretending to be markdown — it's the same graph fabric as the rest of your vault.

### Wikilinked dates and per-message timestamps

Every chat shows a `─── [[YYYY-MM-DD]] ───` divider at the top, and another at every midnight crossing if a chat runs across days. The date is a clickable wikilink, opening the daily note. User messages carry an `HH:MM` timestamp right-aligned next to the speaker label. Replays reconstruct historical times accurately from the underlying jsonl. As far as I know, no other LLM chat surface ties chats into the vault's calendar this way.

### Save chat to vault

A button on the panel exports the current conversation as a structured markdown transcript with proper speaker headings, time-stamped, frontmatter included, ready to drop into a daily note, project folder, or a permanent record. The export schema is locked and used vault-wide.

## Other things it does

- Sidebar chat panel; streams responses with live markdown rendering
- Working directory locked to the active vault, so `CLAUDE.md` and skills in `~/.claude/` and `<vault>/.claude/` are picked up automatically
- Tool calls render inline as collapsible blocks
- Session continuity: switch between recent chats with replay, auto-resume across panel reopens and app relaunches
- Animated thinking text while the agent is working, drawn from a small lexicon (foraging, frolicking, weeding, kneading, plucking, …)
- Context-remaining ring that drains as context fills (green → yellow → orange → red), with a model + effort + fast-mode picker beside it
- Auto-growing input, one to ten lines, Enter to send, Shift-Enter for newline

## Known issues

- **Resuming sessions started in another Claude Code surface (terminal, VS Code).** Sessions for the current working directory are visible in the history dropdown regardless of which surface created them. Selecting a foreign session from the popup currently *replays* whatever surface most recently wrote to it rather than the session you clicked. Resuming a foreign session sometimes works on the first turn after a long cold-start; sometimes it silently no-ops. Treat foreign sessions in the dropdown as **read-only for now**. Plugin-originated sessions resume reliably.

## Install

Three phases. Phase 1 is one-time terminal setup, run by hand. Phase 2 hands the rest to Claude Code itself. Phase 3 is the manual on-switch in Obsidian. Most people will be done in ten minutes.

### Platform support

- macOS 11+ on Apple Silicon or Intel — primary, well tested
- Linux desktop — should work, lightly tested
- Windows — not supported yet

### What your machine needs

| # | Item | Required? | Why |
| --- | --- | --- | --- |
| 1 | Obsidian 1.5+ | Yes | The plugin's host |
| 2 | Anthropic account on a paid plan (Pro, Max, or API credits) | Yes | The CLI needs it to actually respond |
| 3 | Xcode Command Line Tools | Yes | Provides `git` and the C toolchain Homebrew needs |
| 4 | Homebrew | Yes | Package manager for everything else |
| 5 | Node 18+ | Yes | Provides `npm`, which the Claude Code CLI installs through |
| 6 | Claude Code CLI, signed in | Yes | The plugin spawns it as a subprocess; no CLI, no agent |
| 7 | Obsidian's own command-line interface | Recommended | Lets Claude rename and move files safely; without it, renames can break wikilinks. Enable at **Obsidian → Settings → General → Command line interface** |

No Python required. No Docker. Nothing else.

### Phase 1 — Bootstrap (one-time, by hand)

If you've used the Claude Code CLI from your terminal recently, skip to Phase 2. Otherwise open Terminal (Cmd-Space → "Terminal" → Enter) and paste each block in order.

```bash
# 1. Xcode Command Line Tools (will pop a system dialog — click Install, then wait)
xcode-select --install
```

Wait for the dialog to finish before continuing. If the tools were already installed you'll see *command line tools are already installed* — that's fine.

```bash
# 2. Homebrew (skip if `brew --version` already prints a version)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Add brew to your shell PATH (Apple Silicon path; Intel Macs replace with /usr/local)
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"
```

```bash
# 3. Node (provides npm)
brew install node
```

```bash
# 4. Claude Code CLI
npm install -g @anthropic-ai/claude-code
claude login
```

`claude login` opens a browser. Sign in to your Anthropic account. Return to terminal when the browser confirms.

```bash
# 5. Verify — both lines should print something
which claude
claude --version
```

If both print, Phase 1 is done.

### Phase 2 — Let Claude Code install the plugin

Find your vault's absolute path:

- In Obsidian, click the vault name at the top of the file list (or **Settings → About** in some versions).
- Right-click the vault folder in Finder, hold **Option**, and choose *Copy "..." as Pathname*.

Then in your terminal, run:

```bash
claude
```

That opens an interactive Claude Code session. Paste this prompt, replacing `<your-vault-path>` with what you copied:

```text
Install this Obsidian plugin into my vault at <your-vault-path>:
https://github.com/hello-emrah/claude-for-obsidian
```

Claude reads this README, runs the right commands, and tells you when Phase 3 is needed. Don't close the terminal until it confirms it's done.

### Phase 3 — Turn it on inside Obsidian

1. Open Obsidian on the vault you installed into.
2. **Settings → Community plugins**. If a "Turn on community plugins" prompt appears, click *Turn on*.
3. Find **Claude for Obsidian** in the installed plugins list and toggle it on.
4. Click the bot icon in the left ribbon, or run the **Open Claude for Obsidian panel** command. Send a test message.

If you get a reply, you're done. Enjoy.

### Plugin settings to check

The plugin auto-detects the `claude` binary on first run, so you usually don't need to touch settings. If anything looks off, open **Settings → Claude for Obsidian** and confirm:

- **Claude binary path** — should be auto-filled. If empty, run `which claude` in a terminal and paste the result here.
- **Permission mode** — leave on `acceptEdits`. Don't switch to `default` (no permission UI yet, will hang on tool calls).
- **Model** — leave empty unless you have a specific model in mind.

### Manual install fallbacks

If you'd rather drive the install yourself instead of letting Claude Code do it.

#### Path A — release zip (no Node required after Phase 1)

```bash
VAULT="<your-vault-path>"
mkdir -p "$VAULT/.obsidian/plugins/claude-for-obsidian"
cd "$VAULT/.obsidian/plugins/claude-for-obsidian"
curl -L -o cfob.zip https://github.com/hello-emrah/claude-for-obsidian/releases/latest/download/claude-for-obsidian.zip
unzip -o cfob.zip
rm cfob.zip
```

#### Path B — clone and build (for contributors)

```bash
VAULT="<your-vault-path>"

git clone https://github.com/hello-emrah/claude-for-obsidian.git ~/Developer/claude-for-obsidian
cd ~/Developer/claude-for-obsidian/plugin
npm install
npm run build

mkdir -p "$VAULT/.obsidian/plugins/claude-for-obsidian"
cp main.js manifest.json styles.css "$VAULT/.obsidian/plugins/claude-for-obsidian/"
```

After either path, do Phase 3 above.

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

Early. Built for one operator, shared because it might help others. Current tag: `v0.6.2`.

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
