import { ItemView, WorkspaceLeaf, Notice, MarkdownRenderer, Component, TFile, normalizePath, setIcon } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ClaudeRun, StreamEvent } from "./claude-client";
import { exportSession } from "./chat-export";
import { WikilinkSuggest } from "./wikilink-suggest";
import { openModelPopup } from "./model-popup";
import { MODEL_OPTIONS, EFFORT_OPTIONS, MODE_OPTIONS, PermissionMode } from "./settings";
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

// Context window for the current default model. Hardcoded for now.
// Increment 4 makes this model-aware via the model picker.
const CONTEXT_WINDOW_TOKENS = 1_000_000;

export class ClaudeForObsidianView extends ItemView {
  private outputEl!: HTMLDivElement;
  private inputEl!: HTMLTextAreaElement;
  private statusEl!: HTMLDivElement;
  private batteryEl!: HTMLButtonElement;
  private modelBtn!: HTMLButtonElement;
  private editsBtn!: HTMLButtonElement;
  private chatTitleEl!: HTMLButtonElement;
  private sendStopBtn!: HTMLButtonElement;
  private currentRun: ClaudeRun | null = null;
  private currentAssistant: AssistantBuffer | null = null;
  private renderComponent: Component = new Component();
  private activeSessionId: string | null = null;
  private pendingTitle: string | null = null;
  private sessionTokensUsed = 0;
  private lastStderr: string | null = null;
  private lastDateKey: string | null = null;
  private wikilinkSuggest: WikilinkSuggest | null = null;
  private pendingTools: Map<string, { el: HTMLElement; startedAt: number; group: ToolGroup }> = new Map();
  private static readonly TOOL_MIN_VISIBLE_MS = 600;
  private currentToolGroup: ToolGroup | null = null;
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

    const inputStack = root.createDiv({ cls: "cfo-input-stack" });

    this.statusEl = inputStack.createDiv({ cls: "cfo-status" });

    const textBox = inputStack.createDiv({ cls: "cfo-textbox" });
    this.inputEl = textBox.createEl("textarea", { cls: "cfo-input" });
    this.inputEl.placeholder = "Message Claude. Enter to send, Shift-Enter for newline.";
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
    plusBtn.title = "Attach (coming soon)";
    plusBtn.onclick = () =>
      this.toggleInfoPopup(plusBtn, "Attach", "Coming soon. Attach files from your vault or computer.");

