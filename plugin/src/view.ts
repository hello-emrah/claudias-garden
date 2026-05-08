import { ItemView, WorkspaceLeaf, Notice, MarkdownRenderer, Component, Menu } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ClaudeRun, StreamEvent } from "./claude-client";
import type ClaudeForObsidianPlugin from "./main";

interface SessionSummary {
  id: string;
  label: string;
  timestamp: number;
}

export const CLAUDE_FOR_OBSIDIAN_VIEW = "claude-for-obsidian-view";

interface AssistantBuffer {
  containerEl: HTMLDivElement;
  bodyEl: HTMLDivElement;
  text: string;
  renderTimer: number | null;
}

// Context window for the current default model. Hardcoded for T01.
// Increment 4 makes this model-aware via the model picker.
const CONTEXT_WINDOW_TOKENS = 1_000_000;

export class ClaudeForObsidianView extends ItemView {
  private outputEl!: HTMLDivElement;
  private inputEl!: HTMLTextAreaElement;
  private statusEl!: HTMLDivElement;
  private usageEl!: HTMLDivElement;
  private cwdBannerEl!: HTMLDivElement;
  private sendStopBtn!: HTMLButtonElement;
  private currentRun: ClaudeRun | null = null;
  private currentAssistant: AssistantBuffer | null = null;
  private renderComponent: Component = new Component();
  private sessionTokensUsed = 0;
  private activeSessionId: string | null = null;

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
    this.cwdBannerEl = headerRow.createDiv({ cls: "cfo-cwd-banner" });
    this.refreshCwdBanner();
    const historyBtn = headerRow.createEl("button", { cls: "cfo-header-btn", text: "🕒" });
    historyBtn.title = "Recent chats in this vault";
    historyBtn.onclick = (evt) => this.openHistoryMenu(evt);
    const newBtn = headerRow.createEl("button", { cls: "cfo-header-btn", text: "＋" });
    newBtn.title = "New chat";
    newBtn.onclick = () => this.newChat();
    const deleteBtn = headerRow.createEl("button", { cls: "cfo-header-btn", text: "🗑" });
    deleteBtn.title = "Delete current chat";
    deleteBtn.onclick = () => this.deleteCurrentChat();

    this.outputEl = root.createDiv({ cls: "cfo-output" });
    this.statusEl = root.createDiv({ cls: "cfo-status", text: "Idle." });
    this.usageEl = root.createDiv({ cls: "cfo-usage" });
    this.renderUsage();

    this.activeSessionId = this.plugin.settings.activeSessionId ?? null;
    if (this.activeSessionId) {
      this.statusEl.setText(`Continuing session ${this.activeSessionId}.`);
    }

    const inputRow = root.createDiv({ cls: "cfo-input-row" });
    this.inputEl = inputRow.createEl("textarea", { cls: "cfo-input" });
    this.inputEl.placeholder = "Message Claude. Cmd-Enter to send.";
    this.inputEl.rows = 1;
    this.autosizeInput();

