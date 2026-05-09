import { setIcon } from "obsidian";
import {
  ClaudeForObsidianSettings,
  ClaudeEffort,
  MODEL_OPTIONS,
  EFFORT_OPTIONS,
} from "./settings";

export interface ModelPopupContext {
  settings: ClaudeForObsidianSettings;
  triggerEl: HTMLElement;
  onModelChange: (id: string) => Promise<void> | void;
  onEffortChange: (effort: ClaudeEffort) => Promise<void> | void;
  onFastModeChange: (enabled: boolean) => Promise<void> | void;
}

export function openModelPopup(ctx: ModelPopupContext): void {
  const doc = ctx.triggerEl.ownerDocument;
  doc.querySelectorAll(".cfo-model-popup").forEach((el) => el.remove());

  const popup = doc.body.createDiv({ cls: "cfo-model-popup" });
  const rect = ctx.triggerEl.getBoundingClientRect();
  popup.style.bottom = `${doc.defaultView!.innerHeight - rect.top + 6}px`;
  popup.style.right = `${doc.defaultView!.innerWidth - rect.right}px`;

  // Models section
  popup.createDiv({ cls: "cfo-model-popup-section-label", text: "Models" });
  for (const m of MODEL_OPTIONS) {
    const row = popup.createDiv({ cls: "cfo-model-popup-row" });
    if (ctx.settings.model === m.id) row.addClass("cfo-model-popup-row-active");
    const label = row.createSpan({ cls: "cfo-model-popup-row-label" });
    label.createSpan({ text: m.label });
    if (m.sublabel) {
      label.createSpan({
        cls: m.legacy ? "cfo-model-popup-sublabel-legacy" : "cfo-model-popup-sublabel",
        text: m.sublabel,
      });
    }
    if (ctx.settings.model === m.id) {
      const check = row.createSpan({ cls: "cfo-model-popup-check" });
      setIcon(check, "check");
    }
    row.onclick = async (e) => {
      e.stopPropagation();
      await ctx.onModelChange(m.id);
      popup.remove();
    };
  }

  popup.createDiv({ cls: "cfo-model-popup-divider" });

  // Effort section
  popup.createDiv({ cls: "cfo-model-popup-section-label", text: "Effort" });
  for (const e of EFFORT_OPTIONS) {
    const row = popup.createDiv({ cls: "cfo-model-popup-row" });
    if (ctx.settings.effort === e.id) row.addClass("cfo-model-popup-row-active");
    row.createSpan({ cls: "cfo-model-popup-row-label", text: e.label });
    if (ctx.settings.effort === e.id) {
      const check = row.createSpan({ cls: "cfo-model-popup-check" });
      setIcon(check, "check");
    }
    row.onclick = async (evt) => {
      evt.stopPropagation();
      await ctx.onEffortChange(e.id);
      popup.remove();
    };
  }

  popup.createDiv({ cls: "cfo-model-popup-divider" });

  // Fast mode section
  popup.createDiv({ cls: "cfo-model-popup-section-label", text: "Fast mode" });
  const fastRow = popup.createDiv({ cls: "cfo-model-popup-row cfo-model-popup-row-toggle" });
  fastRow.createSpan({ cls: "cfo-model-popup-row-label", text: "Enable fast mode" });
  const toggle = fastRow.createDiv({ cls: "cfo-model-popup-toggle" });
  if (ctx.settings.fastMode) toggle.addClass("cfo-model-popup-toggle-on");
  toggle.createDiv({ cls: "cfo-model-popup-toggle-knob" });
  fastRow.onclick = async (e) => {
    e.stopPropagation();
    await ctx.onFastModeChange(!ctx.settings.fastMode);
    popup.remove();
  };

  // Dismiss handlers
  const dismiss = (e: MouseEvent) => {
    if (!popup.contains(e.target as Node)) {
      popup.remove();
      doc.removeEventListener("mousedown", dismiss, true);
      doc.removeEventListener("keydown", esc, true);
    }
  };
  const esc = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
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