    const slashBtn = footerNav.createEl("button", { cls: "cfo-footer-btn" });
    setIcon(slashBtn, "slash");
    slashBtn.title = "Slash commands (coming soon)";
    slashBtn.onclick = () =>
      this.toggleInfoPopup(slashBtn, "Slash commands", "Coming soon. Slash commands like /compact and /help, plus your installed skills.");

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
      } else if (e.key === "Escape" && this.currentRun) {
        e.preventDefault();
        this.cancel();
      }
    });

    this.wikilinkSuggest = new WikilinkSuggest(this.app, this.inputEl);

    this.renderComponent.load();
  }

  async onClose(): Promise<void> {
    this.cancel();
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
    if (this.currentRun) {
      new Notice("Cannot switch chats while a run is in progress.");
      return;
    }
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

    const appendReplayToolRow = (name: string, input: any) => {
      const summary = typeof input === "object" ? JSON.stringify(input) : String(input);
      const truncated = summary.length > 240 ? summary.slice(0, 240) + "…" : summary;

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
      const row = replayGroup.bodyEl.createDiv({ cls: "cfo-tool-row" });
      row.createSpan({ cls: "cfo-tool-row-dot" });
      row.createSpan({ cls: "cfo-tool-row-name", text: this.toolVerbForName(name) });
      row.createSpan({ cls: "cfo-tool-row-args", text: truncated });
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
            appendReplayToolRow(block.name, block.input);
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
    if (this.currentRun) {
      new Notice("Cannot start a new chat while a run is in progress.");
      return;
    }
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
    if (this.currentRun) {
      new Notice("Cannot delete chat while a run is in progress.");
      return;
    }
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
    if (this.currentRun) {
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
    const summary = typeof input === "object" ? JSON.stringify(input) : String(input);
    const truncated = summary.length > 240 ? summary.slice(0, 240) + "…" : summary;

    if (id === null) {
      // Replay path: render as a flat row outside any live group.
      const flat = this.outputEl.createDiv({ cls: "cfo-tool-row cfo-tool-row-replay" });
      flat.createSpan({ cls: "cfo-tool-row-name", text: this.toolVerbForName(name) });
      flat.createSpan({ cls: "cfo-tool-row-args", text: truncated });
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
    const dot = row.createSpan({ cls: "cfo-tool-row-dot" });
    row.createSpan({ cls: "cfo-tool-row-name", text: this.toolVerbForName(name) });
    row.createSpan({ cls: "cfo-tool-row-args", text: truncated });
    void dot;

    this.pendingTools.set(id, { el: row, startedAt: Date.now(), group });
    this.updateToolGroupHeader(group);
    this.bumpTrailingThinking();

    this.outputEl.scrollTop = this.outputEl.scrollHeight;
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

  private settleToolResult(id: string | null, isError: boolean): void {
    if (!id) return;
    const entry = this.pendingTools.get(id);
    if (!entry) return;
    this.pendingTools.delete(id);
    const elapsed = Date.now() - entry.startedAt;
    const wait = Math.max(0, ClaudeForObsidianView.TOOL_MIN_VISIBLE_MS - elapsed);
    const settle = () => {
      entry.el.removeClass("cfo-tool-row-running");
      if (isError) entry.el.addClass("cfo-tool-row-error");
      // Decrement the running counter for this row's tool name. We don't
      // store the name on the entry, so derive from the row text.
      const nameEl = entry.el.querySelector(".cfo-tool-row-name");
      const name = (nameEl?.textContent ?? "").trim();
      const verb = name;
      // Find the matching original tool name by reverse lookup of verb→name.
      const originalName = this.originalNameForVerb(verb);
      if (originalName) {
        const remaining = (entry.group.runningByName.get(originalName) ?? 1) - 1;
        if (remaining <= 0) entry.group.runningByName.delete(originalName);
        else entry.group.runningByName.set(originalName, remaining);
      }
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

  private originalNameForVerb(verb: string): string | null {
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
    for (const [k, v] of Object.entries(verbs)) {
      if (v === verb) return k;
    }
    return verb;
  }

  private send(): void {
    const prompt = this.inputEl.value.trim();
    if (!prompt) return;
    if (this.currentRun) {
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

    const run = new ClaudeRun({
      prompt,
      cwd,
      settings: this.plugin.settings,
      resumeSessionId: this.activeSessionId,
      onEvent: (e) => this.handleEvent(e),
    });
    this.currentRun = run;
    run.start();
  }

  private cancel(): void {
    if (this.currentRun) {
      this.currentRun.cancel();
      this.statusEl.setText("Cancelling…");
    }
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
    const input = Number(usage.input_tokens) || 0;
    const output = Number(usage.output_tokens) || 0;
    const cacheCreate = Number(usage.cache_creation_input_tokens) || 0;
    const cacheRead = Number(usage.cache_read_input_tokens) || 0;
    return input + output + cacheCreate + cacheRead;
  }

  private renderBattery(): void {
    if (!this.batteryEl) return;
    const used = this.sessionTokensUsed;
    const remaining = Math.max(0, CONTEXT_WINDOW_TOKENS - used);
    const remainingPct = Math.max(0, Math.min(100, Math.round((remaining / CONTEXT_WINDOW_TOKENS) * 100)));

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
    const modelId = this.plugin.settings.model || MODEL_OPTIONS[1].id;
    const model = MODEL_OPTIONS.find((m) => m.id === modelId) ?? MODEL_OPTIONS[1];
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
      },
      onEffortChange: async (effort) => {
        this.plugin.settings.effort = effort;
        await this.plugin.saveSettings();
        this.refreshModelBtn();
      },
      onFastModeChange: async (enabled) => {
        this.plugin.settings.fastMode = enabled;
        await this.plugin.saveSettings();
        this.refreshModelBtn();
      },
    });
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
    if (this.currentRun) {
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
      case "tool-result":
        this.settleToolResult(e.toolUseId, e.isError);
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
        this.currentRun = null;
        this.currentAssistant = null;
        this.settleAllPendingTools();
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
