/**
 * Per-tool row renderers. Replaces the historic `JSON.stringify(input)`
 * row body with idiomatic, tool-specific output. Keeps a default
 * fallback so unknown tools never regress past today's behaviour.
 *
 * The registry is the single source of tool-row chrome. View.ts walks
 * it from both the live tool-use path and the replay path. The verb
 * table that used to live on the view (`toolVerbForName` and its inverse
 * `originalNameForVerb`) is retired in favour of renderer-owned labels.
 */

import { lineDiff, renderDiff, summarizeDiff } from "./diff";

/** Unsettled view of a tool result. `content` and `isError` arrive on
 *  the `tool-result` event; for replay both come from the matched
 *  `tool_result` block in the jsonl. Renderers may safely receive null
 *  when the result hasn't landed (live tool_use with the call still in
 *  flight, or a replay tool whose result is missing from the jsonl). */
export interface ToolResult {
  content: string;
  isError: boolean;
}

/** Output of a tool renderer. The view paints these fields into a
 *  `.cfo-tool-row` and updates the suffix (and re-renders expand
 *  contents) when the result settles. */
export interface RenderOutput {
  /** Past-tense or present-tense leading word: "Editing", "Read",
   *  "Ran", "Searched". Updated when result settles via `settle()`. */
  verb: string;
  /** The bit after the verb: filename, command, pattern, URL. May be
   *  empty when the tool has no natural target. */
  target: string;
  /** Trailing meta like " (3 matches)". Plain-text only. For coloured
   *  diff counts use addCount / delCount instead. May be empty. */
  suffix?: string;
  /** Coloured add count for the row pill, e.g. Edit/Write. Rendered as
   *  a green-tinted span. Omit or set 0 to suppress. */
  addCount?: number;
  /** Coloured delete count, mirror of addCount. Rendered red. */
  delCount?: number;
  /** When set, the renderer wants a chevron and an expandable region.
   *  The view manages the chevron click; the renderer paints the body
   *  on demand into the host element. */
  expand?: (host: HTMLElement) => void;
  /** Default the expand body open on first paint. Edit/Write set this
   *  so the diff is visible the moment the row lands; collapsed rows
   *  stay one chevron away. */
  expandDefault?: boolean;
  /** Heuristic single-line collapsed render for trivial Edits — when
   *  set, the view skips the pill chrome and renders this string flat
   *  on the row. */
  flat?: string;
}

export interface RenderCtx {
  /** Vault root, when known, so renderers can show vault-relative
   *  paths instead of absolute. View injects this via the running cwd. */
  cwd?: string | null;
  /** Tool-use id, for stable HTML node ids if a renderer needs them. */
  toolUseId?: string | null;
}

export type ToolRenderer = (
  input: any,
  result: ToolResult | null,
  ctx: RenderCtx,
) => RenderOutput;

// ---------- helpers ----------

const basename = (p: string): string => {
  if (typeof p !== "string" || !p) return String(p ?? "");
  const slash = p.lastIndexOf("/");
  return slash === -1 ? p : p.slice(slash + 1);
};

