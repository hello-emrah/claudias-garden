import { ItemView, WorkspaceLeaf, Notice, MarkdownRenderer, Component, TFile, Modal, App, normalizePath, setIcon } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import { ClaudeSession, StreamEvent, PermissionDecision, ContextUsageResponse } from "./claude-client";
import { lineDiff, renderDiff } from "./diff";
import { exportSession } from "./chat-export";
import { WikilinkSuggest } from "./wikilink-suggest";
import { SlashSuggest, SlashCommand } from "./slash-suggest";
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

export const CLAUDIAS_GARDEN_VIEW = "claudias-garden-view";

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

// Walk a session jsonl looking for the first user-prompt text. Handles
// both shapes: legacy `message.content: string` (typical CFOB-sent
// prompts) and modern `message.content: [{type: "text", text: "..."}, ...]`
// blocks (VS Code, and the newer CLI session format). Returns null
// when no user text exists in the first 50 lines — that's the prune
// signal for "truly empty" chats.
function extractFirstUserText(filePath: string): string | null {
  let lines: string[];
  try {
    lines = fs.readFileSync(filePath, "utf8").split("\n").slice(0, 50);
  } catch {
    return null;
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt.type !== "user") continue;
    const content = evt.message?.content;
    if (typeof content === "string") {
      const trimmed = content.trim();
      if (trimmed) return trimmed;
      continue;
    }
    if (Array.isArray(content)) {
      // Skip tool_result-only payloads (the model is replying to a
      // tool call, not the user prompting). Real user prompts carry
      // at least one text block.
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string") {
          const trimmed = block.text.trim();
          if (trimmed) return trimmed;
        }
      }
    }
  }
  return null;
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

/**
 * Confirmation modal shown the first time a user picks
 * `Bypass permissions` mode in this vault. Matches the native Claude
 * Code CLI's "Bypass all permissions?" dialog — title, warning copy,
 * workspace path, footer note about not asking again, and a primary
 * `Bypass permissions` button paired with a Cancel.
 *
 * Returns a Promise<boolean>: true if the user confirmed, false on
 * cancel / Esc / outside click.
 */
export class BypassConfirmModal extends Modal {
  private resolver?: (v: boolean) => void;
  private settled = false;

  constructor(app: App, private workspacePath: string) {
    super(app);
  }

  /** Open the modal and resolve when the user picks a button or
   *  dismisses. Await this from the caller. */
  prompt(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    this.modalEl.addClass("cfo-bypass-modal");
    titleEl.setText("Bypass all permissions?");

    contentEl.empty();
    contentEl.createEl("p", {
      cls: "cfo-bypass-body",
      text: "Claude will read, edit, and execute files without asking — including potentially destructive commands. Only use this in isolated or disposable environments.",
    });
    contentEl.createDiv({ cls: "cfo-bypass-path", text: this.workspacePath });
    contentEl.createDiv({
      cls: "cfo-bypass-footnote",
      text: "You won't be asked again for this workspace.",
    });

    const footer = contentEl.createDiv({ cls: "cfo-bypass-footer" });
    const cancelBtn = footer.createEl("button", { cls: "cfo-bypass-btn" });
    cancelBtn.setText("Cancel");
    cancelBtn.onclick = () => {
      this.settle(false);
    };

    const okBtn = footer.createEl("button", {
      cls: "cfo-bypass-btn cfo-bypass-btn-primary mod-cta",
    });
    okBtn.setText("Bypass permissions");
    okBtn.onclick = () => {
      this.settle(true);
    };

    // Focus the cancel button by default — destructive primary should
    // require an explicit click rather than a stray Enter.
    setTimeout(() => cancelBtn.focus(), 0);
  }

  onClose(): void {
    // Settle as false on any close path we didn't explicitly handle
    // (Esc, outside-click, programmatic close). Idempotent via the
    // settled flag.
    this.settle(false);
    this.contentEl.empty();
  }

  private settle(result: boolean): void {
    if (this.settled) return;
    this.settled = true;
    if (this.resolver) this.resolver(result);
    this.close();
  }
}

/**
 * Bash safety override — returns true if the command must always
 * dialog regardless of any user allow-rule. Mirrors the native CLI's
 * `bashMissKind` taxonomy (shell-operators, cd-compounds, find
 * dangerous flags, leading sudo). User allow-rules should never be
 * able to auto-allow these patterns; pre-approving `Bash(git *)`
 * shouldn't bypass safety for `cd /tmp && git status`.
 */
