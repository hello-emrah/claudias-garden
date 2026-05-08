import { App, TFile } from "obsidian";

interface SuggestItem {
  display: string;
  insert: string;
  alias: string | null;
  file: TFile;
  mtime: number;
}

export class WikilinkSuggest {
  private popup: HTMLDivElement | null = null;
  private items: SuggestItem[] = [];
  private selected = 0;
  private triggerStart = -1;
  private rowEls: HTMLDivElement[] = [];
  private destroyed = false;

  constructor(private app: App, private textarea: HTMLTextAreaElement) {
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

  private detectTrigger(): { start: number; query: string } | null {
    const value = this.textarea.value;
    const caret = this.textarea.selectionStart ?? 0;
    const head = value.slice(0, caret);
    const open = head.lastIndexOf("[[");
    if (open === -1) return null;
    const between = head.slice(open + 2);
    if (between.includes("]]") || between.includes("\n")) return null;
    return { start: open + 2, query: between };
  }

  private search(query: string): SuggestItem[] {
    const files = this.app.vault.getMarkdownFiles();
    const q = query.toLowerCase();
    const out: SuggestItem[] = [];
    const seen = new Set<string>();

    for (const file of files) {
      const basename = file.basename;
      const aliases = this.aliasesFor(file);
      const candidates: { display: string; alias: string | null }[] = [
        { display: basename, alias: null },
      ];
      for (const a of aliases) candidates.push({ display: a, alias: a });

      for (const c of candidates) {
        if (q.length > 0 && !c.display.toLowerCase().includes(q)) continue;
        const key = `${file.path}::${c.alias ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          display: c.display,
          alias: c.alias,
          insert: c.alias ? `${basename}|${c.alias}` : basename,
          file,
          mtime: file.stat.mtime,
        });
      }
    }

    out.sort((a, b) => {
      const aLower = a.display.toLowerCase();
      const bLower = b.display.toLowerCase();
      const aStarts = aLower.startsWith(q);
      const bStarts = bLower.startsWith(q);
      if (aStarts !== bStarts) return aStarts ? -1 : 1;
      // Recency wins after prefix priority. Most recently modified first.
      if (b.mtime !== a.mtime) return b.mtime - a.mtime;
      return aLower.localeCompare(bLower);
    });

    return out.slice(0, 50);
  }

  private aliasesFor(file: TFile): string[] {
    const cache = this.app.metadataCache.getFileCache(file);
    const raw = cache?.frontmatter?.aliases;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.filter((x) => typeof x === "string");
    if (typeof raw === "string") return [raw];
    return [];
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
      const display = row.createSpan({ cls: "cfo-wikilink-suggest-display", text: item.display });
      if (item.alias) {
        display.createSpan({ cls: "cfo-wikilink-suggest-alias-mark", text: " ↦ " });
        display.createSpan({ cls: "cfo-wikilink-suggest-base", text: item.file.basename });
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
    const win = this.textarea.ownerDocument.defaultView ?? window;
    const popupHeight = Math.min(this.popup.offsetHeight || 240, 240);
    const spaceAbove = rect.top;
    const placeAbove = spaceAbove > popupHeight + 16;
    if (placeAbove) {
      this.popup.style.top = `${rect.top - popupHeight - 4}px`;
    } else {
      this.popup.style.top = `${rect.bottom + 4}px`;
    }
    this.popup.style.left = `${rect.left}px`;
    this.popup.style.maxWidth = `${Math.min(rect.width, 480)}px`;
    void win;
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

  private commit(item: SuggestItem): void {
    if (this.destroyed) return;
    const value = this.textarea.value;
    const caret = this.textarea.selectionStart ?? 0;
    const before = value.slice(0, this.triggerStart);
    const after = value.slice(caret);
    const insert = `${item.insert}]]`;
    const next = `${before}${insert}${after}`;
    const cursor = before.length + insert.length;
    this.textarea.value = next;
    this.textarea.setSelectionRange(cursor, cursor);
    this.close();
    // Re-fire input so autosize updates and any listeners react.
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
