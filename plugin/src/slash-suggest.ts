// Slash-command palette for the input textarea. Mirrors the
// wikilink-suggest machinery: a textarea-anchored popup with filter,
// arrow-key navigation, and Enter/Tab insert. Reuses the
// .cfo-wikilink-suggest CSS so theming stays consistent with no churn.
//
// The reachable slash surface in CFOB's subprocess mode is skills
// (resolved by the CLI via /skill-name) plus custom command markdown
// files (expanded client-side at send time). Built-in REPL commands
// (/help, /compact, ...) are out of reach via the stdin path and are
// deliberately not listed.

export type SlashKind = "skill" | "command";

export interface SlashCommand {
  name: string;
  description: string;
  kind: SlashKind;
}

export class SlashSuggest {
  private popup: HTMLDivElement | null = null;
  private items: SlashCommand[] = [];
  private selected = 0;
  private triggerStart = -1;
  private rowEls: HTMLDivElement[] = [];
  private destroyed = false;

  constructor(
    private textarea: HTMLTextAreaElement,
    private provider: () => SlashCommand[],
  ) {
    this.textarea.addEventListener("input", this.onInput);
    this.textarea.addEventListener("keydown", this.onKeydown, true);
    this.textarea.addEventListener("blur", this.onBlur);
  }

  destroy(): void {
    this.destroyed = true;
    this.textarea.removeEventListener("input", this.onInput);
    this.textarea.removeEventListener("keydown", this.onKeydown, true);
    this.textarea.removeEventListener("blur", this.onBlur);
    this.close();
  }

  isOpen(): boolean {
    return this.popup !== null;
  }

  private onInput = (): void => {
    this.refresh();
  };

  private onBlur = (): void => {
    setTimeout(() => this.close(), 100);
  };

  private onKeydown = (e: KeyboardEvent): void => {
    if (!this.popup) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      this.move(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      this.move(-1);
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (this.items.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        this.commit(this.items[this.selected]);
      }
      return;
    }
  };

  private refresh(): void {
    const trigger = this.detectTrigger();
    if (!trigger) {
      this.close();
      return;
    }
    this.triggerStart = trigger.start;
    const matches = this.search(trigger.query);
    if (matches.length === 0) {
      this.close();
      return;
    }
    this.items = matches;
    this.selected = 0;
    this.render();
  }

  // Fires only when the message begins with a slash command token:
  // optional leading whitespace, a single "/", then a run with no
  // whitespace and no second "/". This keeps it from triggering on
  // file paths (src/foo) typed mid-message.
  private detectTrigger(): { start: number; query: string } | null {
    const value = this.textarea.value;
    const caret = this.textarea.selectionStart ?? 0;
    const head = value.slice(0, caret);
    const m = head.match(/^\s*\/([^\s/]*)$/);
    if (!m) return null;
    return { start: head.indexOf("/"), query: m[1] };
  }

  private search(query: string): SlashCommand[] {
    const q = query.toLowerCase();
    const all = this.provider();
    const out = all.filter(
      (c) =>
        q.length === 0 ||
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q),
    );
    out.sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(q);
      const bStarts = b.name.toLowerCase().startsWith(q);
      if (aStarts !== bStarts) return aStarts ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out.slice(0, 50);
  }

  private render(): void {
    if (!this.popup) {
      this.popup = this.textarea.ownerDocument.body.createDiv({ cls: "cfo-wikilink-suggest" });
    }
    this.popup.empty();
    this.rowEls = [];
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      const row = this.popup.createDiv({ cls: "cfo-wikilink-suggest-row" });
      if (i === this.selected) row.addClass("cfo-wikilink-suggest-row-active");
      const display = row.createSpan({ cls: "cfo-wikilink-suggest-display", text: `/${item.name}` });
      if (item.description) {
        display.createSpan({ cls: "cfo-wikilink-suggest-alias-mark", text: "  " });
        display.createSpan({ cls: "cfo-wikilink-suggest-base", text: item.description });
      }
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.commit(item);
      });
      this.rowEls.push(row);
    }
    this.position();
  }

  private position(): void {
    if (!this.popup) return;
    const rect = this.textarea.getBoundingClientRect();
    const popupHeight = Math.min(this.popup.offsetHeight || 240, 240);
    const placeAbove = rect.top > popupHeight + 16;
    if (placeAbove) {
      this.popup.style.top = `${rect.top - popupHeight - 4}px`;
    } else {
      this.popup.style.top = `${rect.bottom + 4}px`;
    }
    this.popup.style.left = `${rect.left}px`;
    this.popup.style.maxWidth = `${Math.min(rect.width, 480)}px`;
  }

  private move(delta: number): void {
    if (this.items.length === 0) return;
    this.selected = (this.selected + delta + this.items.length) % this.items.length;
    for (let i = 0; i < this.rowEls.length; i++) {
      this.rowEls[i].toggleClass("cfo-wikilink-suggest-row-active", i === this.selected);
    }
    const active = this.rowEls[this.selected];
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  private commit(item: SlashCommand): void {
    if (this.destroyed) return;
    const value = this.textarea.value;
    const caret = this.textarea.selectionStart ?? 0;
    const before = value.slice(0, this.triggerStart);
    const after = value.slice(caret);
    const insert = `/${item.name} `;
    this.textarea.value = `${before}${insert}${after}`;
    const cursor = before.length + insert.length;
    this.textarea.setSelectionRange(cursor, cursor);
    this.close();
    this.textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  private close(): void {
    if (!this.popup) return;
    this.popup.remove();
    this.popup = null;
    this.items = [];
    this.rowEls = [];
    this.selected = 0;
    this.triggerStart = -1;
  }
}
