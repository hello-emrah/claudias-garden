/**
 * Line-level diff via classic LCS DP. No external deps. Pure functions —
 * no Obsidian imports, no DOM, no plugin state. Reused by the rich
 * tool-row Edit/Write expand and by the cfob-i4 permission-prompt edit
 * preview dialog.
 *
 * Intra-line character diff is out of scope.
 */

export type DiffOpKind = "eq" | "add" | "del";

export interface DiffOp {
  kind: DiffOpKind;
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffSummary {
  add: number;
  del: number;
}

const splitLines = (s: string): string[] => {
  if (s === "") return [];
  return s.split("\n");
};

/**
 * Compute the line-level diff between two strings. Returns a sequential
 * op list walking from start to end of both inputs. Equal lines carry
 * both line numbers; adds carry only newLine; deletes carry only
 * oldLine. Line numbers are 1-indexed per the conventional diff display.
 */
export function lineDiff(oldText: string, newText: string): DiffOp[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const m = a.length;
  const n = b.length;

  // Standard LCS table. dp[i][j] = LCS length of a[i..] and b[j..]; we
  // build from the end so the walk-back goes forward through both inputs.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ kind: "eq", text: a[i], oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "del", text: a[i], oldLine: i + 1 });
      i++;
    } else {
      ops.push({ kind: "add", text: b[j], newLine: j + 1 });
      j++;
    }
  }
  while (i < m) {
    ops.push({ kind: "del", text: a[i], oldLine: i + 1 });
    i++;
  }
  while (j < n) {
    ops.push({ kind: "add", text: b[j], newLine: j + 1 });
    j++;
  }
  return ops;
}

export function summarizeDiff(ops: DiffOp[]): DiffSummary {
  let add = 0;
  let del = 0;
  for (const op of ops) {
    if (op.kind === "add") add++;
    else if (op.kind === "del") del++;
  }
  return { add, del };
}

export interface RenderDiffOptions {
  /** Show line-number gutter columns. Default true. */
  gutter?: boolean;
  /** Optional line-number offset for the old side (e.g. Edit fragments
   *  inside a larger file). Defaults to 0. */
  oldLineOffset?: number;
  /** Optional line-number offset for the new side. */
  newLineOffset?: number;
}

/**
 * Paint a computed diff into the host element. Caller controls when and
 * where; this just creates the row structure. CSS classes:
 *   .cfo-tool-diff               (block container)
 *   .cfo-tool-diff-line          (single row)
 *   .cfo-tool-diff-line-eq       (unchanged, faint)
 *   .cfo-tool-diff-line-add      (green tint)
 *   .cfo-tool-diff-line-del      (red tint)
 *   .cfo-tool-diff-gutter        (line-number cell)
 *   .cfo-tool-diff-marker        (+ / - / space sigil)
 *   .cfo-tool-diff-text          (the line content)
 */
export function renderDiff(
  host: HTMLElement,
  ops: DiffOp[],
  opts: RenderDiffOptions = {},
): void {
  const gutter = opts.gutter ?? true;
  const oldOff = opts.oldLineOffset ?? 0;
  const newOff = opts.newLineOffset ?? 0;
  const block = host.createDiv({ cls: "cfo-tool-diff" });
  for (const op of ops) {
    const row = block.createDiv({ cls: `cfo-tool-diff-line cfo-tool-diff-line-${op.kind}` });
    if (gutter) {
      const oldGut = row.createSpan({ cls: "cfo-tool-diff-gutter cfo-tool-diff-gutter-old" });
      oldGut.setText(op.oldLine != null ? String(op.oldLine + oldOff) : "");
      const newGut = row.createSpan({ cls: "cfo-tool-diff-gutter cfo-tool-diff-gutter-new" });
      newGut.setText(op.newLine != null ? String(op.newLine + newOff) : "");
    }
    const marker = op.kind === "add" ? "+" : op.kind === "del" ? "-" : " ";
    row.createSpan({ cls: "cfo-tool-diff-marker", text: marker });
    row.createSpan({ cls: "cfo-tool-diff-text", text: op.text });
  }
}