const vaultRelative = (p: string, cwd?: string | null): string => {
  if (typeof p !== "string") return String(p ?? "");
  if (cwd && p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
  return p;
};

const lineCount = (s: string): number => {
  if (!s) return 0;
  // Trailing newline shouldn't count as an extra empty line.
  const trimmed = s.endsWith("\n") ? s.slice(0, -1) : s;
  return trimmed.split("\n").length;
};

const truncate = (s: string, max: number): string => {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
};

const firstLine = (s: string): string => {
  if (!s) return "";
  const idx = s.indexOf("\n");
  return idx === -1 ? s : s.slice(0, idx);
};

// ---------- renderers ----------

const renderEdit: ToolRenderer = (input, _result, ctx) => {
  const filePath = typeof input?.file_path === "string" ? input.file_path : "";
  const oldStr = typeof input?.old_string === "string" ? input.old_string : "";
  const newStr = typeof input?.new_string === "string" ? input.new_string : "";
  const name = filePath ? basename(filePath) : "(no path)";
  const rel = filePath ? vaultRelative(filePath, ctx.cwd) : "";

  // Trivial single-line replacement: skip the pill, render flat.
  const oldSingle = !oldStr.includes("\n");
  const newSingle = !newStr.includes("\n");
  const shortish = oldStr.length <= 80 && newStr.length <= 80;
  if (oldSingle && newSingle && shortish && oldStr && newStr) {
    return {
      verb: "Edited",
      target: name,
      flat: `${rel || name}: ${truncate(oldStr, 80)} → ${truncate(newStr, 80)}`,
    };
  }

  const ops = lineDiff(oldStr, newStr);
  const { add, del } = summarizeDiff(ops);
  return {
    verb: "Edited",
    target: name,
    addCount: add,
    delCount: del,
    expandDefault: true,
    expand: (host) => {
      renderDiff(host, ops);
    },
  };
};

const renderWrite: ToolRenderer = (input, _result, ctx) => {
  const filePath = typeof input?.file_path === "string" ? input.file_path : "";
  const content = typeof input?.content === "string" ? input.content : "";
  const name = filePath ? basename(filePath) : "(no path)";
  const lines = lineCount(content);
  return {
    verb: "Wrote",
    target: name,
    addCount: lines,
    expandDefault: true,
    expand: (host) => {
      const ops = lineDiff("", content);
      renderDiff(host, ops);
    },
  };
};

const renderRead: ToolRenderer = (input, _result, ctx) => {
  const filePath = typeof input?.file_path === "string" ? input.file_path : "";
  const name = filePath ? vaultRelative(filePath, ctx.cwd) : "";
  return { verb: "Read", target: name };
};

const renderBash: ToolRenderer = (input, result) => {
  const cmd = typeof input?.command === "string" ? input.command : "";
  const desc = typeof input?.description === "string" ? input.description : "";
  // Suffix surfaces a tiny tail of stdout once the result lands. Helpful
  // signal for "did the script print anything" without bloating the row.
  let suffix = "";
  if (result && !result.isError) {
    const head = firstLine(result.content).trim();
    if (head) suffix = ` → ${truncate(head, 80)}`;
  }
  if (result?.isError) suffix = " (error)";
  return {
    verb: "Ran",
    target: desc ? `${desc}` : truncate(cmd, 120),
    suffix,
  };
};

const renderGlob: ToolRenderer = (input, result) => {
  const pattern = typeof input?.pattern === "string" ? input.pattern : "";
  let suffix = "";
  if (result && !result.isError) {
    const trimmed = result.content.trim();
    if (trimmed) {
      const n = trimmed.split(/\r?\n/).filter(Boolean).length;
      suffix = ` (${n} match${n === 1 ? "" : "es"})`;
    } else {
      suffix = " (0 matches)";
    }
  }
  return { verb: "Globbed", target: pattern, suffix };
};

const renderGrep: ToolRenderer = (input, result) => {
  const pattern = typeof input?.pattern === "string" ? input.pattern : "";
  const path = typeof input?.path === "string" ? input.path : "";
  const target = path ? `${pattern} in ${basename(path)}` : pattern;
  let suffix = "";
  if (result && !result.isError) {
    const trimmed = result.content.trim();
    if (trimmed) {
      const n = trimmed.split(/\r?\n/).filter(Boolean).length;
      suffix = ` (${n} hit${n === 1 ? "" : "s"})`;
    }
  }
  return { verb: "Grepped", target, suffix };
};

const renderTask: ToolRenderer = (input) => {
  const desc = typeof input?.description === "string" ? input.description : "";
  const prompt = typeof input?.prompt === "string" ? input.prompt : "";
  const target = desc || truncate(firstLine(prompt), 120);
  return { verb: "Delegated", target };
};

const renderWebFetch: ToolRenderer = (input) => {
  const url = typeof input?.url === "string" ? input.url : "";
  return { verb: "Fetched", target: url };
};

const renderWebSearch: ToolRenderer = (input) => {
  const query = typeof input?.query === "string" ? input.query : "";
  return { verb: "Searched", target: query };
};

const renderSkill: ToolRenderer = (input) => {
  // Skill loads are headlined in the tool-group header tag (v0.4.5);
  // the row stays bare so the same load doesn't echo twice.
  const skill = typeof input?.skill === "string" ? input.skill : "";
  return { verb: "Loaded", target: skill ? `${skill} skill` : "skill" };
};

const renderTodoWrite: ToolRenderer = (input) => {
  const todos = Array.isArray(input?.todos) ? input.todos : [];
  return {
    verb: "Planned",
    target: todos.length === 1 ? "1 todo" : `${todos.length} todos`,
  };
};

const renderNotebookEdit: ToolRenderer = (input, _r, ctx) => {
  const path = typeof input?.notebook_path === "string" ? input.notebook_path : "";
  return { verb: "Edited", target: path ? basename(path) : "" };
};

const renderToolSearch: ToolRenderer = (input) => {
  const query = typeof input?.query === "string" ? input.query : "";
  return { verb: "Searched tools", target: truncate(query, 80) };
};

// Default fallback: today's behaviour, so unknown / new tools render
// legibly instead of vanishing.
const renderDefault: ToolRenderer = (input) => {
  let summary: string;
  try {
    summary = typeof input === "object" ? JSON.stringify(input) : String(input);
  } catch {
    summary = String(input);
  }
  return { verb: "", target: truncate(summary, 240) };
};

// ---------- registry ----------

const REGISTRY: Record<string, ToolRenderer> = {
  Edit: renderEdit,
  Write: renderWrite,
  Read: renderRead,
  Bash: renderBash,
  Glob: renderGlob,
  Grep: renderGrep,
  Task: renderTask,
  WebFetch: renderWebFetch,
  WebSearch: renderWebSearch,
  Skill: renderSkill,
  TodoWrite: renderTodoWrite,
  NotebookEdit: renderNotebookEdit,
  ToolSearch: renderToolSearch,
};

/** Resolve a renderer for a tool name. Always returns something — falls
 *  through to the default JSON-summary renderer for unknown tools. */
export function getToolRenderer(name: string): ToolRenderer {
  return REGISTRY[name] ?? renderDefault;
}

/** Convenience: run the registry for a given (name, input, result, ctx). */
export function renderToolRow(
  name: string,
  input: any,
  result: ToolResult | null,
  ctx: RenderCtx,
): RenderOutput {
  return getToolRenderer(name)(input, result, ctx);
}
