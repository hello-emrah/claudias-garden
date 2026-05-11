import { ItemView, WorkspaceLeaf, Notice, MarkdownRenderer, Component, TFile, normalizePath, setIcon } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ClaudeSession, StreamEvent, PermissionDecision } from "./claude-client";
import { lineDiff, renderDiff } from "./diff";
import { exportSession } from "./chat-export";
import { WikilinkSuggest } from "./wikilink-suggest";
import { openModelPopup } from "./model-popup";
import { MODEL_OPTIONS, EFFORT_OPTIONS, MODE_OPTIONS, PermissionMode } from "./settings";
import { renderToolRow, RenderOutput, ToolResult } from "./tool-renderers";
import type ClaudeForObsidianPlugin from "./main";

interface SessionSummary {
  id: string;
  label: string;
  timestamp: number;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "now";
  const m = Math.floor(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  const y = Math.floor(d / 365);
  return `${y}y`;
}

export const CLAUDE_FOR_OBSIDIAN_VIEW = "claude-for-obsidian-view";

interface ToolGroup {
  el: HTMLElement;
  headerEl: HTMLElement;
  bodyEl: HTMLElement;
  statusEl: HTMLElement;
  // Map of tool name → running count, for the rolling header text.
  runningByName: Map<string, number>;
  // Total ever-seen names in this group, used for the settled label.
  seenNames: string[];
  // Skill IDs loaded inside this group, captured from `Skill` tool calls
  // for surfacing in the settled header text.
  loadedSkills: string[];
  expanded: boolean;
}

interface AssistantBuffer {
  containerEl: HTMLDivElement;
  bodyEl: HTMLDivElement;
  text: string;
  // Number of characters currently revealed in the rendered DOM.
  revealedLen: number;
  // requestAnimationFrame handle for the paced reveal loop.
  revealRaf: number | null;
  // Last frame timestamp; null when not running.
  lastFrameAt: number | null;
}

// Visible character reveal rate in chars per second. ~720 chars/sec at
// the base rate; we accelerate when the unrevealed buffer grows so long
// dumps don't drag, and we slow down when within sight of the end so the
// reveal lands gently.
const REVEAL_BASE_CPS = 720;
const REVEAL_BURST_THRESHOLD = 800;
const REVEAL_BURST_MULTIPLIER = 3;

const THINKING_VERBS = [
  "Foraging",
  "Frolicking",
  "Gallivanting",
  "Weeding",
  "Harvesting",
  "Encouraging",
  "Gathering",
  "Mulching",
  "Composting",
  "Pruning",
  "Sowing",
  "Divining",
  "Listening",
  "Wandering",
  "Pottering",
  "Tending",
  "Kindling",
  "Casting",
  "Dismantling",
  "Kneading",
  "Ploughing",
  "Kissing",
  "Hugging",
  "Feeling",
  "Revolting",
  "Strumming",
  "Plucking",
  "Smiling",
  "Singing",
];

const THINKING_ROTATE_MS = 3000;

// Context window per model. The `[1m]` alias variants (opus[1m] /
// sonnet[1m] / etc.) carry the 1M context beta. Everything else on
// the Claude 4.x family is 200k. Unknown model IDs default to 200k —
// the safer assumption (under-reporting room means the meter goes red
// earlier, not later).
function contextWindowForModel(modelId: string | null | undefined): number {
  const id = (modelId ?? "").toLowerCase();
  if (id.includes("[1m]")) return 1_000_000;
  return 200_000;
}

// Read-only shell commands the agent runs constantly for orientation
// — date, echo, ls, pwd, cat, head, tail, wc, find, file, which,
// whoami, hostname, uname, ps, stat, du, df, env, locale, grep / rg /
// ag (search without writes), git status / log / diff / show / branch
// / remote / config --get / ls-files. These should not prompt: the
// agent uses them five times a turn for diagnostics. Risky commands
// (rm, mv, cp, curl, wget, npm, pip, gem, brew, chmod, chown, kill,
// pkill, mkdir, rmdir, touch, sudo, ssh, scp, eval, exec, source) and
// any command with shell operators (>, >>, |, &&, ||, ;, backticks,
// $()) fall through to the dialog. Matches the CLI's own built-in
// safe-bash behaviour from the days before our PreToolUse hook
// intercepted every Bash call.
const BASH_SAFE_COMMANDS = new Set<string>([
  // Identity / system info
  "date", "echo", "pwd", "whoami", "hostname", "uname",
  "which", "type", "command", "where",
  "env", "printenv", "locale", "id", "groups",
  // File reading
  "cat", "head", "tail", "less", "more",
  "wc", "file", "stat", "du", "df",
  "basename", "dirname", "realpath", "readlink",
  // Listing
  "ls", "tree", "find",
  // Search (read-only)
  "grep", "egrep", "fgrep", "rg", "ag",
  // Process info (read-only)
  "ps", "pgrep", "jobs", "uptime",
  // Misc read-only
  "true", "false", "test",
]);

// Git subcommands that are read-only. `git push`, `git commit`,
// `git checkout`, `git reset`, etc. are NOT here and will dialog.
const GIT_SAFE_SUBCOMMANDS = new Set<string>([
  "status", "log", "diff", "show", "branch", "remote",
  "ls-files", "ls-tree", "rev-parse", "blame", "describe",
  "tag", "stash", "shortlog", "reflog",
]);

function isSafeBashCommand(command: string): boolean {
  if (!command || typeof command !== "string") return false;
  const trimmed = command.trim();
  if (!trimmed) return false;
  // Reject anything with shell operators that could chain, redirect,
  // or expand to an unsafe call. Conservative: a pipe to `wc` is safe
  // in practice but flagging chains keeps the surface tight for v0.6.1.
  // The PreToolUse-hook gate is the user's last line of defence — when
  // in doubt, dialog.
  if (/[><|;&`$()]/.test(trimmed)) return false;
  // No leading sudo, even when followed by a "safe" command.
  if (/^sudo\b/.test(trimmed)) return false;
  // First whitespace-separated token = the command name.
  const head = trimmed.split(/\s+/)[0];
  if (head === "git") {
    const sub = trimmed.split(/\s+/)[1];
    if (!sub) return false;
    // `git config --get foo` is safe, but `git config foo bar` writes.
    if (sub === "config") return /\s--(get|list|get-all|get-regexp)\b/.test(trimmed);
    return GIT_SAFE_SUBCOMMANDS.has(sub);
  }
  // `find` with -delete or -exec is not safe.
  if (head === "find" && /\s-(delete|exec|execdir|ok|okdir)\b/.test(trimmed)) return false;
  return BASH_SAFE_COMMANDS.has(head);
}

export class ClaudeForObsidianView extends ItemView {
  private outputEl!: HTMLDivElement;
  private inputEl!: HTMLTextAreaElement;
  private statusEl!: HTMLDivElement;
  private batteryEl!: HTMLButtonElement;
  private modelBtn!: HTMLButtonElement;
  private editsBtn!: HTMLButtonElement;
  private micBtn!: HTMLButtonElement;
  private chatTitleEl!: HTMLButtonElement;
  private sendStopBtn!: HTMLButtonElement;
  // One subprocess per chat (v0.6.0). Stays alive across multiple
  // user-message turns so in-memory state (CronCreate schedulers,
  // watchers) survives between turns. End() is called on chat switch,
  // new chat, delete-active-chat, and panel close.
  private currentSession: ClaudeSession | null = null;
  // True while a user-message turn is in flight (user message sent,
  // result event not yet received). Used to gate UI affordances that
  // require a quiescent session.
  private turnBusy = false;
  private currentAssistant: AssistantBuffer | null = null;
  private renderComponent: Component = new Component();
  private activeSessionId: string | null = null;
  private pendingTitle: string | null = null;
  private sessionTokensUsed = 0;
  private lastStderr: string | null = null;
  private lastDateKey: string | null = null;
  private wikilinkSuggest: WikilinkSuggest | null = null;
  private pendingTools: Map<
    string,
    { el: HTMLElement; startedAt: number; group: ToolGroup; name: string; input: any }
  > = new Map();
  private static readonly TOOL_MIN_VISIBLE_MS = 600;
  private currentToolGroup: ToolGroup | null = null;
  // Permission dialog state — single instance anchored above the input
  // stack. Pending requests beyond the active one queue FIFO.
  private permissionDialogEl: HTMLDivElement | null = null;
  private permissionQueue: Array<{
    requestId: string;
    toolUseId: string;
    toolName: string;
    input: any;
    blockedPath?: string;
    decisionReason?: string;
  }> = [];
  private activePermissionRequest: typeof this.permissionQueue[number] | null = null;
  private permissionKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  // Per-turn wrapper for everything Claude emits in a single agent turn:
  // narration prose, tool groups, final prose. The CLAUDE header sits
  // once at the top of this wrapper. Reset to null when a user message
  // lands (closes the turn) or `closeClaudeTurn` is called explicitly.
  private currentClaudeTurn: HTMLElement | null = null;
  private trailingThinkingEl: HTMLElement | null = null;
  private trailingThinkingTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: ClaudeForObsidianPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return CLAUDE_FOR_OBSIDIAN_VIEW;
  }

  getDisplayText(): string {
    return "Claude for Obsidian";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("claude-for-obsidian-view");

    const headerRow = root.createDiv({ cls: "cfo-header-row" });
    this.chatTitleEl = headerRow.createEl("button", { cls: "cfo-chat-title-tab" });
    this.chatTitleEl.title = "Chat history, rename, delete";
    this.chatTitleEl.onclick = (evt) => this.toggleHistoryMenu(evt);
    this.refreshChatTitle();
    headerRow.createDiv({ cls: "cfo-header-spacer" });
    const transcriptBtn = headerRow.createEl("button", { cls: "cfo-header-btn cfo-header-btn-disabled" });
    setIcon(transcriptBtn, "list");
    transcriptBtn.title = "Transcript view mode (coming soon)";
    transcriptBtn.disabled = true;
    const newBtn = headerRow.createEl("button", { cls: "cfo-header-btn" });
    setIcon(newBtn, "plus");
    newBtn.title = "New chat";
    newBtn.onclick = () => this.newChat();
    const saveBtn = headerRow.createEl("button", { cls: "cfo-header-btn" });
    setIcon(saveBtn, "download");
    saveBtn.title = "Save chat to vault";
    saveBtn.onclick = () => this.saveChatToVault();

    this.outputEl = root.createDiv({ cls: "cfo-output" });

    this.activeSessionId = this.plugin.settings.activeSessionId ?? null;
    if (this.activeSessionId) {
      this.replaySession(this.activeSessionId);
    }
    this.refreshChatTitle();

    // Permission dialog anchor — sits between the output and the input
    // stack. Hidden until a control_request lands; one dialog at a time,
    // additional requests queue FIFO.
    this.permissionDialogEl = root.createDiv({ cls: "cfo-permission-dialog cfo-permission-dialog-hidden" });

    const inputStack = root.createDiv({ cls: "cfo-input-stack" });

    this.statusEl = inputStack.createDiv({ cls: "cfo-status" });

    const textBox = inputStack.createDiv({ cls: "cfo-textbox" });
    this.inputEl = textBox.createEl("textarea", { cls: "cfo-input" });
    this.inputEl.placeholder = "Type / for commands, [[ for wikilinks";
    this.inputEl.rows = 1;
    this.autosizeInput();

    this.sendStopBtn = textBox.createEl("button", { cls: "cfo-send-inline" });
    setIcon(this.sendStopBtn, "corner-down-left");

    const footerNav = inputStack.createDiv({ cls: "cfo-footer-nav" });

    this.editsBtn = footerNav.createEl("button", { cls: "cfo-edits-btn" });
    this.editsBtn.onclick = () => this.toggleModePopup();
    this.refreshEditsBtn();

    const plusBtn = footerNav.createEl("button", { cls: "cfo-footer-btn" });
    setIcon(plusBtn, "plus");
    plusBtn.title = "Add (coming soon)";
    plusBtn.onclick = () => this.togglePlusMenu(plusBtn);

    this.micBtn = footerNav.createEl("button", { cls: "cfo-footer-btn" });
    setIcon(this.micBtn, "mic");
    this.micBtn.title = "Voice input (not available)";
    this.micBtn.onclick = () =>
      this.toggleInfoPopup(
        this.micBtn,
        "Voice input",
        "Web Speech API isn't wired in Obsidian's Electron build (Chromium routes recognition through Google's service, which requires an API key the embedder doesn't ship). Use macOS dictation (Edit → Start Dictation, or the fn fn shortcut) on the input area as the current workaround.",
      );

    footerNav.createDiv({ cls: "cfo-footer-spacer" });

    this.batteryEl = footerNav.createEl("button", { cls: "cfo-battery" });
    this.batteryEl.onclick = () => this.togglePlanUsagePopup();
    this.renderBattery();

    this.modelBtn = footerNav.createEl("button", { cls: "cfo-model-btn" });
    this.modelBtn.onclick = () => this.toggleModelMenu();
    this.refreshModelBtn();

    this.sendStopBtn.title = "Send (Enter)";
    this.sendStopBtn.onclick = () => this.toggleSendStop();
    this.inputEl.addEventListener("input", () => this.autosizeInput());
    this.inputEl.addEventListener("keydown", (e) => {
      if (this.wikilinkSuggest?.isOpen()) return;
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        this.toggleSendStop();
      } else if (e.key === "Escape" && this.turnBusy) {
        e.preventDefault();
        this.cancel();
      }
    });

    this.wikilinkSuggest = new WikilinkSuggest(this.app, this.inputEl);

    this.renderComponent.load();
  }

  async onClose(): Promise<void> {
    // Tear the long-lived subprocess down so the CLI exits cleanly when
    // the panel closes. Cancel just interrupts the in-flight turn; for
    // full close-out we want stdin closed and SIGTERM as a fallback.
    if (this.currentSession) {
      this.currentSession.kill();
      this.currentSession = null;
    }
    this.turnBusy = false;
    this.stopTrailingThinking();
    if (this.wikilinkSuggest) {
      this.wikilinkSuggest.destroy();
      this.wikilinkSuggest = null;
    }
    this.renderComponent.unload();
  }

  private autosizeInput(): void {
    if (!this.inputEl) return;
    const cs = getComputedStyle(this.inputEl);
    const lineHeight = parseFloat(cs.lineHeight) || 20;
    const paddingY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const borderY = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const maxH = lineHeight * 10 + paddingY + borderY;
    this.inputEl.style.height = "auto";
    const desired = this.inputEl.scrollHeight;
    this.inputEl.style.height = Math.min(desired, maxH) + "px";
    this.inputEl.style.overflowY = desired > maxH ? "auto" : "hidden";
  }

  private resolveCwd(): string {
    const adapter: any = this.app.vault.adapter;
    if (typeof adapter.getBasePath === "function") return adapter.getBasePath();
    return process.cwd();
  }

  private vaultName(): string {
    return this.app.vault.getName();
  }

  private setTitleText(text: string): void {
    if (!this.chatTitleEl) return;
    this.chatTitleEl.empty();
    this.chatTitleEl.createSpan({ cls: "cfo-chat-title-label", text });
    const chevron = this.chatTitleEl.createSpan({ cls: "cfo-chat-title-chevron" });
    setIcon(chevron, "chevron-down");
  }

  private refreshChatTitle(): void {
    if (!this.chatTitleEl) return;
    const id = this.activeSessionId;
    if (!id) {
      if (this.pendingTitle) {
        this.setTitleText(this.pendingTitle);
        this.chatTitleEl.toggleClass("cfo-chat-title-empty", false);
      } else {
        this.setTitleText("New chat");
        this.chatTitleEl.toggleClass("cfo-chat-title-empty", true);
      }
      return;
    }
    this.chatTitleEl.toggleClass("cfo-chat-title-empty", false);
    const custom = this.plugin.settings.sessionLabels[id];
    if (custom) {
      this.setTitleText(custom);
      return;
    }
    // Look up first user message from the jsonl on demand.
    const filePath = this.findSessionFile(id);
    if (filePath) {
      try {
        const lines = fs.readFileSync(filePath, "utf8").split("\n").slice(0, 50);
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            if (evt.type === "user" && typeof evt.message?.content === "string") {
              this.setTitleText(evt.message.content);
              return;
            }
          } catch {}
        }
      } catch {}
    }
    // Fall back to pendingTitle (captured at send time) if jsonl hasn't
    // flushed the user message yet.
    if (this.pendingTitle) {
      this.setTitleText(this.pendingTitle);
      return;
    }
    this.setTitleText("(untitled)");
  }

  private projectsRoot(): string {
    return path.join(os.homedir(), ".claude", "projects");
  }

  private encodedCwd(): string {
    // Claude Code encodes the cwd by replacing every character that isn't
    // alphanumeric with a hyphen. So `/Users/foo/@Bar Baz` becomes
    // `-Users-foo--Bar-Baz`.
    return this.resolveCwd().replace(/[^A-Za-z0-9]/g, "-");
  }

  private listSessions(): SessionSummary[] {
    const root = this.projectsRoot();
    const dirPath = path.join(root, this.encodedCwd());
    let files: string[];
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }
    const summaries: SessionSummary[] = [];
    for (const file of files) {
      const fullPath = path.join(dirPath, file);
      const id = file.replace(/\.jsonl$/, "");
      let label = "(empty)";
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      try {
        const head = fs.readFileSync(fullPath, "utf8").split("\n").slice(0, 50);
        for (const line of head) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            if (evt.type === "user" && typeof evt.message?.content === "string") {
              label = evt.message.content;
              break;
            }
            if (evt.type === "queue-operation" && typeof evt.content === "string") {
              label = evt.content;
              break;
            }
          } catch {
            // skip malformed line
          }
        }
      } catch {
        // unreadable file; skip
      }
      const truncated = label.length > 40 ? label.slice(0, 40) + "…" : label;
      summaries.push({ id, label: truncated, timestamp: stat.mtimeMs });
    }
    summaries.sort((a, b) => b.timestamp - a.timestamp);
    return summaries;
  }

  private toggleHistoryMenu(evt: MouseEvent): void {
    const existing = this.containerEl.ownerDocument.querySelector(".cfo-history-popup");
    if (existing) {
      this.chatTitleEl.removeClass("cfo-btn-active");
      existing.remove();
      return;
    }
    this.openHistoryMenu(evt);
  }

  private openHistoryMenu(evt: MouseEvent): void {
    const doc = this.containerEl.ownerDocument;

    // Close any existing popup first, scoped to the containing window.
    doc.querySelectorAll(".cfo-history-popup").forEach((el) => el.remove());

    const sessions = this.listSessions();
    const popup = doc.body.createDiv({ cls: "cfo-history-popup" });

    // Position near the trigger button. Anchor by left edge so a
    // left-side trigger (the chat title pill) opens the popup rightward
    // rather than off the screen.
    const target = evt.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    popup.style.top = `${rect.bottom + 4}px`;
    popup.style.left = `${rect.left}px`;

    // Search input.
    const searchWrap = popup.createDiv({ cls: "cfo-history-search" });
    const searchIcon = searchWrap.createSpan({ cls: "cfo-history-search-icon" });
    setIcon(searchIcon, "search");
    const searchInput = searchWrap.createEl("input", {
      cls: "cfo-history-search-input",
      attr: { type: "text", placeholder: "Search sessions…" },
    });

    // Sessions list.
    const list = popup.createDiv({ cls: "cfo-history-list" });

    const render = (filter: string): void => {
      list.empty();
      const f = filter.trim().toLowerCase();
      const filtered = f
        ? sessions.filter((s) => (this.sessionLabel(s) || s.id).toLowerCase().includes(f))
        : sessions;

      if (filtered.length === 0) {
        list.createDiv({ cls: "cfo-history-empty", text: "No sessions" });
        return;
      }

      for (const s of filtered) {
        const row = list.createDiv({ cls: "cfo-history-row" });
        if (s.id === this.activeSessionId) row.addClass("cfo-history-row-active");

        const label = row.createDiv({ cls: "cfo-history-label" });
        label.setText(this.sessionLabel(s));

        const time = row.createDiv({ cls: "cfo-history-time" });
        time.setText(relativeTime(s.timestamp));

        const actions = row.createDiv({ cls: "cfo-history-actions" });
        const renameBtn = actions.createEl("button", { cls: "cfo-history-action" });
        setIcon(renameBtn, "pencil");
        renameBtn.title = "Rename";
        renameBtn.onclick = (e) => {
          e.stopPropagation();
          this.beginRename(row, label, s.id);
        };
        const trashBtn = actions.createEl("button", { cls: "cfo-history-action" });
        setIcon(trashBtn, "trash-2");
        trashBtn.title = "Delete";
        trashBtn.onclick = (e) => {
          e.stopPropagation();
          this.confirmDelete(s.id, () => {
            const idx = sessions.indexOf(s);
            if (idx >= 0) sessions.splice(idx, 1);
            render(searchInput.value);
          });
        };

        row.onclick = () => {
          this.chatTitleEl.removeClass("cfo-btn-active");
          popup.remove();
          this.switchToSession(s.id);
        };
      }
    };

    render("");
    searchInput.addEventListener("input", () => render(searchInput.value));
    searchInput.focus();

    this.chatTitleEl.addClass("cfo-btn-active");

    // Dismiss on outside click or Esc, scoped to the containing window.
    // Click on the trigger pill is excluded so the trigger's own click
    // handler can toggle (mousedown fires before click, otherwise we'd
    // remove here and reopen on the click).
    const dismiss = (e: MouseEvent) => {
      if (popup.contains(e.target as Node)) return;
      if (this.chatTitleEl.contains(e.target as Node)) return;
      this.chatTitleEl.removeClass("cfo-btn-active");
      popup.remove();
      doc.removeEventListener("mousedown", dismiss, true);
      doc.removeEventListener("keydown", escDismiss, true);
    };
    const escDismiss = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        this.chatTitleEl.removeClass("cfo-btn-active");
        popup.remove();
        doc.removeEventListener("mousedown", dismiss, true);
        doc.removeEventListener("keydown", escDismiss, true);
      }
    };
    setTimeout(() => {
      doc.addEventListener("mousedown", dismiss, true);
      doc.addEventListener("keydown", escDismiss, true);
    }, 0);
  }

  private sessionLabel(s: SessionSummary): string {
    return this.plugin.settings.sessionLabels[s.id] || s.label || "(untitled)";
  }

  private beginRename(row: HTMLElement, labelEl: HTMLElement, id: string): void {
    const current = this.plugin.settings.sessionLabels[id] || labelEl.textContent || "";
    const input = document.createElement("input");
    input.type = "text";
    input.value = current;
    input.className = "cfo-history-rename-input";
    labelEl.replaceWith(input);
    input.focus();
    input.select();

    const commit = () => {
      const next = input.value.trim();
      if (next && next !== current) {
        this.plugin.settings.sessionLabels[id] = next;
        this.plugin.saveSettings();
      } else if (!next) {
        delete this.plugin.settings.sessionLabels[id];
        this.plugin.saveSettings();
      }
      const newLabel = document.createElement("div");
      newLabel.className = "cfo-history-label";
      newLabel.textContent = next || row.dataset.fallbackLabel || "(untitled)";
      input.replaceWith(newLabel);
      this.notifyRename(id);
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        const restored = document.createElement("div");
        restored.className = "cfo-history-label";
        restored.textContent = current;
        input.replaceWith(restored);
      }
      e.stopPropagation();
    });
  }

  private confirmDelete(id: string, after: () => void): void {
    const isActive = id === this.activeSessionId;
    const filePath = this.findSessionFile(id);
    if (!filePath) {
      new Notice("Session file not found.");
      return;
    }
    if (!confirm("Delete this chat? This cannot be undone.")) return;
    try {
      fs.unlinkSync(filePath);
    } catch (e: any) {
      new Notice(`Could not delete: ${e.message}`);
      return;
    }
    delete this.plugin.settings.sessionLabels[id];
    this.plugin.saveSettings();
    if (isActive) {
      this.newChat();
    }
    after();
  }

  // Refresh chat title when a rename commits.
  private notifyRename(id: string): void {
    if (id === this.activeSessionId) this.refreshChatTitle();
  }

  private switchToSession(id: string): void {
    if (this.turnBusy) {
      new Notice("Cannot switch chats while a run is in progress.");
      return;
    }
    // End the existing long-lived subprocess before switching — the
    // next chat gets its own session with its own --resume target.
    this.endSession();
    this.activeSessionId = id;
    this.pendingTitle = null;
    this.plugin.settings.activeSessionId = id;
    this.plugin.saveSettings();
    this.outputEl.empty();
    this.currentClaudeTurn = null;
    this.currentToolGroup = null;
    this.currentAssistant = null;
    this.sessionTokensUsed = 0;
    this.lastDateKey = null;
    this.renderBattery();
    this.replaySession(id);
    this.refreshChatTitle();
    this.clearStatus();
  }

  private replaySession(id: string): void {
    const filePath = this.findSessionFile(id);
    if (!filePath) return;
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      return;
    }
    let lastTokenTotal = 0;
    let pendingAssistantText = "";
    let pendingAssistantOpen = false;
    let pendingAssistantWhen: Date = new Date();
    let replayGroup: ToolGroup | null = null;

    // First pass: collect tool_use_id → result so the second-pass row
    // renderers can paint result-aware suffixes (Bash stdout tail, Glob
    // match count, error state) the same way the live path does.
    const toolResultsById = new Map<string, ToolResult>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let evt: any;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (evt.type !== "user" || !evt.message?.content) continue;
      const content = evt.message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type !== "tool_result") continue;
        const tid = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
        if (!tid) continue;
        const c = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        toolResultsById.set(tid, { content: c, isError: !!block.is_error });
      }
    }
    const cwdForReplay = this.resolveCwd();

    const flushPendingProse = () => {
      if (!pendingAssistantOpen) return;
      const text = pendingAssistantText;
      pendingAssistantText = "";
      pendingAssistantOpen = false;
      if (!text.trim()) return;
      const buf = this.startAssistantBuffer(pendingAssistantWhen);
      buf.text = text;
      this.flushAssistantRender(buf);
      // Real narration broke the run of tool calls. Close the active
      // group so the next tool_use opens a fresh one beneath the prose.
      closeReplayGroup();
    };

    const closeReplayGroup = () => {
      if (!replayGroup) return;
      replayGroup.el.removeClass("cfo-tool-group-running");
      this.updateToolGroupHeader(replayGroup);
      replayGroup = null;
    };

    const appendReplayToolRow = (name: string, input: any, toolUseId: string | null) => {
      // Build a settled group on first tool of a turn, inside the
      // current Claude turn wrapper.
      if (!replayGroup) {
        const turn = this.ensureClaudeTurn(pendingAssistantWhen);
        const el = turn.createDiv({ cls: "cfo-tool-group" });
        const headerEl = el.createDiv({ cls: "cfo-tool-group-header" });
        const chevron = headerEl.createSpan({ cls: "cfo-tool-group-chevron" });
        setIcon(chevron, "chevron-down");
        const statusEl = headerEl.createSpan({ cls: "cfo-tool-group-status", text: "Ran" });
        const bodyEl = el.createDiv({ cls: "cfo-tool-group-body" });
        replayGroup = {
          el,
          headerEl,
          bodyEl,
          statusEl,
          runningByName: new Map(),
          seenNames: [],
          loadedSkills: [],
          expanded: false,
        };
        const groupRef = replayGroup;
        headerEl.onclick = () => {
          groupRef.expanded = !groupRef.expanded;
          groupRef.el.toggleClass("cfo-tool-group-expanded", groupRef.expanded);
        };
      }

      if (!replayGroup.seenNames.includes(name)) replayGroup.seenNames.push(name);
      if (name === "Skill" && input && typeof input.skill === "string") {
        replayGroup.loadedSkills.push(input.skill);
      }
      const result = toolUseId ? toolResultsById.get(toolUseId) ?? null : null;
      const out = renderToolRow(name, input, result, { cwd: cwdForReplay, toolUseId });
      const row = replayGroup.bodyEl.createDiv({ cls: "cfo-tool-row" });
      if (result?.isError) row.addClass("cfo-tool-row-error");
      this.paintToolRow(row, out, /*withDot=*/ true);
    };

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let evt: any;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      const when = typeof evt.timestamp === "string" ? new Date(evt.timestamp) : new Date();
      if (evt.type === "user" && evt.message) {
        const content = evt.message.content;
        let userText = "";
        if (typeof content === "string") {
          userText = content;
        } else if (Array.isArray(content)) {
          // Skill-injection messages carry their tool_result block first
          // (handled separately) but the user-visible payload arrives as
          // a separate user message whose first text block starts with
          // "Base directory for this skill:". Suppress those.
          const hasOnlyToolResults = content.every((b: any) => b?.type === "tool_result");
          if (hasOnlyToolResults) continue; // already handled as tool result
          userText = content
            .filter((b: any) => b?.type === "text" && typeof b.text === "string")
            .map((b: any) => b.text)
            .join("\n");
        }
        if (!userText) continue;
        if (this.isSkillInjection(userText)) continue;
        // Any pending assistant text at the moment a user turn lands is
        // final prose from the previous turn. Flush, settle the tool
        // group, then close the Claude turn so the user block lands at
        // the top level.
        flushPendingProse();
        closeReplayGroup();
        this.appendUserBlock(userText, when);
        continue;
      }
      if (evt.type === "assistant" && evt.message?.content) {
        if (!pendingAssistantOpen) pendingAssistantWhen = when;
        for (const block of evt.message.content) {
          if (block.type === "text" && typeof block.text === "string") {
            if (!pendingAssistantOpen) pendingAssistantOpen = true;
            pendingAssistantText += block.text;
          } else if (block.type === "tool_use") {
            // Pending assistant text is plain prose narration in the
            // Claude turn. Flush it where it sits, then append the tool
            // row beneath it in stream order.
            flushPendingProse();
            appendReplayToolRow(block.name, block.input, typeof block.id === "string" ? block.id : null);
          }
        }
        const usage = evt.message.usage;
        if (usage && typeof usage === "object") {
          const turn = this.tokensFromUsage(usage);
          if (turn > lastTokenTotal) lastTokenTotal = turn;
        }
        continue;
      }
    }
    flushPendingProse();
    closeReplayGroup();
    this.closeClaudeTurn();
    if (lastTokenTotal > 0) {
      this.sessionTokensUsed = lastTokenTotal;
      this.renderBattery();
    }
  }

  newChat(): void {
    if (this.turnBusy) {
      new Notice("Cannot start a new chat while a run is in progress.");
      return;
    }
    // End the existing long-lived subprocess — new chat means new
    // session with no --resume.
    this.endSession();
    this.activeSessionId = null;
    this.plugin.settings.activeSessionId = null;
    this.pendingTitle = null;
    this.plugin.saveSettings();
    this.outputEl.empty();
    this.currentClaudeTurn = null;
    this.currentToolGroup = null;
    this.currentAssistant = null;
    this.sessionTokensUsed = 0;
    this.lastDateKey = null;
    this.renderBattery();
    this.refreshChatTitle();
    this.clearStatus();
  }

  deleteCurrentChat(): void {
    if (this.turnBusy) {
      new Notice("Cannot delete chat while a run is in progress.");
      return;
    }
    // End the existing long-lived subprocess — the chat being deleted
    // is the active one, so its session has no future.
    this.endSession();
    const id = this.activeSessionId;
    if (!id) {
      new Notice("No active chat to delete.");
      return;
    }
    const filePath = this.findSessionFile(id);
    if (filePath) {
      try {
        fs.unlinkSync(filePath);
      } catch (e: any) {
        new Notice(`Could not delete session file: ${e.message}`);
        return;
      }
    }
    this.newChat();
  }

  async saveChatToVault(): Promise<void> {
    if (this.turnBusy) {
      new Notice("Cannot save chat while a run is in progress.");
      return;
    }
    const id = this.activeSessionId;
    if (!id) {
      new Notice("No active chat to save.");
      return;
    }
    const filePath = this.findSessionFile(id);
    if (!filePath) {
      new Notice("Could not locate session file on disk.");
      return;
    }
    const exported = exportSession({
      jsonlPath: filePath,
      cwd: this.resolveCwd(),
      vaultName: this.vaultName(),
    });
    if (!exported) {
      new Notice("Could not parse session jsonl.");
      return;
    }
    const folder = this.newFileFolder();
    const targetPath = normalizePath(folder ? `${folder}/${exported.filename}` : exported.filename);
    try {
      const existing = this.app.vault.getAbstractFileByPath(targetPath);
      let file: TFile;
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, exported.body);
        file = existing;
      } else {
        file = await this.app.vault.create(targetPath, exported.body);
      }
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
      new Notice(`Saved chat to ${targetPath}`);
    } catch (e: any) {
      new Notice(`Save failed: ${e.message}`);
    }
  }

  private newFileFolder(): string {
    const cfg: any = (this.app.vault as any).getConfig?.bind(this.app.vault);
    if (!cfg) return "";
    const loc = cfg("newFileLocation");
    if (loc === "root" || !loc) return "";
    const folder = cfg("newFileFolderPath");
    if (typeof folder === "string" && folder.trim()) return folder.trim();
    return "";
  }

  private findSessionFile(id: string): string | null {
    const candidate = path.join(this.projectsRoot(), this.encodedCwd(), `${id}.jsonl`);
    return fs.existsSync(candidate) ? candidate : null;
  }

  private dateKey(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  private formatHM(d: Date): string {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  private maybeAppendDateDivider(d: Date): void {
    const key = this.dateKey(d);
    if (this.lastDateKey === key) return;
    this.lastDateKey = key;
    const divider = this.outputEl.createDiv({ cls: "cfo-date-divider" });
    const inner = divider.createSpan({ cls: "cfo-date-divider-text" });
    this.renderMarkdownInto(`[[${key}]]`, inner);
  }

  private appendUserBlock(text: string, when: Date = new Date()): void {
    this.closeClaudeTurn();
    this.maybeAppendDateDivider(when);
    const block = this.outputEl.createDiv({ cls: "cfo-message cfo-message-user" });
    const role = block.createDiv({ cls: "cfo-message-role" });
    role.createSpan({ cls: "cfo-message-role-label", text: "You" });
    role.createSpan({ cls: "cfo-message-time", text: this.formatHM(when) });
    const body = block.createDiv({ cls: "cfo-message-body" });
    this.renderMarkdownInto(text, body);
    this.bumpTrailingThinking();
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }

  /**
   * Open (or return) the wrapper for the current Claude turn. Commits
   * the CLAUDE header on first call. Every prose block, tool group, and
   * final reply for the turn appends inside this wrapper.
   */
  private ensureClaudeTurn(when: Date = new Date()): HTMLElement {
    if (this.currentClaudeTurn) return this.currentClaudeTurn;
    this.maybeAppendDateDivider(when);
    const wrapper = this.outputEl.createDiv({ cls: "cfo-turn-claude" });
    const role = wrapper.createDiv({ cls: "cfo-turn-claude-role" });
    role.createSpan({ cls: "cfo-message-role-label", text: "Claude" });
    this.currentClaudeTurn = wrapper;
    this.bumpTrailingThinking();
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
    return wrapper;
  }

  /**
   * End the current Claude turn. Settles any open tool group, clears
   * the assistant buffer pointer, and drops the wrapper reference so
   * the next agent event opens a fresh turn.
   */
  private closeClaudeTurn(): void {
    if (this.currentToolGroup) this.closeToolGroup();
    this.currentAssistant = null;
    this.currentClaudeTurn = null;
  }

  private startAssistantBuffer(when: Date = new Date()): AssistantBuffer {
    const turn = this.ensureClaudeTurn(when);
    const containerEl = turn.createDiv({ cls: "cfo-message cfo-message-assistant" });
    const bodyEl = containerEl.createDiv({ cls: "cfo-message-body" });
    this.bumpTrailingThinking();
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
    return {
      containerEl,
      bodyEl,
      text: "",
      revealedLen: 0,
      revealRaf: null,
      lastFrameAt: null,
    };
  }

  /**
   * Paced reveal. Decouples the visual stream from network arrival:
   * appends to `buf.text` happen as chunks arrive, but the rendered DOM
   * only shows characters up to `buf.revealedLen`, advanced by a steady
   * rate per animation frame. Long dumps still arrive smoothly; short
   * pauses still feel like the agent is typing.
   */
  private scheduleAssistantRender(buf: AssistantBuffer): void {
    if (buf.revealRaf != null) return;
    const tick = (now: number) => {
      buf.revealRaf = null;
      const last = buf.lastFrameAt ?? now;
      const dt = Math.max(0, now - last);
      buf.lastFrameAt = now;

      const remaining = buf.text.length - buf.revealedLen;
      if (remaining <= 0) {
        buf.lastFrameAt = null;
        return;
      }

      const rate =
        remaining > REVEAL_BURST_THRESHOLD
          ? REVEAL_BASE_CPS * REVEAL_BURST_MULTIPLIER
          : REVEAL_BASE_CPS;
      const advance = Math.max(1, Math.floor((rate * dt) / 1000));
      buf.revealedLen = Math.min(buf.text.length, buf.revealedLen + advance);

      this.renderMarkdownInto(buf.text.slice(0, buf.revealedLen), buf.bodyEl);
      this.bumpTrailingThinking();
      this.outputEl.scrollTop = this.outputEl.scrollHeight;

      if (buf.revealedLen < buf.text.length) {
        buf.revealRaf = window.requestAnimationFrame(tick);
      } else {
        buf.lastFrameAt = null;
      }
    };
    buf.revealRaf = window.requestAnimationFrame(tick);
  }

  private flushAssistantRender(buf: AssistantBuffer): void {
    if (buf.revealRaf != null) {
      window.cancelAnimationFrame(buf.revealRaf);
      buf.revealRaf = null;
    }
    buf.revealedLen = buf.text.length;
    buf.lastFrameAt = null;
    this.renderMarkdownInto(buf.text, buf.bodyEl);
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }

  private renderMarkdownInto(markdown: string, el: HTMLElement): void {
    el.empty();
    MarkdownRenderer.render(this.app, markdown, el, this.resolveCwd(), this.renderComponent);
    this.bindInternalLinks(el);
  }

  private bindInternalLinks(el: HTMLElement): void {
    const links = el.querySelectorAll("a.internal-link");
    links.forEach((node) => {
      const a = node as HTMLAnchorElement;
      const linkText = a.getAttr("href") || a.getAttr("data-href") || a.textContent || "";

      // Resolution check on every render so links flip between resolved
      // and placeholder states as the vault changes. Strip section
      // anchors and aliases before resolving — `[[Foo#bar|baz]]` resolves
      // against `Foo`. Placeholders get a class that styles them with
      // Obsidian's faint/dashed treatment so they read as "this points
      // nowhere yet" at a glance, matching the Knowledge Permaculture
      // convention of treating placeholders as intentional graph seeds.
      const linkpath = linkText.split("#")[0].split("|")[0];
      const dest = linkpath
        ? this.app.metadataCache.getFirstLinkpathDest(linkpath, "")
        : null;
      a.toggleClass("cfo-link-unresolved", !dest);

      if (a.dataset.cfoBound === "1") return;
      a.dataset.cfoBound = "1";
      a.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const newLeaf = (evt as MouseEvent).metaKey || (evt as MouseEvent).ctrlKey;
        this.app.workspace.openLinkText(linkText, this.resolveCwd(), newLeaf);
      });
      a.addEventListener("mouseover", (evt) => {
        this.app.workspace.trigger("hover-link", {
          event: evt,
          source: "claude-for-obsidian",
          hoverParent: this.renderComponent,
          targetEl: a,
          linktext: linkText,
          sourcePath: "",
        });
      });
    });

    const tags = el.querySelectorAll("a.tag");
    tags.forEach((node) => {
      const a = node as HTMLAnchorElement;
      if (a.dataset.cfoBound === "1") return;
      a.dataset.cfoBound = "1";
      const raw = a.getAttr("href") || a.textContent || "";
      const tagName = raw.replace(/^#/, "");
      a.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        this.openTagSearch(tagName);
      });
    });
  }

  private openTagSearch(tagName: string): void {
    const search: any = (this.app as any).internalPlugins?.getPluginById?.("global-search");
    const instance = search?.instance;
    if (instance?.openGlobalSearch) {
      instance.openGlobalSearch(`tag:#${tagName}`);
      return;
    }
    new Notice(`Tag: #${tagName}`);
  }

  private ensureToolGroup(): ToolGroup {
    if (this.currentToolGroup) return this.currentToolGroup;
    const turn = this.ensureClaudeTurn();
    const el = turn.createDiv({ cls: "cfo-tool-group cfo-tool-group-running" });

    const headerEl = el.createDiv({ cls: "cfo-tool-group-header" });
    const chevron = headerEl.createSpan({ cls: "cfo-tool-group-chevron" });
    setIcon(chevron, "chevron-down");
    const statusEl = headerEl.createSpan({ cls: "cfo-tool-group-status", text: "Running…" });

    const bodyEl = el.createDiv({ cls: "cfo-tool-group-body" });

    const group: ToolGroup = {
      el,
      headerEl,
      bodyEl,
      statusEl,
      runningByName: new Map(),
      seenNames: [],
      loadedSkills: [],
      expanded: false,
    };

    headerEl.onclick = () => {
      group.expanded = !group.expanded;
      group.el.toggleClass("cfo-tool-group-expanded", group.expanded);
    };

    this.currentToolGroup = group;
    this.bumpTrailingThinking();
    return group;
  }

  private updateToolGroupHeader(group: ToolGroup): void {
    const runningTotal = Array.from(group.runningByName.values()).reduce((a, b) => a + b, 0);
    if (runningTotal > 0) {
      const activeName = [...group.runningByName.entries()].find(([, n]) => n > 0)?.[0];
      const verb = activeName ? this.toolVerbForName(activeName) : "Running";
      group.statusEl.setText(`${verb}…`);
      return;
    }
    // All settled. Use original tool names (avoids past-tense lemma
    // pitfalls like Write→Writ, Run→Runn).
    const baseLabel =
      group.seenNames.length === 1
        ? `Ran ${group.seenNames[0]}`
        : `Ran ${group.seenNames.length} tools`;
    const skillTag = this.skillTagFor(group);
    group.statusEl.setText(skillTag ? `${baseLabel} ${skillTag}` : baseLabel);
  }

  private skillTagFor(group: ToolGroup): string {
    const skills = group.loadedSkills.filter((s, i, arr) => arr.indexOf(s) === i);
    if (skills.length === 0) return "";
    if (skills.length === 1) return `(loaded ${skills[0]} skill)`;
    return `(loaded ${skills.join(", ")} skills)`;
  }

  private closeToolGroup(): void {
    if (!this.currentToolGroup) return;
    this.currentToolGroup.el.removeClass("cfo-tool-group-running");
    this.updateToolGroupHeader(this.currentToolGroup);
    this.currentToolGroup = null;
  }

  private appendToolUse(id: string | null, name: string, input: any): void {
    const out = renderToolRow(name, input, null, { cwd: this.resolveCwd(), toolUseId: id });

    if (id === null) {
      // Replay path: render as a flat row outside any live group.
      const flat = this.outputEl.createDiv({ cls: "cfo-tool-row cfo-tool-row-replay" });
      this.paintToolRow(flat, out, /*withDot=*/ false);
      this.outputEl.scrollTop = this.outputEl.scrollHeight;
      return;
    }

    const group = this.ensureToolGroup();
    if (!group.seenNames.includes(name)) group.seenNames.push(name);
    group.runningByName.set(name, (group.runningByName.get(name) ?? 0) + 1);
    if (name === "Skill" && input && typeof input.skill === "string") {
      group.loadedSkills.push(input.skill);
    }

    const row = group.bodyEl.createDiv({ cls: "cfo-tool-row cfo-tool-row-running" });
    this.paintToolRow(row, out, /*withDot=*/ true);

    this.pendingTools.set(id, { el: row, startedAt: Date.now(), group, name, input });
    this.updateToolGroupHeader(group);
    this.bumpTrailingThinking();

    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }

  /**
   * Paint a RenderOutput into a tool-row element. Re-entrant: callers
   * pass an empty row first time (live tool_use, replay walk) and the
   * same row a second time when the result settles (live only) — the
   * function clears and rebuilds the row body.
   */
  private paintToolRow(row: HTMLElement, out: RenderOutput, withDot: boolean): void {
    row.empty();
    if (withDot) row.createSpan({ cls: "cfo-tool-row-dot" });

    // Literal space text nodes between adjacent spans so a copy-paste of
    // the panel preserves readable spacing. CSS margin gives the visual
    // gap; the text node gives the character a paste needs.
    if (out.flat) {
      // Trivial-edit short-circuit: no pill, no chevron.
      row.createSpan({ cls: "cfo-tool-row-name", text: out.verb });
      row.appendText(" ");
      row.createSpan({ cls: "cfo-tool-row-args", text: out.flat });
      return;
    }

    const verbEl = row.createSpan({ cls: "cfo-tool-row-name" });
    verbEl.setText(out.verb);
    if (out.verb && out.target) row.appendText(" ");
    const targetEl = row.createSpan({ cls: "cfo-tool-row-target" });
    targetEl.setText(out.target);

    // Coloured diff counts for Edit/Write. Renderer emits separate
    // addCount / delCount fields so each side can carry its own tint
    // (green for adds, red for dels) instead of a flat muted suffix.
    const hasAdd = typeof out.addCount === "number" && out.addCount > 0;
    const hasDel = typeof out.delCount === "number" && out.delCount > 0;
    if (hasAdd || hasDel) {
      row.appendText(" ");
      if (hasAdd) {
        row.createSpan({ cls: "cfo-tool-row-add-count", text: `+${out.addCount}` });
      }
      if (hasAdd && hasDel) row.appendText(" ");
      if (hasDel) {
        row.createSpan({ cls: "cfo-tool-row-del-count", text: `-${out.delCount}` });
      }
    } else if (out.suffix) {
      // Suffix renderers already prepend whitespace (" (error)",
      // " → output") inside the span, so no extra text node here.
      row.createSpan({ cls: "cfo-tool-row-suffix", text: out.suffix });
    }

    if (out.expand) {
      const chevron = row.createSpan({ cls: "cfo-tool-row-chevron" });
      setIcon(chevron, "chevron-down");
      const body = row.createDiv({ cls: "cfo-tool-row-expand" });
      let painted = false;
      let expanded = false;
      const ensurePainted = () => {
        if (!painted) {
          out.expand!(body);
          painted = true;
        }
      };
      const toggle = (e: Event) => {
        e.stopPropagation();
        expanded = !expanded;
        if (expanded) ensurePainted();
        row.toggleClass("cfo-tool-row-expanded", expanded);
      };
      chevron.onclick = toggle;
      // Clicking the row body (excluding the inner expand area) also
      // toggles, matching the tool-group header pattern.
      row.onclick = (e) => {
        if ((e.target as HTMLElement)?.closest(".cfo-tool-row-expand")) return;
        toggle(e);
      };
      // Open by default when the renderer asks (Edit / Write — diff
      // visible the moment the row lands).
      if (out.expandDefault) {
        expanded = true;
        ensurePainted();
        row.addClass("cfo-tool-row-expanded");
      }
    }
  }

  /**
   * Detect skill-injection user messages. Claude Code injects a skill
   * body into the model context as a `user` text message that follows a
   * `Skill` tool call. The body always starts with "Base directory for
   * this skill:". Suppress these from the visible chat — they're
   * mechanism, not conversation.
   */
  private isSkillInjection(text: string): boolean {
    return text.trimStart().startsWith("Base directory for this skill:");
  }

  private toolVerbForName(name: string): string {
    const verbs: Record<string, string> = {
      Read: "Reading",
      Write: "Writing",
      Edit: "Editing",
      Bash: "Running",
      Glob: "Searching",
      Grep: "Searching",
      Task: "Delegating",
      WebFetch: "Fetching",
      WebSearch: "Searching",
      ToolSearch: "Loading",
      TodoWrite: "Planning",
      NotebookEdit: "Editing",
    };
    return verbs[name] ?? name;
  }

  private settleToolResult(id: string | null, isError: boolean, content: string): void {
    if (!id) return;
    const entry = this.pendingTools.get(id);
    if (!entry) return;
    this.pendingTools.delete(id);
    const elapsed = Date.now() - entry.startedAt;
    const wait = Math.max(0, ClaudeForObsidianView.TOOL_MIN_VISIBLE_MS - elapsed);
    const settle = () => {
      entry.el.removeClass("cfo-tool-row-running");
      if (isError) entry.el.addClass("cfo-tool-row-error");
      // Re-render the row with the result in hand so suffixes (like
      // Bash's stdout tail and Glob's match count) settle in.
      const result: ToolResult = { content, isError };
      const out = renderToolRow(entry.name, entry.input, result, {
        cwd: this.resolveCwd(),
        toolUseId: id,
      });
      this.paintToolRow(entry.el, out, /*withDot=*/ true);
      // Decrement the running counter for this row's tool name. Direct
      // lookup via the stored name — no reverse-verb walk.
      const remaining = (entry.group.runningByName.get(entry.name) ?? 1) - 1;
      if (remaining <= 0) entry.group.runningByName.delete(entry.name);
      else entry.group.runningByName.set(entry.name, remaining);
      this.updateToolGroupHeader(entry.group);
    };
    if (wait === 0) settle();
    else window.setTimeout(settle, wait);
  }

  private settleAllPendingTools(): void {
    for (const entry of this.pendingTools.values()) {
      entry.el.removeClass("cfo-tool-row-running");
    }
    this.pendingTools.clear();
    if (this.currentToolGroup) {
      this.currentToolGroup.runningByName.clear();
      this.updateToolGroupHeader(this.currentToolGroup);
      this.closeToolGroup();
    }
  }

  // ---------- permission dialog ----------

  private enqueuePermissionRequest(req: {
    requestId: string;
    toolUseId: string;
    toolName: string;
    input: any;
    blockedPath?: string;
    decisionReason?: string;
  }): void {
    // Safe tools short-circuit — the PreToolUse hook fires for every
    // tool the CLI runs, but the user only wants a dialog for the ones
    // that actually mutate state or step outside the vault. Auto-allow
    // here keeps the agent fluid for reads / searches / planning while
    // still gating edits, writes, and shell commands.
    if (!this.needsPermissionDialog(req.toolName, req.input)) {
      if (this.currentSession) {
        this.currentSession.respondPermission(req.requestId, {
          behavior: "allow",
          updatedInput: req.input ?? {},
        });
      }
      return;
    }
    this.permissionQueue.push(req);
    if (!this.activePermissionRequest) {
      this.showNextPermissionRequest();
    }
  }

  /** Decide whether a tool use warrants a dialog. Mirrors the rough
   *  shape of the CLI's permission system but driven by the user's
   *  chosen mode in the bottom-nav. Reads/searches inside the vault
   *  are silent; writes, edits, and Bash always ask in default mode
   *  and stay silent in acceptEdits / bypassPermissions. */
  private needsPermissionDialog(toolName: string, input: any): boolean {
    const mode = this.plugin.settings.permissionMode;
    if (mode === "bypassPermissions") return false;

    const isWrite = toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit";
    if (isWrite) return mode !== "acceptEdits";
    if (toolName === "Bash") {
      // Match the CLI's own behaviour: safe read-only shell commands
      // (date, echo, ls, pwd, cat, git status, etc.) auto-allow. The
      // PreToolUse hook intercepts every Bash call before the CLI's
      // built-in whitelist can vote, so without this we'd dialog even
      // `date '+%H:%M:%S'`. Risky commands (rm, curl, npm install,
      // sudo, anything with shell operators or chains) still ask.
      const cmd = typeof input?.command === "string" ? input.command : "";
      if (isSafeBashCommand(cmd)) return false;
      return true;
    }
    if (toolName === "WebFetch" || toolName === "WebSearch") return mode === "default";
    if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") {
      const p =
        typeof input?.file_path === "string"
          ? input.file_path
          : typeof input?.path === "string"
            ? input.path
            : "";
      if (!p) return false;
      const cwd = this.resolveCwd();
      if (!cwd) return false;
      return !p.startsWith(cwd);
    }
    // Task / TodoWrite / Skill / ToolSearch / NotebookRead / others —
    // auto-allow. These are coordination tools, not file mutations.
    return false;
  }

  private showNextPermissionRequest(): void {
    const next = this.permissionQueue.shift();
    if (!next) {
      this.activePermissionRequest = null;
      this.hidePermissionDialog();
      return;
    }
    this.activePermissionRequest = next;
    this.paintPermissionDialog(next);
  }

  private paintPermissionDialog(req: {
    requestId: string;
    toolUseId: string;
    toolName: string;
    input: any;
    blockedPath?: string;
    decisionReason?: string;
  }): void {
    const host = this.permissionDialogEl;
    if (!host) return;
    host.empty();
    host.removeClass("cfo-permission-dialog-hidden");

    // Header: title + session badge.
    const header = host.createDiv({ cls: "cfo-permission-header" });
    header.createSpan({ cls: "cfo-permission-dot" });
    header.createSpan({
      cls: "cfo-permission-title",
      text: this.humanPermissionTitle(req.toolName, req.input),
    });
    header.createSpan({ cls: "cfo-permission-badge", text: "session" });

    // Optional explanation strip — CLI tells us why the request fired
    // (e.g. "outside working directory" with a blocked_path).
    if (req.decisionReason || req.blockedPath) {
      const reason = host.createDiv({ cls: "cfo-permission-reason" });
      if (req.decisionReason) {
        reason.createDiv({ cls: "cfo-permission-reason-text", text: req.decisionReason });
      }
      if (req.blockedPath) {
        reason.createDiv({ cls: "cfo-permission-reason-path", text: req.blockedPath });
      }
    }

    // Body: per-tool preview.
    const body = host.createDiv({ cls: "cfo-permission-body" });
    this.paintPermissionBody(req, body);

    // Footer buttons.
    const footer = host.createDiv({ cls: "cfo-permission-footer" });
    const denyBtn = footer.createEl("button", { cls: "cfo-permission-btn cfo-permission-btn-deny" });
    denyBtn.createSpan({ text: "Deny" });
    denyBtn.createSpan({ cls: "cfo-permission-chord", text: "esc" });
    denyBtn.onclick = () => this.settlePermissionRequest({ behavior: "deny", message: "User denied" });

    const spacer = footer.createDiv({ cls: "cfo-permission-spacer" });
    void spacer;

    const allowBtn = footer.createEl("button", { cls: "cfo-permission-btn cfo-permission-btn-allow" });
    allowBtn.createSpan({ text: "Allow once" });
    allowBtn.createSpan({ cls: "cfo-permission-chord", text: "⌘⏎" });
    allowBtn.onclick = () =>
      this.settlePermissionRequest({ behavior: "allow", updatedInput: req.input ?? {} });

    // Bind keyboard chords while the dialog is open. Esc denies; Cmd-Enter
    // allows. Listener attaches at the document level so it works even if
    // focus is in the textbox.
    this.bindPermissionKeys();

    // Surface to the user that a decision is pending — the panel's
    // status line picks it up.
    this.clearStatus();
    this.statusEl.setText("Waiting for permission decision…");
  }

  private paintPermissionBody(
    req: {
      toolName: string;
      input: any;
    },
    host: HTMLElement,
  ): void {
    const { toolName, input } = req;
    if (toolName === "Edit") {
      const filePath = typeof input?.file_path === "string" ? input.file_path : "";
      host.createDiv({ cls: "cfo-permission-path", text: filePath });
      const ops = lineDiff(
        typeof input?.old_string === "string" ? input.old_string : "",
        typeof input?.new_string === "string" ? input.new_string : "",
      );
      renderDiff(host, ops);
      return;
    }
    if (toolName === "Write") {
      const filePath = typeof input?.file_path === "string" ? input.file_path : "";
      const content = typeof input?.content === "string" ? input.content : "";
      host.createDiv({ cls: "cfo-permission-path", text: filePath });
      renderDiff(host, lineDiff("", content));
      return;
    }
    if (toolName === "NotebookEdit") {
      const filePath = typeof input?.notebook_path === "string" ? input.notebook_path : "";
      host.createDiv({ cls: "cfo-permission-path", text: filePath });
      return;
    }
    if (toolName === "Read") {
      const filePath = typeof input?.file_path === "string" ? input.file_path : "";
      host.createDiv({ cls: "cfo-permission-path", text: filePath });
      return;
    }
    if (toolName === "Bash") {
      const cmd = typeof input?.command === "string" ? input.command : "";
      const desc = typeof input?.description === "string" ? input.description : "";
      if (desc) host.createDiv({ cls: "cfo-permission-desc", text: desc });
      const codeEl = host.createEl("pre", { cls: "cfo-permission-code" });
      codeEl.setText(cmd);
      // Shape warnings — the spec calls out shell-style red flags worth
      // surfacing inline so the user notices before approving.
      const warnings = this.bashShapeWarnings(cmd);
      if (warnings.length > 0) {
        const warnEl = host.createDiv({ cls: "cfo-permission-warnings" });
        for (const w of warnings) {
          warnEl.createDiv({ cls: "cfo-permission-warning", text: `⚠ ${w}` });
        }
      }
      return;
    }
    if (toolName === "Glob" || toolName === "Grep") {
      const pattern = typeof input?.pattern === "string" ? input.pattern : "";
      const p = typeof input?.path === "string" ? input.path : "";
      host.createDiv({ cls: "cfo-permission-desc", text: pattern });
      if (p) host.createDiv({ cls: "cfo-permission-path", text: p });
      return;
    }
    if (toolName === "WebFetch") {
      const url = typeof input?.url === "string" ? input.url : "";
      host.createDiv({ cls: "cfo-permission-path", text: url });
      return;
    }
    if (toolName === "WebSearch") {
      const query = typeof input?.query === "string" ? input.query : "";
      host.createDiv({ cls: "cfo-permission-desc", text: query });
      return;
    }
    // Default: key:value preview.
    const pre = host.createEl("pre", { cls: "cfo-permission-code" });
    try {
      pre.setText(JSON.stringify(input ?? {}, null, 2));
    } catch {
      pre.setText(String(input ?? ""));
    }
  }

  private humanPermissionTitle(toolName: string, input: any): string {
    const basename = (p: string) => {
      if (typeof p !== "string" || !p) return "";
      const slash = p.lastIndexOf("/");
      return slash === -1 ? p : p.slice(slash + 1);
    };
    if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
      const name = basename(input?.file_path ?? input?.notebook_path ?? "");
      return name ? `Allow Claude to edit ${name}?` : "Allow Claude to edit a file?";
    }
    if (toolName === "Read") {
      const name = basename(input?.file_path ?? "");
      return name ? `Allow Claude to read ${name}?` : "Allow Claude to read a file?";
    }
    if (toolName === "Bash") return "Allow Claude to run a command?";
    if (toolName === "Glob" || toolName === "Grep") return "Allow Claude to search?";
    if (toolName === "WebFetch") return "Allow Claude to fetch from the web?";
    if (toolName === "WebSearch") return "Allow Claude to search the web?";
    return `Allow Claude to use ${toolName}?`;
  }

  private bashShapeWarnings(cmd: string): string[] {
    const warnings: string[] = [];
    if (!cmd) return warnings;
    // Backslash-escaped whitespace is a common copy-paste tell that a
    // path got smuggled in — worth flagging.
    if (/\\\s/.test(cmd)) warnings.push("Contains backslash-escaped whitespace");
    // Unbalanced single or double quotes.
    const singles = (cmd.match(/(?<!\\)'/g) ?? []).length;
    const doubles = (cmd.match(/(?<!\\)"/g) ?? []).length;
    if (singles % 2 !== 0) warnings.push("Unbalanced single quotes");
    if (doubles % 2 !== 0) warnings.push("Unbalanced double quotes");
    // Common destructive patterns.
    if (/\brm\s+-rf?\s+\/\b/.test(cmd) || /\brm\s+-rf?\s+~\/?/.test(cmd))
      warnings.push("Recursive rm targets a root or home path");
    return warnings;
  }

  private settlePermissionRequest(decision: PermissionDecision): void {
    const active = this.activePermissionRequest;
    if (!active) return;
    this.activePermissionRequest = null;
    if (this.currentSession) {
      this.currentSession.respondPermission(active.requestId, decision);
    }
    this.unbindPermissionKeys();
    this.clearStatus();
    // Show next queued, or hide.
    this.showNextPermissionRequest();
  }

  private hidePermissionDialog(): void {
    if (!this.permissionDialogEl) return;
    this.permissionDialogEl.empty();
    this.permissionDialogEl.addClass("cfo-permission-dialog-hidden");
    this.unbindPermissionKeys();
  }

  private bindPermissionKeys(): void {
    this.unbindPermissionKeys();
    const handler = (e: KeyboardEvent) => {
      if (!this.activePermissionRequest) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.settlePermissionRequest({ behavior: "deny", message: "User denied" });
        return;
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        const input = this.activePermissionRequest.input ?? {};
        this.settlePermissionRequest({ behavior: "allow", updatedInput: input });
        return;
      }
    };
    this.permissionKeyHandler = handler;
    // Capture phase so we win over the textbox listeners.
    document.addEventListener("keydown", handler, true);
  }

  private unbindPermissionKeys(): void {
    if (this.permissionKeyHandler) {
      document.removeEventListener("keydown", this.permissionKeyHandler, true);
      this.permissionKeyHandler = null;
    }
  }

  private send(): void {
    const prompt = this.inputEl.value.trim();
    if (!prompt) return;
    if (this.turnBusy) {
      new Notice("A run is already in progress.");
      return;
    }

    const cwd = this.resolveCwd();
    if (!cwd) {
      new Notice("Claude for Obsidian: could not resolve vault path.");
      this.statusEl.setText("Error: no vault path.");
      return;
    }

    this.appendUserBlock(prompt);
    if (!this.activeSessionId) {
      this.pendingTitle = prompt;
      this.refreshChatTitle();
    }
    this.inputEl.value = "";
    this.autosizeInput();
    this.currentAssistant = null;
    this.setBusy(true);
    this.setThinking(true);
    this.turnBusy = true;

    // Lazily create the long-lived session on the first message for
    // this chat. Subsequent messages reuse the same subprocess — that
    // keeps in-memory state (cron schedulers, watchers) alive across
    // turns, which is the whole point of v0.6.0.
    if (!this.currentSession) {
      // Stale activeSessionId guard. The CLI exits with code 1 and
      // `result.subtype = error_during_execution` if --resume points
      // at a jsonl that no longer exists on disk (CLI session cleanup,
      // jsonl manually deleted, etc.). Validate before spawn and drop
      // the id if the session file is gone — the spawn then proceeds
      // as a fresh session.
      let resumeId = this.activeSessionId;
      if (resumeId && !this.findSessionFile(resumeId)) {
        new Notice("Previous session not found; starting fresh.");
        this.activeSessionId = null;
        this.plugin.settings.activeSessionId = null;
        this.plugin.saveSettings();
        resumeId = null;
      }
      this.currentSession = new ClaudeSession({
        cwd,
        settings: this.plugin.settings,
        resumeSessionId: resumeId,
        onEvent: (e) => this.handleEvent(e),
      });
    }
    this.currentSession.sendMessage(prompt);
  }

  private cancel(): void {
    if (this.currentSession && this.turnBusy) {
      // Interrupt control_request — subprocess stays alive, the CLI
      // stops the in-flight model call and emits a result event. The
      // user can immediately send another message in this chat.
      this.currentSession.cancel();
      this.statusEl.setText("Cancelling…");
    }
  }

  /** End the long-lived subprocess for this chat. Used on chat switch,
   *  new chat, delete-active-chat, panel close. */
  private endSession(): void {
    if (this.currentSession) {
      this.currentSession.end();
      this.currentSession = null;
    }
    this.turnBusy = false;
  }

  private setBusy(busy: boolean): void {
    this.sendStopBtn.empty();
    setIcon(this.sendStopBtn, busy ? "square" : "corner-down-left");
    this.sendStopBtn.title = busy ? "Stop (Esc)" : "Send (Enter)";
    this.sendStopBtn.toggleClass("cfo-send-inline-busy", busy);
    if (!busy) this.setThinking(false);
  }

  private clearStatus(): void {
    if (!this.statusEl) return;
    this.statusEl.empty();
    this.statusEl.removeClass("cfo-status-thinking");
  }

  /**
   * Show or hide the trailing thinking indicator. The indicator lives
   * in the chat stream as the last child of outputEl, trailing whatever
   * the agent emitted most recently (assistant text buffer, tool group,
   * tool row). On every new emission, callers run `bumpTrailingThinking`
   * to push it back to the bottom.
   */
  private setThinking(thinking: boolean): void {
    if (!thinking) {
      this.stopTrailingThinking();
      return;
    }
    this.startTrailingThinking();
  }

  private startTrailingThinking(): void {
    if (this.trailingThinkingTimer != null) return;
    if (!this.trailingThinkingEl) {
      this.trailingThinkingEl = this.outputEl.createDiv({ cls: "cfo-trailing-thinking" });
    } else {
      this.bumpTrailingThinking();
    }
    this.renderTrailingThinkingFrame();
    this.trailingThinkingTimer = window.setInterval(
      () => this.renderTrailingThinkingFrame(),
      THINKING_ROTATE_MS,
    );
  }

  private stopTrailingThinking(): void {
    if (this.trailingThinkingTimer != null) {
      window.clearInterval(this.trailingThinkingTimer);
      this.trailingThinkingTimer = null;
    }
    if (this.trailingThinkingEl) {
      this.trailingThinkingEl.remove();
      this.trailingThinkingEl = null;
    }
  }

  private renderTrailingThinkingFrame(): void {
    if (!this.trailingThinkingEl) return;
    const verb = THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)];
    this.trailingThinkingEl.empty();
    const dots = this.trailingThinkingEl.createSpan({ cls: "cfo-thinking-dots" });
    dots.createSpan({ cls: "cfo-thinking-dot" });
    dots.createSpan({ cls: "cfo-thinking-dot" });
    dots.createSpan({ cls: "cfo-thinking-dot" });
    this.trailingThinkingEl.createSpan({ cls: "cfo-thinking-label", text: verb });
  }

  /**
   * Re-attach the trailing thinking indicator as the last child of
   * outputEl so it always sits below the most recently emitted block.
   */
  private bumpTrailingThinking(): void {
    if (!this.trailingThinkingEl) return;
    this.outputEl.appendChild(this.trailingThinkingEl);
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }

  private tokensFromUsage(usage: any): number {
    if (!usage || typeof usage !== "object") return 0;
    // Context-window usage for a single turn is the total input sent
    // to the API for that turn: uncached input + cache-write tokens +
    // cache-read tokens. Output is NOT included — it's the response,
    // not part of the current turn's input. Output rolls into the
    // next turn's input automatically via the cache prefix, so adding
    // it here would double-count and the meter would drop to zero in
    // ~10 turns even on a 1M context window (the v0.6.0 §08:11 bug).
    const input = Number(usage.input_tokens) || 0;
    const cacheCreate = Number(usage.cache_creation_input_tokens) || 0;
    const cacheRead = Number(usage.cache_read_input_tokens) || 0;
    return input + cacheCreate + cacheRead;
  }

  private renderBattery(): void {
    if (!this.batteryEl) return;
    const window = contextWindowForModel(this.plugin.settings.model);
    const used = this.sessionTokensUsed;
    const remaining = Math.max(0, window - used);
    const remainingPct = Math.max(0, Math.min(100, Math.round((remaining / window) * 100)));

    // SVG ring: 16px box, stroke 2.5, drains clockwise from full.
    const size = 16;
    const stroke = 2.5;
    const r = (size - stroke) / 2;
    const cx = size / 2;
    const cy = size / 2;
    const circumference = 2 * Math.PI * r;
    const dash = (remainingPct / 100) * circumference;
    const gap = circumference - dash;

    let tone = "full";
    if (remainingPct <= 10) tone = "urgent";
    else if (remainingPct <= 30) tone = "warning";
    else if (remainingPct <= 50) tone = "low";

    this.batteryEl.empty();
    this.batteryEl.removeClass("cfo-battery-low");
    this.batteryEl.removeClass("cfo-battery-warning");
    this.batteryEl.removeClass("cfo-battery-urgent");
    if (tone === "low") this.batteryEl.addClass("cfo-battery-low");
    else if (tone === "warning") this.batteryEl.addClass("cfo-battery-warning");
    else if (tone === "urgent") this.batteryEl.addClass("cfo-battery-urgent");

    this.batteryEl.title = `${remainingPct}% context remaining. Click for plan usage.`;

    const ns = "http://www.w3.org/2000/svg";
    const svg = this.batteryEl.createSvg("svg", {
      attr: {
        width: String(size),
        height: String(size),
        viewBox: `0 0 ${size} ${size}`,
      },
    });
    // Track
    svg.createSvg("circle", {
      attr: {
        cx: String(cx),
        cy: String(cy),
        r: String(r),
        fill: "none",
        stroke: "var(--background-modifier-border)",
        "stroke-width": String(stroke),
      },
    });
    // Drain ring
    const ring = svg.createSvg("circle", {
      attr: {
        cx: String(cx),
        cy: String(cy),
        r: String(r),
        fill: "none",
        "stroke-width": String(stroke),
        "stroke-linecap": "round",
        "stroke-dasharray": `${dash} ${gap}`,
        transform: `rotate(-90 ${cx} ${cy})`,
      },
    });
    ring.addClass("cfo-battery-ring");
    void ns;
  }

  /**
   * Render the edits-picker label from the current `permissionMode`,
   * pulling the human label from `MODE_OPTIONS`.
   */
  private refreshEditsBtn(): void {
    if (!this.editsBtn) return;
    this.editsBtn.empty();
    const mode = this.plugin.settings.permissionMode;
    const opt = MODE_OPTIONS.find((m) => m.id === mode);
    const label = opt?.label ?? mode;
    this.editsBtn.createSpan({ cls: "cfo-edits-btn-label", text: label });
    const chevron = this.editsBtn.createSpan({ cls: "cfo-edits-btn-chevron" });
    setIcon(chevron, "chevron-down");
    this.editsBtn.title = `Permission mode: ${label}. Click to change.`;
  }

  private toggleModePopup(): void {
    const existing = this.containerEl.ownerDocument.querySelector(".cfo-mode-popup");
    if (existing) {
      this.editsBtn.removeClass("cfo-btn-active");
      existing.remove();
      return;
    }
    this.openModePopup();
  }

  private openModePopup(): void {
    const doc = this.containerEl.ownerDocument;
    const win = doc.defaultView!;
    doc.querySelectorAll(".cfo-mode-popup").forEach((el) => el.remove());
    const popup = doc.body.createDiv({ cls: "cfo-mode-popup" });
    const rect = this.editsBtn.getBoundingClientRect();
    popup.style.bottom = `${win.innerHeight - rect.top + 6}px`;
    popup.style.left = `${Math.max(8, rect.left)}px`;

    popup.createDiv({ cls: "cfo-mode-popup-section-label", text: "Mode" });
    for (const m of MODE_OPTIONS) {
      const row = popup.createDiv({ cls: "cfo-mode-popup-row" });
      if (this.plugin.settings.permissionMode === m.id) row.addClass("cfo-mode-popup-row-active");
      row.createSpan({ cls: "cfo-mode-popup-row-label", text: m.label });
      if (this.plugin.settings.permissionMode === m.id) {
        const check = row.createSpan({ cls: "cfo-mode-popup-check" });
        setIcon(check, "check");
      }
      row.onclick = async (e) => {
        e.stopPropagation();
        this.plugin.settings.permissionMode = m.id as PermissionMode;
        await this.plugin.saveSettings();
        this.refreshEditsBtn();
        this.editsBtn.removeClass("cfo-btn-active");
        popup.remove();
      };
    }

    // Clamp left so the popup doesn't overflow the right edge.
    const margin = 8;
    const maxLeft = win.innerWidth - popup.offsetWidth - margin;
    if (popup.offsetLeft > maxLeft) {
      popup.style.left = `${Math.max(margin, maxLeft)}px`;
    }

    this.editsBtn.addClass("cfo-btn-active");

    const dismiss = (e: MouseEvent) => {
      if (popup.contains(e.target as Node)) return;
      if (this.editsBtn.contains(e.target as Node)) return;
      this.editsBtn.removeClass("cfo-btn-active");
      popup.remove();
      doc.removeEventListener("mousedown", dismiss, true);
      doc.removeEventListener("keydown", esc, true);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        this.editsBtn.removeClass("cfo-btn-active");
        popup.remove();
        doc.removeEventListener("mousedown", dismiss, true);
        doc.removeEventListener("keydown", esc, true);
      }
    };
    setTimeout(() => {
      doc.addEventListener("mousedown", dismiss, true);
      doc.addEventListener("keydown", esc, true);
    }, 0);
  }

  private refreshModelBtn(): void {
    if (!this.modelBtn) return;
    this.modelBtn.empty();
    // When settings.model is empty the CLI picks its own default; fall
    // back to the first MODEL_OPTIONS entry for the button label so the
    // user sees something sensible rather than nothing.
    const modelId = this.plugin.settings.model || MODEL_OPTIONS[0].id;
    const model = MODEL_OPTIONS.find((m) => m.id === modelId) ?? MODEL_OPTIONS[0];
    const effortId = this.plugin.settings.effort;
    const effort = EFFORT_OPTIONS.find((e) => e.id === effortId) ?? EFFORT_OPTIONS[2];

    const inner = this.modelBtn.createSpan({ cls: "cfo-model-btn-inner" });
    inner.createSpan({ cls: "cfo-model-btn-name", text: model.label });
    if (model.sublabel) {
      inner.createSpan({
        cls: model.legacy ? "cfo-model-btn-sub-legacy" : "cfo-model-btn-sub",
        text: model.sublabel,
      });
    }
    inner.createSpan({ cls: "cfo-model-btn-sep", text: "·" });
    inner.createSpan({ cls: "cfo-model-btn-effort", text: effort.label });
  }

  private toggleModelMenu(): void {
    const existing = this.containerEl.ownerDocument.querySelector(".cfo-model-popup");
    if (existing) {
      this.modelBtn.removeClass("cfo-btn-active");
      existing.remove();
      return;
    }
    this.openModelMenu();
  }

  private openModelMenu(): void {
    openModelPopup({
      settings: this.plugin.settings,
      triggerEl: this.modelBtn,
      onModelChange: async (id) => {
        this.plugin.settings.model = id;
        await this.plugin.saveSettings();
        this.refreshModelBtn();
        // Context window may have changed (1M ↔ 200k). Recalibrate
        // the battery immediately so the user sees the new ceiling.
        this.renderBattery();
      },
      onEffortChange: async (effort) => {
        this.plugin.settings.effort = effort;
        await this.plugin.saveSettings();
        this.refreshModelBtn();
      },
    });
  }

  private togglePlusMenu(triggerEl: HTMLElement): void {
    const existing = this.containerEl.ownerDocument.querySelector(".cfo-plus-menu");
    if (existing) {
      triggerEl.removeClass("cfo-btn-active");
      existing.remove();
      return;
    }
    this.openPlusMenu(triggerEl);
  }

  private openPlusMenu(triggerEl: HTMLElement): void {
    const doc = this.containerEl.ownerDocument;
    const win = doc.defaultView!;
    doc.querySelectorAll(".cfo-plus-menu").forEach((el) => el.remove());
    const popup = doc.body.createDiv({ cls: "cfo-plus-menu" });
    const rect = triggerEl.getBoundingClientRect();
    popup.style.bottom = `${win.innerHeight - rect.top + 6}px`;
    popup.style.left = `${Math.max(8, rect.left)}px`;

    type Row = { icon: string; label: string; comingSoon: string };
    const rows: Row[] = [
      { icon: "paperclip", label: "Add files or photos", comingSoon: "Attach files. Coming soon." },
      { icon: "folder", label: "Add folder", comingSoon: "Attach a folder. Coming soon." },
      { icon: "slash", label: "Slash commands", comingSoon: "Slash commands like /compact and /help, plus your installed skills. Coming soon." },
    ];
    for (const r of rows) {
      const row = popup.createDiv({ cls: "cfo-plus-menu-row" });
      const iconEl = row.createSpan({ cls: "cfo-plus-menu-icon" });
      setIcon(iconEl, r.icon);
      row.createSpan({ cls: "cfo-plus-menu-label", text: r.label });
      row.onclick = (e) => {
        e.stopPropagation();
        triggerEl.removeClass("cfo-btn-active");
        popup.remove();
        new Notice(r.comingSoon);
      };
    }

    // Clamp left so the popup doesn't overflow the right edge.
    const margin = 8;
    const maxLeft = win.innerWidth - popup.offsetWidth - margin;
    if (popup.offsetLeft > maxLeft) {
      popup.style.left = `${Math.max(margin, maxLeft)}px`;
    }

    triggerEl.addClass("cfo-btn-active");

    const dismiss = (e: MouseEvent) => {
      if (popup.contains(e.target as Node)) return;
      if (triggerEl.contains(e.target as Node)) return;
      triggerEl.removeClass("cfo-btn-active");
      popup.remove();
      doc.removeEventListener("mousedown", dismiss, true);
      doc.removeEventListener("keydown", esc, true);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        triggerEl.removeClass("cfo-btn-active");
        popup.remove();
        doc.removeEventListener("mousedown", dismiss, true);
        doc.removeEventListener("keydown", esc, true);
      }
    };
    setTimeout(() => {
      doc.addEventListener("mousedown", dismiss, true);
      doc.addEventListener("keydown", esc, true);
    }, 0);
  }

  private togglePlanUsagePopup(): void {
    this.toggleInfoPopup(
      this.batteryEl,
      "Plan usage",
      "Coming soon. The CLI doesn't expose plan usage yet.",
    );
  }

  /**
   * Toggle a small info popup anchored above the given trigger element.
   * Same contract as the plan-usage popup: click trigger to open, click
   * trigger again to close, click outside to dismiss. Used by the
   * battery (plan usage) and the bottom-nav placeholder buttons.
   */
  private toggleInfoPopup(triggerEl: HTMLElement, title: string, body: string): void {
    const existing = this.containerEl.ownerDocument.querySelector(
      ".cfo-plan-popup",
    ) as HTMLElement | null;
    if (existing) {
      const prevTrigger = (existing as any).cfoTriggerEl as HTMLElement | undefined;
      if (prevTrigger) prevTrigger.removeClass("cfo-btn-active");
      existing.remove();
      return;
    }
    this.openInfoPopup(triggerEl, title, body);
  }

  private openInfoPopup(triggerEl: HTMLElement, title: string, body: string): void {
    const doc = this.containerEl.ownerDocument;
    const win = doc.defaultView!;
    doc.querySelectorAll(".cfo-plan-popup").forEach((el) => el.remove());
    const popup = doc.body.createDiv({ cls: "cfo-plan-popup" });
    // Stash the trigger so toggleInfoPopup() can clean up its active
    // class even when the trigger isn't in scope at close time.
    (popup as any).cfoTriggerEl = triggerEl;
    const rect = triggerEl.getBoundingClientRect();
    popup.style.bottom = `${win.innerHeight - rect.top + 6}px`;
    // Anchor by left edge first, then clamp to viewport so a narrow
    // panel near the right edge doesn't overflow the screen.
    popup.style.left = "0px";
    popup.createDiv({ cls: "cfo-plan-popup-title", text: title });
    popup.createDiv({ cls: "cfo-plan-popup-body", text: body });
    // Now we know the popup's actual width — clamp.
    const margin = 8;
    const desiredLeft = rect.left;
    const maxLeft = win.innerWidth - popup.offsetWidth - margin;
    const clamped = Math.max(margin, Math.min(desiredLeft, maxLeft));
    popup.style.left = `${clamped}px`;

    triggerEl.addClass("cfo-btn-active");

    const dismiss = (e: MouseEvent) => {
      // Click inside popup → leave alone. Click on trigger → let the
      // trigger's click handler toggle (don't pre-empt by removing here,
      // because mousedown fires before click and we'd just re-open).
      if (popup.contains(e.target as Node)) return;
      if (triggerEl.contains(e.target as Node)) return;
      triggerEl.removeClass("cfo-btn-active");
      popup.remove();
      doc.removeEventListener("mousedown", dismiss, true);
    };
    setTimeout(() => doc.addEventListener("mousedown", dismiss, true), 0);
  }

  private formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  private toggleSendStop(): void {
    if (this.turnBusy) {
      this.cancel();
    } else {
      this.send();
    }
  }

  private handleEvent(e: StreamEvent): void {
    switch (e.kind) {
      case "system": {
        const sid = e.raw.session_id ?? null;
        if (!sid) break;
        this.activeSessionId = sid;
        this.plugin.settings.activeSessionId = sid;
        this.plugin.saveSettings();
        this.refreshChatTitle();
        break;
      }
      case "assistant-text":
        // First text event after a tool group closes the group.
        if (this.currentToolGroup) this.closeToolGroup();
        if (!this.currentAssistant) {
          this.currentAssistant = this.startAssistantBuffer();
        }
        this.currentAssistant.text += e.text;
        this.scheduleAssistantRender(this.currentAssistant);
        break;
      case "tool-use":
        // Whatever assistant text was in flight is plain prose narration
        // inside the current Claude turn. Lock it in where it sits — the
        // tool group will append below it in stream order.
        if (this.currentAssistant) {
          this.flushAssistantRender(this.currentAssistant);
        }
        this.currentAssistant = null;
        this.appendToolUse(e.id, e.name, e.input);
        break;
      case "permission-request":
        this.enqueuePermissionRequest(e);
        break;
      case "tool-result":
        this.settleToolResult(e.toolUseId, e.isError, e.content);
        if (e.isError) {
          this.clearStatus();
          this.statusEl.setText(`Tool error.`);
        }
        // Don't bring the textbox-anchored thinking indicator back —
        // the tool group hosts its own inline indicator while it's open.
        // It'll keep cycling until the next assistant-text or tool-use.
        break;
      case "result": {
        const turnTokens = this.tokensFromUsage(e.raw.usage);
        if (turnTokens > 0) {
          this.sessionTokensUsed = Math.max(this.sessionTokensUsed, turnTokens);
          this.renderBattery();
        }
        // Turn landed. UNLIKE the per-turn architecture (≤ v0.5.1) the
        // subprocess stays alive for the next user message in this chat.
        // Just flip UI state — the session is now idle, ready for the
        // next sendMessage. Flush any in-flight assistant prose,
        // settle pending tools, drop the thinking indicator, ungrey
        // the send button.
        if (this.currentAssistant) this.flushAssistantRender(this.currentAssistant);
        this.currentAssistant = null;
        this.settleAllPendingTools();
        this.turnBusy = false;
        this.setBusy(false);
        this.setThinking(false);
        break;
      }
      case "stderr":
        this.lastStderr = e.line;
        break;
      case "error":
        new Notice(`Claude for Obsidian: ${e.message}`);
        this.clearStatus();
        this.statusEl.setText(`Error: ${e.message}`);
        break;
      case "exit": {
        const hadOutput = !!this.currentAssistant;
        if (this.currentAssistant) this.flushAssistantRender(this.currentAssistant);
        // Subprocess gone — session ended (clean) or died (unexpected).
        // Either way the chat needs a fresh session next time the user
        // sends. Null currentSession; next send() will lazy-create.
        this.currentSession = null;
        this.turnBusy = false;
        this.currentAssistant = null;
        this.settleAllPendingTools();
        // Any open permission dialog is now orphaned. Drop the queue
        // and hide the dialog rather than leaving a UI surface pointing
        // at a dead pipe.
        this.permissionQueue = [];
        this.activePermissionRequest = null;
        this.hidePermissionDialog();
        this.setBusy(false);
        if (e.code !== 0 && e.code !== null && !hadOutput) {
          const detail = this.lastStderr ? ` ${this.lastStderr.slice(0, 200)}` : "";
          new Notice(`Claude for Obsidian exited (${e.code}).${detail}`);
        }
        this.lastStderr = null;
        break;
      }
    }
  }
}
