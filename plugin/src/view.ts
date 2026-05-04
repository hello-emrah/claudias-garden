import { ItemView, WorkspaceLeaf, Notice, MarkdownRenderer, Component } from "obsidian";
import { ClaudeRun, StreamEvent } from "./claude-client";
import type ClaudeForObsidianPlugin from "./main";

export const CLAUDE_FOR_OBSIDIAN_VIEW = "claude-for-obsidian-view";

interface AssistantBuffer {
  containerEl: HTMLDivElement;
  bodyEl: HTMLDivElement;
  text: string;
  renderTimer: number | null;
}

export class ClaudeForObsidianView extends ItemView {
  private outputEl!: HTMLDivElement;
  private inputEl!: HTMLTextAreaElement;
  private statusEl!: HTMLDivElement;
  private cwdBannerEl!: HTMLDivElement;
  private sendBtn!: HTMLButtonElement;
  private cancelBtn!: HTMLButtonElement;
  private currentRun: ClaudeRun | null = null;
  private currentAssistant: AssistantBuffer | null = null;
  private renderComponent: Component = new Component();

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

    this.cwdBannerEl = root.createDiv({ cls: "cfo-cwd-banner" });
    this.refreshCwdBanner();

    this.outputEl = root.createDiv({ cls: "cfo-output" });
    this.statusEl = root.createDiv({ cls: "cfo-status", text: "Idle." });

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

  private handleEvent(e: StreamEvent): void {
    switch (e.kind) {
      case "system":
        this.statusEl.setText(`Session ${e.raw.session_id ?? ""} started.`);
        break;
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
        const cost = r.total_cost_usd != null ? `$${r.total_cost_usd.toFixed(4)}` : "";
        this.statusEl.setText(`Done. ${dur} ${cost}`.trim());
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
