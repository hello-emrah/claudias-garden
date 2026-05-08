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
  private sendBtn!: HTMLButtonElement;
  private cancelBtn!: HTMLButtonElement;
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
    const historyBtn = headerRow.createEl("button", { cls: "cfo-history-btn", text: "🕒" });
    historyBtn.title = "Recent chats in this vault";
    historyBtn.onclick = (evt) => this.openHistoryMenu(evt);

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

    const btnCol = inputRow.createDiv({ cls: "cfo-btn-col" });
    this.sendBtn = btnCol.createEl("button", { text: "Send" });
    this.cancelBtn = btnCol.createEl("button", { text: "Cancel" });
    this.cancelBtn.disabled = true;

    this.sendBtn.onclick = () => this.send();
    this.cancelBtn.onclick = () => this.cancel();
    this.inputEl.addEventListener("input", () => this.autosizeInput());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.send();
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
    this.cwdBannerEl.setText(`vault: ${this.vaultName()}  ·  ${this.resolveCwd()}`);
  }

  private cliProjectDir(): string {
    const cwd = this.resolveCwd();
    const encoded = cwd.replace(/\//g, "-");
    return path.join(os.homedir(), ".claude", "projects", encoded);
  }

  private listSessions(): SessionSummary[] {
    const dir = this.cliProjectDir();
    let entries: string[];
    try {
      entries = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }
    const summaries: SessionSummary[] = [];
    for (const file of entries) {
      const fullPath = path.join(dir, file);
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
        // unreadable file; keep default label
      }
      const truncated = label.length > 40 ? label.slice(0, 40) + "…" : label;
      summaries.push({ id, label: truncated, timestamp: stat.mtimeMs });
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
    this.statusEl.setText(`Switched to session ${id}.`);
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
    this.sendBtn.disabled = busy;
    this.cancelBtn.disabled = !busy;
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