function hasBashSafetyOverride(command: string): boolean {
  if (!command || typeof command !== "string") return false;
  const trimmed = command.trim();
  if (!trimmed) return false;
  // Shell operators — chains, redirects, subshells, command groups.
  if (/[><|;&`$()]/.test(trimmed)) return true;
  // Leading sudo.
  if (/^sudo\b/.test(trimmed)) return true;
  // find with delete/exec/exec-dir/ok/ok-dir — can execute arbitrary
  // commands or destroy files outside the safe read pattern.
  if (/^find\b/.test(trimmed) && /\s-(delete|exec|execdir|ok|okdir)\b/.test(trimmed)) return true;
  return false;
}

/**
 * Whitelist check — true if the command's head token is in the
 * known-safe set (or a read-only git subcommand). Assumes the caller
 * already ran the safety-override check first; this function does NOT
 * re-check operators / sudo / find dangerous flags.
 */
function isSafeBashCommand(command: string): boolean {
  if (!command || typeof command !== "string") return false;
  const trimmed = command.trim();
  if (!trimmed) return false;
  // Defence-in-depth: if a caller forgot the override check, still
  // reject here. The override is the load-bearing gate.
  if (hasBashSafetyOverride(trimmed)) return false;
  const head = trimmed.split(/\s+/)[0];
  if (head === "git") {
    const sub = trimmed.split(/\s+/)[1];
    if (!sub) return false;
    if (sub === "config") return /\s--(get|list|get-all|get-regexp)\b/.test(trimmed);
    return GIT_SAFE_SUBCOMMANDS.has(sub);
  }
  return BASH_SAFE_COMMANDS.has(head);
}

/**
 * One user-set rule from the permission dialog's "Allow always" menu.
 * Lives in memory for the lifetime of a chat — cleared on chat
 * switch / new chat / panel close. The rule format mirrors native:
 * `pattern` is the parenthesised specifier or null for "tool-wide".
 */
interface AllowRule {
  toolName: string;
  pattern: string | null;
  // The exact rule string as it'd appear on disk in native settings,
  // e.g. "Bash(git *)" or "Edit". Used for display and de-duplication.
  display: string;
}

/**
 * Generate the three rule suggestions ("this", "some", "all") the
 * "Allow always" menu offers for a given tool call. The rule's
 * `pattern` carries the FULL path / command for matching; the
 * `display` is the user-facing label that gets shortened to the
 * vault-relative form when the path lives inside the cwd. Returns a
 * de-duplicated list — single-word Bash commands collapse to fewer
 * scopes naturally.
 */
function generateRuleSuggestions(
  toolName: string,
  input: any,
  cwd?: string | null,
): Array<{ rule: AllowRule; scope: "this" | "some" | "all" }> {
  const suggestions: Array<{ rule: AllowRule; scope: "this" | "some" | "all" }> = [];
  const relativize = (p: string): string => {
    if (cwd && p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
    if (cwd && p === cwd) return ".";
    return p;
  };
  const push = (
    pattern: string | null,
    scope: "this" | "some" | "all",
    displayPattern?: string,
  ) => {
    const realDisplayPattern = displayPattern ?? pattern;
    const display =
      pattern === null
        ? toolName
        : `${toolName}(${realDisplayPattern})`;
    if (suggestions.some((s) => s.rule.display === display)) return;
    suggestions.push({ rule: { toolName, pattern, display }, scope });
  };

  if (toolName === "Bash") {
    const cmd = typeof input?.command === "string" ? input.command.trim() : "";
    if (cmd) {
      const head = cmd.split(/\s+/)[0];
      push(cmd, "this");
      if (head) push(`${head} *`, "some");
    }
    push(null, "all");
    return suggestions;
  }

  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
    const filePath =
      typeof input?.file_path === "string"
        ? input.file_path
        : typeof input?.notebook_path === "string"
          ? input.notebook_path
          : "";
    if (filePath) {
      push(filePath, "this", relativize(filePath));
      const slash = filePath.lastIndexOf("/");
      if (slash > 0) {
        const folder = filePath.slice(0, slash);
        const folderRel = relativize(folder);
        push(`${folder}/**`, "some", `${folderRel === "." ? "" : folderRel + "/"}**`);
      }
    }
    push(null, "all");
    return suggestions;
  }

  if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") {
    const p = typeof input?.file_path === "string" ? input.file_path
      : typeof input?.path === "string" ? input.path : "";
    if (p) {
      push(p, "this", relativize(p));
      const slash = p.lastIndexOf("/");
      if (slash > 0) {
        const folder = p.slice(0, slash);
        const folderRel = relativize(folder);
        push(`${folder}/**`, "some", `${folderRel === "." ? "" : folderRel + "/"}**`);
      }
    }
    push(null, "all");
    return suggestions;
  }

  if (toolName === "WebFetch") {
    const url = typeof input?.url === "string" ? input.url : "";
    if (url) {
      push(url, "this");
      try {
        const u = new URL(url);
        push(`${u.protocol}//${u.host}/*`, "some");
      } catch {
        // not a parseable URL — skip the host scope
      }
    }
    push(null, "all");
    return suggestions;
  }

  // Default: just tool-wide.
  push(null, "all");
  return suggestions;
}

/** Short noun phrase describing what each scope grants, for the
 *  popup row's secondary line. Kept tight — no path duplication. */
function scopeDescription(scope: "this" | "some" | "all", toolName: string): string {
  if (scope === "this") {
    if (toolName === "Bash") return "this exact command";
    if (toolName === "WebFetch" || toolName === "WebSearch") return "this exact URL";
    return "this exact path";
  }
  if (scope === "some") {
    if (toolName === "Bash") return "any command with this prefix";
    if (toolName === "WebFetch") return "any URL on this host";
    return "anything in this folder";
  }
  // all
  if (toolName === "Bash") return "any shell command";
  if (toolName === "WebFetch") return "any web fetch";
  if (toolName === "WebSearch") return "any web search";
  return `any ${toolName.toLowerCase()}`;
}

/**
 * Match a tool call against the session's user-set rules. Returns
 * true if any rule matches the call's input. Caller is responsible
 * for running the safety-override check FIRST — this function does
 * not consult safety overrides.
 */
function matchesAllowRule(toolName: string, input: any, rules: AllowRule[]): boolean {
  for (const rule of rules) {
    if (rule.toolName !== toolName) continue;
    if (rule.pattern === null) return true; // tool-wide
    if (toolName === "Bash") {
      const cmd = typeof input?.command === "string" ? input.command.trim() : "";
      if (!cmd) continue;
      // Bash patterns: exact, or "<prefix> *" prefix-wildcard.
      if (rule.pattern.endsWith(" *")) {
        const prefix = rule.pattern.slice(0, -2);
        if (cmd === prefix || cmd.startsWith(prefix + " ")) return true;
      } else if (cmd === rule.pattern) {
        return true;
      }
      continue;
    }
    // Path-based tools — Edit / Write / NotebookEdit / Read / Glob / Grep.
    if (
      toolName === "Edit" ||
      toolName === "Write" ||
      toolName === "NotebookEdit" ||
      toolName === "Read" ||
      toolName === "Glob" ||
      toolName === "Grep"
    ) {
      const p =
        typeof input?.file_path === "string" ? input.file_path
        : typeof input?.notebook_path === "string" ? input.notebook_path
        : typeof input?.path === "string" ? input.path
        : "";
      if (!p) continue;
      if (rule.pattern.endsWith("/**")) {
        const prefix = rule.pattern.slice(0, -3);
        if (p === prefix || p.startsWith(prefix + "/")) return true;
      } else if (p === rule.pattern) {
        return true;
      }
      continue;
    }
    if (toolName === "WebFetch") {
      const url = typeof input?.url === "string" ? input.url : "";
      if (!url) continue;
      if (rule.pattern.endsWith("/*")) {
        const prefix = rule.pattern.slice(0, -2);
        if (url.startsWith(prefix + "/") || url === prefix) return true;
      } else if (url === rule.pattern) {
        return true;
      }
      continue;
    }
  }
  return false;
}

export class ClaudeForObsidianView extends ItemView {
  private outputEl!: HTMLDivElement;
  private inputEl!: HTMLTextAreaElement;
  private statusEl!: HTMLDivElement;
  private batteryEl!: HTMLButtonElement;
  private modelBtn!: HTMLButtonElement;
  private editsBtn!: HTMLButtonElement;
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
  private slashSuggest: SlashSuggest | null = null;
  private slashCommandsCache: SlashCommand[] | null = null;
  private addDirRowEl: HTMLDivElement | null = null;
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
  // Session-scoped user allow-rules accumulated via the dialog's
  // "Allow always" menu. Cleared on chat switch / new chat / panel
  // close. Matches the native CLI's per-session rule storage.
  private allowRules: AllowRule[] = [];
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
    return CLAUDIAS_GARDEN_VIEW;
  }

  getDisplayText(): string {
    return "Claudia's Garden";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("claudias-garden-view");

    const headerRow = root.createDiv({ cls: "cfo-header-row" });
    this.chatTitleEl = headerRow.createEl("button", { cls: "cfo-chat-title-tab" });
    this.chatTitleEl.title = "Chat history, rename, delete";
    this.chatTitleEl.onclick = (evt) => this.toggleHistoryMenu(evt);
    this.refreshChatTitle();
    headerRow.createDiv({ cls: "cfo-header-spacer" });
    const saveBtn = headerRow.createEl("button", { cls: "cfo-header-btn" });
    setIcon(saveBtn, "download");
    saveBtn.title = "Save chat to vault";
    saveBtn.onclick = () => this.saveChatToVault();

    this.outputEl = root.createDiv({ cls: "cfo-output" });

    this.activeSessionId = this.plugin.settings.activeSessionId ?? null;
    if (this.activeSessionId) {
      this.replaySession(this.activeSessionId);
    } else {
      this.renderSplash();
    }
    this.refreshChatTitle();

    // Permission dialog anchor — sits between the output and the input
    // stack. Hidden until a control_request lands; one dialog at a time,
    // additional requests queue FIFO.
    this.permissionDialogEl = root.createDiv({ cls: "cfo-permission-dialog cfo-permission-dialog-hidden" });

    const inputStack = root.createDiv({ cls: "cfo-input-stack" });

    this.statusEl = inputStack.createDiv({ cls: "cfo-status" });

    this.addDirRowEl = inputStack.createDiv({ cls: "cfo-adddir-row" });
    this.renderAddDirRow();

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
    plusBtn.title = "Add";
    plusBtn.onclick = () => this.togglePlusMenu(plusBtn);

    footerNav.createDiv({ cls: "cfo-footer-spacer" });

    this.batteryEl = footerNav.createEl("button", { cls: "cfo-battery" });
    this.batteryEl.onclick = () => this.toggleContextPopup();
    this.renderBattery();

    this.modelBtn = footerNav.createEl("button", { cls: "cfo-model-btn" });
    this.modelBtn.onclick = () => this.toggleModelMenu();
    this.refreshModelBtn();

    this.sendStopBtn.title = "Send (Enter)";
    this.sendStopBtn.onclick = () => this.toggleSendStop();
    this.inputEl.addEventListener("input", () => this.autosizeInput());
    this.inputEl.addEventListener("keydown", (e) => {
      if (this.wikilinkSuggest?.isOpen() || this.slashSuggest?.isOpen()) return;
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        this.toggleSendStop();
      } else if (e.key === "Escape" && this.turnBusy) {
        e.preventDefault();
        this.cancel();
      }
    });

    this.inputEl.addEventListener("paste", (e) => this.onInputPaste(e));

    this.wikilinkSuggest = new WikilinkSuggest(this.app, this.inputEl);
    this.slashSuggest = new SlashSuggest(this.inputEl, () => this.getSlashCommands());

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
    if (this.slashSuggest) {
      this.slashSuggest.destroy();
      this.slashSuggest = null;
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

  // ---------- slash commands ----------

  /** Memoised per panel-open. Skills and custom commands don't change
   *  within a panel session; rediscovery happens on next panel open. */
  private getSlashCommands(): SlashCommand[] {
    if (this.slashCommandsCache) return this.slashCommandsCache;
    this.slashCommandsCache = this.discoverSlashCommands();
    return this.slashCommandsCache;
  }

  /** Enumerate the reachable slash surface: skills (resolved by the
   *  CLI via /skill-name) and custom command markdown files. Vault-local
   *  definitions override the home-level ones of the same name. */
  private discoverSlashCommands(): SlashCommand[] {
    const cwd = this.resolveCwd();
    const home = os.homedir();
    const byName = new Map<string, SlashCommand>();

    // Skills: home first, then vault so the vault wins on collision.
    for (const base of [home, cwd]) {
      const skillsDir = path.join(base, ".claude", "skills");
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(skillsDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const skillMd = path.join(skillsDir, entry, "SKILL.md");
        let text: string;
        try {
          if (!fs.statSync(path.join(skillsDir, entry)).isDirectory()) continue;
          text = fs.readFileSync(skillMd, "utf8");
        } catch {
          continue;
        }
        const fm = this.parseFrontmatter(text);
        const name = (fm.name || entry).trim();
        byName.set(name, {
          name,
          description: (fm.description || "").trim(),
          kind: "skill",
        });
      }
    }

    // Custom commands: same precedence.
    for (const base of [home, cwd]) {
      const cmdDir = path.join(base, ".claude", "commands");
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(cmdDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const name = entry.slice(0, -3);
        let text = "";
        try {
          text = fs.readFileSync(path.join(cmdDir, entry), "utf8");
        } catch {
          continue;
        }
        const fm = this.parseFrontmatter(text);
        let desc = (fm.description || "").trim();
        if (!desc) {
          const body = this.stripFrontmatter(text).trim();
          desc = body.split("\n")[0]?.replace(/^#+\s*/, "").slice(0, 120) ?? "";
        }
        byName.set(name, { name, description: desc, kind: "command" });
      }
    }

    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  private stripFrontmatter(text: string): string {
    if (!text.startsWith("---")) return text;
    const end = text.indexOf("\n---", 3);
    if (end === -1) return text;
    const after = text.indexOf("\n", end + 1);
    return after === -1 ? "" : text.slice(after + 1);
  }

  private parseFrontmatter(text: string): { name?: string; description?: string } {
    if (!text.startsWith("---")) return {};
    const end = text.indexOf("\n---", 3);
    if (end === -1) return {};
    const block = text.slice(3, end);
    const out: { name?: string; description?: string } = {};
    const lines = block.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(name|description)\s*:\s*(.*)$/);
      if (!m) continue;
      const key = m[1] as "name" | "description";
      let val = m[2].trim();
      // YAML folded/literal block scalar (`>`, `|`, with optional
      // chomping indicator): join the indented continuation lines.
      if (/^[>|][+-]?$/.test(val)) {
        const parts: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          if (/^\S/.test(lines[j])) break;
          if (lines[j].trim() === "" ) continue;
          parts.push(lines[j].trim());
        }
        val = parts.join(" ");
      }
      out[key] = val.replace(/^["']|["']$/g, "");
    }
    return out;
  }

  /** Expand a custom command into its prompt body before the message
   *  goes to the CLI. Skills pass through unchanged ( the CLI resolves
   *  /skill-name itself ); unknown /tokens also pass through so the CLI
   *  can surface its own error. $ARGUMENTS gets the full argument
   *  string, $1..$9 the positional args. */
  private expandSlashCommand(input: string): string {
    const m = input.match(/^\/([^\s/]+)\s*([\s\S]*)$/);
    if (!m) return input;
    const name = m[1];
    const argStr = m[2].trim();
    const cmd = this.getSlashCommands().find((c) => c.name === name && c.kind === "command");
    if (!cmd) return input;

    const cwd = this.resolveCwd();
    const home = os.homedir();
    let text: string | null = null;
    for (const base of [cwd, home]) {
      try {
        text = fs.readFileSync(path.join(base, ".claude", "commands", `${name}.md`), "utf8");
        break;
      } catch {
        /* try next base */
      }
    }
    if (text === null) return input;

    let body = this.stripFrontmatter(text).trim();
    if (!body) return input;
    const positional = argStr.length > 0 ? argStr.split(/\s+/) : [];
    body = body.replace(/\$ARGUMENTS/g, argStr);
    body = body.replace(/\$([1-9])/g, (_, d) => positional[Number(d) - 1] ?? "");
    return body;
  }

  /** Plus-menu entry point: focus the input and open the palette by
   *  seeding a leading "/" when the message doesn't already start one. */
  private openSlashPalette(): void {
    if (!this.inputEl) return;
    this.inputEl.focus();
    const v = this.inputEl.value;
    if (!/^\s*\//.test(v)) {
      this.inputEl.value = `/${v}`;
      this.inputEl.setSelectionRange(1, 1);
    }
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // ---------- extra folder access (--add-dir) ----------

  /** Removable chips above the input listing the extra directories the
   *  agent may touch beyond the vault. Hidden (`:empty`) when none. */
  private renderAddDirRow(): void {
    if (!this.addDirRowEl) return;
    this.addDirRowEl.empty();
    const dirs = this.plugin.settings.addDirs ?? [];
    for (const dir of dirs) {
      const chip = this.addDirRowEl.createDiv({ cls: "cfo-adddir-chip" });
      chip.title = dir;
      const icon = chip.createSpan({ cls: "cfo-adddir-chip-icon" });
      setIcon(icon, "folder");
      chip.createSpan({ cls: "cfo-adddir-chip-label", text: path.basename(dir) || dir });
      const x = chip.createSpan({ cls: "cfo-adddir-chip-x" });
      setIcon(x, "x");
      x.setAttribute("aria-label", `Remove ${dir}`);
      x.onclick = (e) => {
        e.stopPropagation();
        this.removeAddDir(dir);
      };
    }
  }

  /** macOS native folder chooser via osascript — matches the plugin's
   *  subprocess-everything architecture and avoids coupling to a
   *  specific Electron remote API surface. Desktop/macOS only, which
   *  is the plugin's declared platform. */
  private pickAndAddDir(): void {
    execFile(
      "osascript",
      ["-e", 'POSIX path of (choose folder with prompt "Add a folder Claude can access")'],
      (err, stdout) => {
        if (err) return; // user cancelled, or osascript unavailable
        const dir = stdout.trim().replace(/\/+$/, "");
        if (!dir) return;
        let isDir = false;
        try {
          isDir = fs.statSync(dir).isDirectory();
        } catch {
          isDir = false;
        }
        if (!isDir) {
          new Notice("That path is not a folder.");
          return;
        }
        const cwd = this.resolveCwd();
        if (dir === cwd || dir.startsWith(cwd + "/")) {
          new Notice("That folder is already inside the vault — Claude can reach it.");
          return;
        }
        const dirs = this.plugin.settings.addDirs ?? [];
        if (dirs.includes(dir)) {
          new Notice("That folder is already added.");
          return;
        }
        this.plugin.settings.addDirs = [...dirs, dir];
        this.plugin.saveSettings();
        this.renderAddDirRow();
        this.notifyAddDirChanged();
      },
    );
  }

  private removeAddDir(dir: string): void {
    const dirs = this.plugin.settings.addDirs ?? [];
    this.plugin.settings.addDirs = dirs.filter((d) => d !== dir);
    this.plugin.saveSettings();
    this.renderAddDirRow();
    this.notifyAddDirChanged();
  }

  /** Folder access is read from settings at subprocess spawn, so a
   *  change only takes effect on the next chat — same contract as the
   *  model / mode / effort pickers (v0.6.5). */
  private notifyAddDirChanged(): void {
    if (this.currentSession) {
      new Notice("Folder access changes apply to the next chat.");
    }
  }

  // ---------- file attachments (path references) ----------

  /** Absolute filesystem path of a pasted/dropped File. Obsidian's
   *  Electron historically exposes the non-standard `File.path`; newer
   *  Electron moved it behind `webUtils.getPathForFile`. Try both. A
   *  clipboard image (screenshot, copy-image-from-web) is synthetic
   *  bitmap data with no on-disk path — returns null. */
  private resolveFilePath(file: File): string | null {
    const direct = (file as unknown as { path?: string }).path;
    if (direct) return direct;
    try {
      const electron = (window as { require?: (m: string) => unknown }).require?.("electron") as
        | { webUtils?: { getPathForFile?: (f: File) => string } }
        | undefined;
      const p = electron?.webUtils?.getPathForFile?.(file);
      if (p) return p;
    } catch {
      /* not in an Electron renderer that exposes webUtils */
    }
    return null;
  }

  private insertAtCursor(text: string): void {
    const el = this.inputEl;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const pad = before.length > 0 && !before.endsWith(" ") && !before.endsWith("\n") ? " " : "";
    const insert = `${pad}${text} `;
    el.value = `${before}${insert}${after}`;
    const caret = before.length + insert.length;
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.focus();
  }

  /** Insert a reference the agent can act on. In-vault files become a
   *  vault-relative path (cwd is the vault, so the Read tool resolves
   *  it directly); out-of-vault files become an absolute path, with a
   *  nudge to grant the folder if it isn't already in scope. */
  private insertFileReference(absPath: string): void {
    const cwd = this.resolveCwd();
    const inVault = absPath === cwd || absPath.startsWith(cwd + "/");
    const ref = inVault ? absPath.slice(cwd.length + 1) : absPath;
    this.insertAtCursor(ref);
    if (!inVault) {
      const dir = path.dirname(absPath);
      const dirs = this.plugin.settings.addDirs ?? [];
      const granted = dirs.some((d) => dir === d || dir.startsWith(d + "/"));
      if (!granted) {
        new Notice("That file is outside the vault — add its folder via + → Add folder so Claude can read it.");
      }
    }
  }

  private onInputPaste(e: ClipboardEvent): void {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return; // plain text/markdown — let it paste
    const paths: string[] = [];
    let sawPathlessImage = false;
    for (const f of files) {
      const p = this.resolveFilePath(f);
      if (p) paths.push(p);
      else if (f.type.startsWith("image/")) sawPathlessImage = true;
    }
    if (paths.length === 0) {
      if (sawPathlessImage) {
        e.preventDefault();
        new Notice(
          "Pasted images can't be sent (Claude Code's plugin pipe doesn't accept images). Save it to a file and attach the file instead.",
        );
      }
      return;
    }
    e.preventDefault();
    for (const p of paths) this.insertFileReference(p);
  }

  /** macOS native file chooser (multiple), mirroring the Add-folder
   *  osascript pattern. */
  private pickAndAddFiles(): void {
    const script =
      'set theFiles to choose file with prompt "Attach file(s)" with multiple selections allowed\n' +
      'set out to ""\n' +
      "repeat with f in theFiles\n" +
      "set out to out & POSIX path of f & linefeed\n" +
      "end repeat\n" +
      "return out";
    execFile("osascript", ["-e", script], (err, stdout) => {
      if (err) return; // cancelled
      const picked = stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const p of picked) this.insertFileReference(p);
    });
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
    // Look up first user message from the jsonl on demand. Handles both
    // string-content (typical for CFOB-sent prompts) and array-content
    // (VS Code, plus newer CLI formats) — without the array path the
    // title would fall through to "(untitled)" for VS Code chats.
    const filePath = this.findSessionFile(id);
    if (filePath) {
      const extracted = extractFirstUserText(filePath);
      if (extracted) {
        this.setTitleText(extracted);
        return;
      }
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
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      const label = extractFirstUserText(fullPath);
      // Prune rule: a session with no user-prompt text content is empty.
      // Drop it from the list. Survives a custom rename (cached out of
      // band in settings.sessionLabels) — if the user has named the
      // chat, we honour that label even when extraction comes up dry.
      const custom = this.plugin.settings.sessionLabels[id];
      if (!label && !custom) continue;
      const finalLabel = custom || label!;
      const truncated = finalLabel.length > 40 ? finalLabel.slice(0, 40) + "…" : finalLabel;
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

    // New chat row at the very top — replaces the retired top-header
    // `+` button. Click closes the popup and starts a fresh chat.
    const newChatRow = popup.createDiv({ cls: "cfo-history-new" });
    const newChatIcon = newChatRow.createSpan({ cls: "cfo-history-new-icon" });
    setIcon(newChatIcon, "plus");
    newChatRow.createSpan({ cls: "cfo-history-new-label", text: "New chat" });
    newChatRow.onclick = () => {
      this.chatTitleEl.removeClass("cfo-btn-active");
      popup.remove();
      this.newChat();
    };

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
    this.clearSplash();
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
    this.renderSplash();
  }

  /** Splash content shown when no chat is active — replaces the
   *  default behaviour of opening with an empty `(empty)` chat that
   *  pollutes the session list. Hidden the moment any real content
   *  appends to outputEl (user message, tool use, or replay). */
  private renderSplash(): void {
    this.clearSplash();
    const splash = this.outputEl.createDiv({ cls: "cfo-splash" });
    splash.createDiv({ cls: "cfo-splash-greeting", text: "Welcome back." });
    splash.createDiv({ cls: "cfo-splash-prompt", text: "What are we writing today?" });
  }

  private clearSplash(): void {
    const existing = this.outputEl.querySelector(".cfo-splash");
    if (existing) existing.remove();
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
    this.clearSplash();
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
    this.clearSplash();
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
          source: "claudias-garden",
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

    // Safety overrides — these vote FIRST, even before user
    // allow-rules. Pre-approving `Bash(git *)` doesn't auto-allow
    // `cd /tmp && git status` because the cd-compound + chain can
    // execute hooks from untrusted dirs. Mirrors native's
    // `bashMissKind` taxonomy.
    if (toolName === "Bash") {
      const cmd = typeof input?.command === "string" ? input.command : "";
      if (hasBashSafetyOverride(cmd)) return true;
    }

    // User-set session allow-rules. Match against the call; if any
    // rule covers it, auto-allow. Only consulted after safety has
    // voted, so `Bash` tool-wide rules can't bypass shell-operator
    // checks.
    if (matchesAllowRule(toolName, input, this.allowRules)) return false;

    const isWrite = toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit";
    if (isWrite) return mode !== "acceptEdits";
    if (toolName === "Bash") {
      // Safe read-only Bash commands auto-allow (date, echo, ls,
      // pwd, cat, git status, etc.). Matches the CLI's own
      // pre-hook behaviour. Risky commands still ask.
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
      // The vault (cwd) plus any folders the user explicitly granted
      // via Add folder are in-scope and don't need a dialog — the
      // grant is the consent.
      const allowedRoots = [cwd, ...(this.plugin.settings.addDirs ?? [])];
      const inScope = allowedRoots.some(
        (root) => p === root || p.startsWith(root + "/"),
      );
      return !inScope;
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

    // "Allow always" — opens a small inline popup with three scope
    // options (this exact, prefix-pattern, tool-wide). Each option
    // click adds a session-scoped rule AND allows the call.
    // Hide entirely when a safety override would bypass any rule the
    // user might add — offering the button in that case would be
    // misleading (the override always wins). Matches native's
    // behaviour where permission_suggestions is empty for these cases.
    const safetyBlocksRule =
      req.toolName === "Bash" &&
      hasBashSafetyOverride(typeof req.input?.command === "string" ? req.input.command : "");
    if (!safetyBlocksRule) {
      const alwaysBtn = footer.createEl("button", {
        cls: "cfo-permission-btn cfo-permission-btn-always",
      });
      alwaysBtn.createSpan({ text: "Allow always" });
      alwaysBtn.createSpan({ cls: "cfo-permission-chord", text: "▾" });
      alwaysBtn.onclick = (e) => {
        e.stopPropagation();
        this.toggleAllowAlwaysPopup(alwaysBtn, req);
      };
    }

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
    this.dismissAllowAlwaysPopup();
    this.clearStatus();
    // Show next queued, or hide.
    this.showNextPermissionRequest();
  }

  /** Open / close the "Allow always for ..." scope-picker popup
   *  anchored on the dialog's Allow-always button. Click a row to
   *  add the rule to the session and allow the call. */
  private toggleAllowAlwaysPopup(
    triggerEl: HTMLElement,
    req: { toolName: string; input: any },
  ): void {
    // If a popup is already open, close it cleanly (proper listener
    // unregistration) rather than just removing the DOM node — the
    // previous implementation leaked a window-mousedown listener every
    // time the trigger was clicked to toggle off, which then prematurely
    // killed subsequent popups before their row clicks could fire.
    if (this.containerEl.ownerDocument.querySelector(".cfo-allow-always-popup")) {
      this.dismissAllowAlwaysPopup();
      return;
    }
    const doc = this.containerEl.ownerDocument;
    const win = doc.defaultView!;
    const popup = doc.body.createDiv({ cls: "cfo-allow-always-popup" });
    const rect = triggerEl.getBoundingClientRect();
    popup.style.bottom = `${win.innerHeight - rect.top + 6}px`;
    popup.style.left = `${Math.max(8, rect.left)}px`;
    triggerEl.addClass("cfo-permission-btn-active");

    popup.createDiv({
      cls: "cfo-allow-always-popup-label",
      text: "Allow always for…",
    });

    const cwd = this.resolveCwd();
    const suggestions = generateRuleSuggestions(req.toolName, req.input, cwd);
    for (const s of suggestions) {
      const row = popup.createDiv({ cls: "cfo-allow-always-row" });
      const ruleCol = row.createDiv({ cls: "cfo-allow-always-rule" });
      ruleCol.setText(s.rule.display);
      const descCol = row.createDiv({ cls: "cfo-allow-always-desc" });
      descCol.setText(scopeDescription(s.scope, req.toolName));
      if (s.scope === "all") {
        row.createSpan({ cls: "cfo-allow-always-chord", text: "⌘⇧⏎" });
      }
      // mousedown rather than click — fires before the window-level
      // dismiss listener so the row's action always wins even if a
      // stale dismiss handler somehow survives. Also: synchronous.
      row.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.acceptAllowAlways(s.rule);
      });
    }

    // Clamp left so the popup doesn't run off the right edge.
    const margin = 8;
    const maxLeft = win.innerWidth - popup.offsetWidth - margin;
    if (popup.offsetLeft > maxLeft) {
      popup.style.left = `${Math.max(margin, maxLeft)}px`;
    }

    const dismiss = (e: MouseEvent) => {
      if (popup.contains(e.target as Node)) return;
      if (triggerEl.contains(e.target as Node)) return;
      this.dismissAllowAlwaysPopup();
    };
    win.addEventListener("mousedown", dismiss);
    (popup as any).cfoDismiss = dismiss;
  }

  private dismissAllowAlwaysPopup(): void {
    const doc = this.containerEl.ownerDocument;
    const popup = doc.querySelector(".cfo-allow-always-popup");
    if (popup) {
      const dismiss = (popup as any).cfoDismiss as ((e: MouseEvent) => void) | undefined;
      if (dismiss) doc.defaultView?.removeEventListener("mousedown", dismiss);
      popup.remove();
    }
    doc.querySelectorAll(".cfo-permission-btn-always").forEach((b) =>
      b.classList.remove("cfo-permission-btn-active"),
    );
  }

  /** Add a session-scoped allow-rule and settle the active request
   *  as an Allow. Called from the popup row click and the ⌘⇧⏎ chord. */
  private acceptAllowAlways(rule: AllowRule): void {
    if (!this.allowRules.some((r) => r.display === rule.display)) {
      this.allowRules.push(rule);
    }
    const active = this.activePermissionRequest;
    const input = active?.input ?? {};
    this.settlePermissionRequest({ behavior: "allow", updatedInput: input });
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
        if (e.shiftKey) {
          // ⌘⇧⏎ = Allow always for the most-permissive scope
          // (tool-wide). Matches native's chord. Generates the
          // tool-wide rule on the fly so we always have an "all"
          // option even if the suggestion list was de-duplicated.
          const active = this.activePermissionRequest;
          const rule: AllowRule = {
            toolName: active.toolName,
            pattern: null,
            display: active.toolName,
          };
          this.acceptAllowAlways(rule);
        } else {
          const input = this.activePermissionRequest.input ?? {};
          this.settlePermissionRequest({ behavior: "allow", updatedInput: input });
        }
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
      new Notice("Claudia's Garden: could not resolve vault path.");
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
    // Display keeps what the user typed (/cmd args); the CLI gets the
    // client-side-expanded body for custom commands. Skills pass through.
    this.currentSession.sendMessage(this.expandSlashCommand(prompt));
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
    // Allow-rules are session-scoped. Wipe on chat boundary so the
    // next chat starts with a clean rule set — same contract as
    // native's per-session rules.
    this.allowRules = [];
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

    this.batteryEl.title = `${remainingPct}% context remaining. Click for details.`;

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
    // Highlight the chip in warning colour when bypass is the active
    // mode — matches native Claude Code's bottom-nav treatment so the
    // user always knows when permission prompts are off.
    this.editsBtn.toggleClass("cfo-edits-btn-bypass", mode === "bypassPermissions");
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
        const targetMode = m.id as PermissionMode;
        // Bypass permissions is destructive on read, edit, AND execute.
        // Match the native CLI behaviour: require an explicit confirmation
        // the first time per vault. Once confirmed, subsequent picks of
        // bypass skip the modal.
        if (
          targetMode === "bypassPermissions" &&
          !this.plugin.settings.bypassPermissionsConfirmed
        ) {
          this.editsBtn.removeClass("cfo-btn-active");
          popup.remove();
          const ok = await new BypassConfirmModal(this.app, this.resolveCwd()).prompt();
          if (!ok) return; // user cancelled — leave the mode unchanged
          this.plugin.settings.bypassPermissionsConfirmed = true;
        }
        const prevMode = this.plugin.settings.permissionMode;
        this.plugin.settings.permissionMode = targetMode;
        await this.plugin.saveSettings();
        this.refreshEditsBtn();
        this.editsBtn.removeClass("cfo-btn-active");
        popup.remove();
        // The CLI's `set_permission_mode` control_request requires an
        // SDK callback that's only registered when started via the
        // SDK bridge. In stream-json stdin/stdout mode (us), the
        // request returns an explicit "not supported" error. Notice
        // the user so the new mode is visibly tied to "next chat".
        if (this.currentSession?.isAlive && targetMode !== prevMode) {
          new Notice("Mode change takes effect on the next chat.");
        }
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
        // The CLI's `set_model` / `apply_flag_settings` control_requests
        // require an SDK callback the CLI only registers when started
        // via the SDK bridge (`--sdk-url`). In stream-json stdin/stdout
        // mode (us), the request is silently dropped. Tell the user
        // explicitly so the new model is visibly tied to "next chat".
        if (this.currentSession?.isAlive) {
          new Notice("Model change takes effect on the next chat.");
        }
      },
      onEffortChange: async (effort) => {
        this.plugin.settings.effort = effort;
        await this.plugin.saveSettings();
        this.refreshModelBtn();
        // Same SDK-callback gating as model — silently dropped in
        // stream-json mode. Notice the user.
        if (this.currentSession?.isAlive) {
          new Notice("Effort change takes effect on the next chat.");
        }
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

    type Row = { icon: string; label: string; comingSoon?: string; action?: () => void };
    const rows: Row[] = [
      { icon: "paperclip", label: "Add files", action: () => this.pickAndAddFiles() },
      { icon: "folder", label: "Add folder", action: () => this.pickAndAddDir() },
      { icon: "slash", label: "Slash commands", action: () => this.openSlashPalette() },
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
        if (r.action) r.action();
        else if (r.comingSoon) new Notice(r.comingSoon);
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

  /** Context-window popup anchored above the battery ring. Shows
   *  exact tokens used / tokens max / percentage plus a "X remaining"
   *  headline. Data comes from the CLI's `get_context_usage` control
   *  request — authoritative, not the heuristic accumulator that
   *  drives the ring between turns. Falls back to a static cold-open
   *  shape when no session is live. */
  private toggleContextPopup(): void {
    const existing = this.containerEl.ownerDocument.querySelector(
      ".cfo-plan-popup",
    ) as HTMLElement | null;
    if (existing) {
      const prev = (existing as any).cfoTriggerEl as HTMLElement | undefined;
      if (prev) prev.removeClass("cfo-btn-active");
      existing.remove();
      return;
    }
    this.openContextPopup();
  }

  private openContextPopup(): void {
    const doc = this.containerEl.ownerDocument;
    const win = doc.defaultView!;
    doc.querySelectorAll(".cfo-plan-popup").forEach((el) => el.remove());
    const popup = doc.body.createDiv({ cls: "cfo-plan-popup cfo-context-popup" });
    (popup as any).cfoTriggerEl = this.batteryEl;

    const rect = this.batteryEl.getBoundingClientRect();
    popup.style.bottom = `${win.innerHeight - rect.top + 6}px`;
    popup.style.left = "0px";

    popup.createDiv({ cls: "cfo-plan-popup-title", text: "Context window" });
    const body = popup.createDiv({ cls: "cfo-context-body" });

    // Render whatever we know right now — either a live snapshot if
    // the session can answer, or the heuristic shape from the ring's
    // own state if we're cold.
    this.paintContextBody(body, "initial");

    // Clamp position to viewport now that the popup has its real width.
    const margin = 8;
    const maxLeft = win.innerWidth - popup.offsetWidth - margin;
    const clamped = Math.max(margin, Math.min(rect.left, maxLeft));
    popup.style.left = `${clamped}px`;

    this.batteryEl.addClass("cfo-btn-active");

    const dismiss = (e: MouseEvent) => {
      if (popup.contains(e.target as Node)) return;
      if (this.batteryEl.contains(e.target as Node)) return;
      this.batteryEl.removeClass("cfo-btn-active");
      popup.remove();
      doc.removeEventListener("mousedown", dismiss, true);
    };
    setTimeout(() => doc.addEventListener("mousedown", dismiss, true), 0);

    // Fire the authoritative snapshot request if the session is live.
    // While the request is in flight the heuristic shape is on screen,
    // so the popup never looks empty.
    if (this.currentSession?.isAlive) {
      this.currentSession
        .getContextUsage()
        .then((snapshot) => {
          if (!popup.isConnected) return;
          this.paintContextBody(body, "live", snapshot);
        })
        .catch(() => {
          // Session died mid-flight or the CLI rejected — leave the
          // heuristic shape on screen rather than blanking the popup.
        });
    }
  }

  /** Paint the body of the context-window popup. Two shapes:
   *
   *  - `initial` — use the heuristic accumulator + per-model window.
   *    Renders immediately, no async wait. Used as the first frame
   *    and as the cold-open fallback when no session is live.
   *  - `live`    — use the authoritative `get_context_usage` snapshot.
   *    Replaces the initial frame once the round-trip lands.
   */
  private paintContextBody(
    host: HTMLElement,
    mode: "initial" | "live",
    snapshot?: ContextUsageResponse,
  ): void {
    const max =
      mode === "live" && snapshot
        ? snapshot.maxTokens
        : contextWindowForModel(this.plugin.settings.model);
    const used =
      mode === "live" && snapshot ? snapshot.totalTokens : this.sessionTokensUsed;
    const remaining = Math.max(0, max - used);
    const pct =
      mode === "live" && snapshot
        ? snapshot.percentage
        : Math.max(0, Math.min(100, Math.round((used / max) * 100)));

    host.empty();
    host.createDiv({
      cls: "cfo-context-headline",
      text: `${this.formatTokens(remaining)} remaining`,
    });
    host.createDiv({
      cls: "cfo-context-subline",
      text: `${this.formatTokens(used)} / ${this.formatTokens(max)} used · ${pct}%`,
    });
    const bar = host.createDiv({ cls: "cfo-context-bar" });
    const fill = bar.createDiv({ cls: "cfo-context-bar-fill" });
    fill.style.width = `${pct}%`;
    if (mode === "initial" && !this.currentSession?.isAlive) {
      host.createDiv({
        cls: "cfo-context-note",
        text: "Estimated from this chat's traffic. Send a message to load the live snapshot.",
      });
    }
  }

  /** Refresh the context popup body in place if it's open. Called
   *  from the `result` event handler so the numbers update across
   *  turns without re-clicking the battery. */
  private refreshContextPopupIfOpen(): void {
    const popup = this.containerEl.ownerDocument.querySelector(
      ".cfo-context-popup",
    ) as HTMLElement | null;
    if (!popup) return;
    const body = popup.querySelector(".cfo-context-body") as HTMLElement | null;
    if (!body) return;
    if (!this.currentSession?.isAlive) return;
    this.currentSession
      .getContextUsage()
      .then((snapshot) => {
        if (!popup.isConnected) return;
        this.paintContextBody(body, "live", snapshot);
      })
      .catch(() => {});
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
        this.refreshContextPopupIfOpen();
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
        new Notice(`Claudia's Garden: ${e.message}`);
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
          new Notice(`Claudia's Garden exited (${e.code}).${detail}`);
        }
        this.lastStderr = null;
        break;
      }
    }
  }
}