    this.sendStopBtn = inputRow.createEl("button", { cls: "cfo-send-stop-btn", text: "↑" });
    this.sendStopBtn.title = "Send (Cmd-Enter)";
    this.sendStopBtn.onclick = () => this.toggleSendStop();
    this.inputEl.addEventListener("input", () => this.autosizeInput());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.toggleSendStop();
      } else if (e.key === "Escape" && this.currentRun) {
        e.preventDefault();
        this.cancel();
      }
    });

    this.renderComponent.load();
  }

  async onClose(): Promise<void> {
    this.cancel();
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

  private refreshCwdBanner(): void {
    if (!this.cwdBannerEl) return;
    this.cwdBannerEl.setText(this.vaultName());
  }

  private projectsRoot(): string {
    return path.join(os.homedir(), ".claude", "projects");
  }

  private listSessions(): SessionSummary[] {
    const root = this.projectsRoot();
    const cwd = this.resolveCwd();
    let projectDirs: string[];
    try {
      projectDirs = fs.readdirSync(root);
    } catch {
      return [];
    }
    const summaries: SessionSummary[] = [];
    for (const projectDir of projectDirs) {
      const dirPath = path.join(root, projectDir);
      let files: string[];
      try {
        files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const file of files) {
        const fullPath = path.join(dirPath, file);
        const id = file.replace(/\.jsonl$/, "");
        let label = "(empty)";
        let belongsToCwd = false;
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
              if (typeof evt.cwd === "string" && evt.cwd === cwd) {
                belongsToCwd = true;
              }
              if (label === "(empty)") {
                if (evt.type === "user" && typeof evt.message?.content === "string") {
                  label = evt.message.content;
                } else if (evt.type === "queue-operation" && typeof evt.content === "string") {
                  label = evt.content;
                }
              }
              if (belongsToCwd && label !== "(empty)") break;
            } catch {
              // skip malformed line
            }
          }
        } catch {
          // unreadable file; skip
        }
        if (!belongsToCwd) continue;
        const truncated = label.length > 40 ? label.slice(0, 40) + "…" : label;
        summaries.push({ id, label: truncated, timestamp: stat.mtimeMs });
      }
    }
    summaries.sort((a, b) => b.timestamp - a.timestamp);
    return summaries;
  }

  private openHistoryMenu(evt: MouseEvent): void {
    const menu = new Menu();
    const sessions = this.listSessions();
    if (sessions.length === 0) {
      menu.addItem((item) => item.setTitle("No recent chats").setDisabled(true));
    } else {
      for (const s of sessions) {
        menu.addItem((item) =>
          item
            .setTitle(s.label || s.id)
            .setChecked(s.id === this.activeSessionId)
            .onClick(() => this.switchToSession(s.id))
        );
      }
    }
    menu.showAtMouseEvent(evt);
  }

  private switchToSession(id: string): void {
    if (this.currentRun) {
      new Notice("Cannot switch chats while a run is in progress.");
      return;
    }
    this.activeSessionId = id;
    this.plugin.settings.activeSessionId = id;
    this.plugin.saveSettings();
    this.outputEl.empty();
    this.sessionTokensUsed = 0;
    this.renderUsage();
    this.replaySession(id);
    this.statusEl.setText(`Switched to session ${id}.`);
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
    const flushAssistant = () => {
      if (!pendingAssistantOpen) return;
      const buf = this.startAssistantBuffer();
      buf.text = pendingAssistantText;
      this.flushAssistantRender(buf);
      pendingAssistantText = "";
      pendingAssistantOpen = false;
    };
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let evt: any;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (evt.type === "user" && evt.message) {
        flushAssistant();
        const content = evt.message.content;
        if (typeof content === "string") {
          this.appendUserBlock(content);
        } else if (Array.isArray(content)) {
          const texts = content
            .filter((b: any) => b?.type === "text" && typeof b.text === "string")
            .map((b: any) => b.text)
            .join("\n");
          if (texts) this.appendUserBlock(texts);
        }
        continue;
      }
      if (evt.type === "assistant" && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === "text" && typeof block.text === "string") {
            if (!pendingAssistantOpen) pendingAssistantOpen = true;
            pendingAssistantText += block.text;
          } else if (block.type === "tool_use") {
            flushAssistant();
            this.appendToolUse(block.name, block.input);
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
    flushAssistant();
    if (lastTokenTotal > 0) {
      this.sessionTokensUsed = lastTokenTotal;
      this.renderUsage();
    }
  }

  newChat(): void {
    if (this.currentRun) {
      new Notice("Cannot start a new chat while a run is in progress.");
      return;
    }
    this.activeSessionId = null;
    this.plugin.settings.activeSessionId = null;
    this.plugin.saveSettings();
    this.outputEl.empty();
    this.sessionTokensUsed = 0;
    this.renderUsage();
    this.statusEl.setText("New chat. Send a message to begin.");
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
    this.statusEl.setText(`Deleted chat ${id}. New chat ready.`);
  }

  private findSessionFile(id: string): string | null {
    const root = this.projectsRoot();
    let projectDirs: string[];
    try {
      projectDirs = fs.readdirSync(root);
    } catch {
      return null;
    }
    for (const projectDir of projectDirs) {
      const candidate = path.join(root, projectDir, `${id}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  private appendUserBlock(text: string): void {
    const block = this.outputEl.createDiv({ cls: "cfo-message cfo-message-user" });
    block.createDiv({ cls: "cfo-message-role", text: "You" });
    const body = block.createDiv({ cls: "cfo-message-body" });
    this.renderMarkdownInto(text, body);
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }

  private startAssistantBuffer(): AssistantBuffer {
    const containerEl = this.outputEl.createDiv({ cls: "cfo-message cfo-message-assistant" });
    containerEl.createDiv({ cls: "cfo-message-role", text: "Claude" });
    const bodyEl = containerEl.createDiv({ cls: "cfo-message-body" });
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
    return { containerEl, bodyEl, text: "", renderTimer: null };
  }

  private scheduleAssistantRender(buf: AssistantBuffer): void {
    if (buf.renderTimer != null) return;
    buf.renderTimer = window.setTimeout(() => {
      buf.renderTimer = null;
      this.renderMarkdownInto(buf.text, buf.bodyEl);
      this.outputEl.scrollTop = this.outputEl.scrollHeight;
    }, 60);
  }

  private flushAssistantRender(buf: AssistantBuffer): void {
    if (buf.renderTimer != null) {
      window.clearTimeout(buf.renderTimer);
      buf.renderTimer = null;
    }
    this.renderMarkdownInto(buf.text, buf.bodyEl);
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }

  private renderMarkdownInto(markdown: string, el: HTMLElement): void {
    el.empty();
    MarkdownRenderer.render(this.app, markdown, el, this.resolveCwd(), this.renderComponent);
    this.attachCopyButtons(el);
  }

  private attachCopyButtons(el: HTMLElement): void {
    const blocks = el.querySelectorAll("pre");
    blocks.forEach((pre) => {
      if (pre.querySelector(".cfo-copy-btn")) return;
      const btn = pre.createEl("button", { cls: "cfo-copy-btn", text: "⧉" });
      btn.title = "Copy code";
      btn.onclick = (evt) => {
        evt.stopPropagation();
        const code = pre.querySelector("code");
        const text = code ? code.textContent ?? "" : pre.textContent ?? "";
        navigator.clipboard.writeText(text).then(() => {
          btn.setText("✓");
          btn.addClass("cfo-copy-btn-copied");
          window.setTimeout(() => {
            btn.setText("⧉");
            btn.removeClass("cfo-copy-btn-copied");
          }, 1200);
        });
      };
    });
  }

  private appendToolUse(name: string, input: any): void {
    const summary = typeof input === "object" ? JSON.stringify(input) : String(input);
    const truncated = summary.length > 240 ? summary.slice(0, 240) + "…" : summary;
    const el = this.outputEl.createDiv({ cls: "cfo-message-tool" });
    el.setText(`▸ ${name}  ${truncated}`);
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
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
    this.inputEl.value = "";
    this.autosizeInput();
    this.currentAssistant = null;
    this.setBusy(true);
    this.statusEl.setText(`Running in ${this.vaultName()}…`);

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
    this.sendStopBtn.setText(busy ? "⏹" : "↑");
    this.sendStopBtn.title = busy ? "Stop (Esc)" : "Send (Cmd-Enter)";
    this.sendStopBtn.toggleClass("cfo-send-stop-btn-busy", busy);
  }

  private toggleSendStop(): void {
    if (this.currentRun) {
      this.cancel();
    } else {
      this.send();
    }
  }

  private tokensFromUsage(usage: any): number {
    if (!usage || typeof usage !== "object") return 0;
    const input = Number(usage.input_tokens) || 0;
    const output = Number(usage.output_tokens) || 0;
    const cacheCreate = Number(usage.cache_creation_input_tokens) || 0;
    const cacheRead = Number(usage.cache_read_input_tokens) || 0;
    return input + output + cacheCreate + cacheRead;
  }

  private renderUsage(): void {
    if (!this.usageEl) return;
    const used = this.sessionTokensUsed;
    const remaining = Math.max(0, CONTEXT_WINDOW_TOKENS - used);
    const pct = Math.round((remaining / CONTEXT_WINDOW_TOKENS) * 100);
    const usedLabel = this.formatTokens(used);
    this.usageEl.setText(`${pct}% Context Remains · ${usedLabel} Tokens Used`);
  }

  private formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  private handleEvent(e: StreamEvent): void {
    switch (e.kind) {
      case "system": {
        const sid = e.raw.session_id ?? null;
        if (!sid) break;
        const isResume = !!this.activeSessionId;
        this.activeSessionId = sid;
        this.plugin.settings.activeSessionId = sid;
        this.plugin.saveSettings();
        this.statusEl.setText(isResume ? `Resumed session.` : `Session ${sid} started.`);
        break;
      }
      case "assistant-text":
        if (!this.currentAssistant) {
          this.currentAssistant = this.startAssistantBuffer();
        }
        this.currentAssistant.text += e.text;
        this.scheduleAssistantRender(this.currentAssistant);
        break;
      case "tool-use":
        if (this.currentAssistant) this.flushAssistantRender(this.currentAssistant);
        this.currentAssistant = null;
        this.appendToolUse(e.name, e.input);
        break;
      case "tool-result":
        // Surfacing tool results inline can be noisy; status only.
        if (e.isError) {
          this.statusEl.setText(`Tool error.`);
        }
        break;
      case "result": {
        const r = e.raw;
        const dur = r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : "";
        const turnTokens = this.tokensFromUsage(r.usage);
        if (turnTokens > 0) {
          this.sessionTokensUsed = Math.max(this.sessionTokensUsed, turnTokens);
          this.renderUsage();
        }
        this.statusEl.setText(`Done. ${dur}`.trim());
        break;
      }
      case "stderr":
        this.statusEl.setText(`stderr: ${e.line.slice(0, 200)}`);
        break;
      case "error":
        new Notice(`Claude for Obsidian: ${e.message}`);
        this.statusEl.setText(`Error: ${e.message}`);
        break;
      case "exit":
        if (this.currentAssistant) this.flushAssistantRender(this.currentAssistant);
        this.currentRun = null;
        this.currentAssistant = null;
        this.setBusy(false);
        if (e.code !== 0 && e.code !== null) {
          this.statusEl.setText(`Exited with code ${e.code}.`);
        }
        break;
    }
  }
}
