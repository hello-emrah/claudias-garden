import * as fs from "fs";

interface ToolUse {
  id: string;
  name: string;
  input: any;
}

interface ToolResult {
  toolUseId: string;
  content: string;
  isError: boolean;
}

interface Turn {
  role: "user" | "assistant";
  timestamp: string;
  text: string;
  toolUses: ToolUse[];
}

const MAX_TOOL_OUTPUT_CHARS = 6000;

const LANG_BY_TOOL: Record<string, string> = {
  Bash: "bash",
  Read: "json",
  Write: "json",
  Edit: "json",
  Glob: "json",
  Grep: "json",
  ToolSearch: "json",
};

export interface ExportResult {
  filename: string;
  body: string;
}

export function exportSession(opts: {
  jsonlPath: string;
  cwd: string;
  vaultName: string;
}): ExportResult | null {
  let raw: string;
  try {
    raw = fs.readFileSync(opts.jsonlPath, "utf8");
  } catch {
    return null;
  }

  const turns: Turn[] = [];
  const toolResultsById: Map<string, ToolResult> = new Map();
  let sessionId = "";
  let totalTokens = 0;
  let totalDurationMs = 0;
  let createdISO = "";
  const datesSeen: Set<string> = new Set();

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }

    if (typeof evt.sessionId === "string" && !sessionId) sessionId = evt.sessionId;
    if (typeof evt.timestamp === "string" && !createdISO) createdISO = evt.timestamp;
    if (typeof evt.timestamp === "string") {
      const d = evt.timestamp.slice(0, 10);
      if (d) datesSeen.add(d);
    }

    if (evt.type === "user" && evt.message?.content) {
      const content = evt.message.content;
      if (typeof content === "string") {
        if (isSkillInjection(content)) continue;
        turns.push({
          role: "user",
          timestamp: evt.timestamp || "",
          text: content,
          toolUses: [],
        });
      } else if (Array.isArray(content)) {
        const texts: string[] = [];
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string") {
            texts.push(block.text);
          } else if (block?.type === "tool_result" && block.tool_use_id) {
            const tr: ToolResult = {
              toolUseId: block.tool_use_id,
              content: typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content),
              isError: !!block.is_error,
            };
            toolResultsById.set(tr.toolUseId, tr);
          }
        }
        if (texts.length) {
          const joined = texts.join("\n");
          if (isSkillInjection(joined)) continue;
          turns.push({
            role: "user",
            timestamp: evt.timestamp || "",
            text: joined,
            toolUses: [],
          });
        }
      }
      continue;
    }

    if (evt.type === "assistant" && evt.message?.content) {
      let text = "";
      const tools: ToolUse[] = [];
      for (const block of evt.message.content) {
        if (block?.type === "text" && typeof block.text === "string") {
          text += block.text;
        } else if (block?.type === "tool_use") {
          tools.push({
            id: block.id || "",
            name: block.name || "tool",
            input: block.input ?? {},
          });
        }
      }
      const usage = evt.message.usage;
      if (usage) {
        const turnTokens = (Number(usage.input_tokens) || 0)
          + (Number(usage.output_tokens) || 0)
          + (Number(usage.cache_creation_input_tokens) || 0)
          + (Number(usage.cache_read_input_tokens) || 0);
        if (turnTokens > totalTokens) totalTokens = turnTokens;
      }
      // Merge into the most recent assistant turn if it's part of the same response,
      // otherwise start a new turn. We treat each assistant event as its own turn here
      // and let consecutive ones render under one heading via grouping at output time.
      turns.push({
        role: "assistant",
        timestamp: evt.timestamp || "",
        text,
        toolUses: tools,
      });
      continue;
    }

    if (evt.type === "result") {
      if (typeof evt.duration_ms === "number") totalDurationMs += evt.duration_ms;
      continue;
    }
  }

  if (turns.length === 0) return null;

  const created = createdISO ? createdISO.slice(0, 10) : todayDate();
  const stamp = createdISO ? localStamp(createdISO) : nowStamp();
  const firstUser = turns.find((t) => t.role === "user")?.text ?? "";
  const slug = slugify(firstUser);
  const filename = slug
    ? `Claude Chat ${created} ${stamp} ${slug}.md`
    : `Claude Chat ${created} ${stamp}.md`;

  const dateRange = Array.from(datesSeen).sort().reverse();
  const body = renderBody({
    turns,
    toolResultsById,
    dateRange,
  });

  return { filename, body };
}

function renderBody(args: {
  turns: Turn[];
  toolResultsById: Map<string, ToolResult>;
  dateRange: string[];
}): string {
  const front = [
    "---",
    "doctype: chat-transcript",
    "agent: Claude",
    "date_range:",
    ...args.dateRange.map((d) => `  - "[[${d}]]"`),
    "---",
    "",
  ].join("\n");

  // Group consecutive assistant turns under a single heading.
  // Tool calls intentionally omitted from the prose-only export.
  const sections: string[] = [];
  let i = 0;
  while (i < args.turns.length) {
    const t = args.turns[i];
    if (t.role === "user") {
      sections.push(`## ${formatTime(t.timestamp)} - You\n\n${wrapUserContent(t.text.trim())}\n`);
      i++;
      continue;
    }
    const parts: string[] = [];
    const headingTime = formatTime(t.timestamp);
    while (i < args.turns.length && args.turns[i].role === "assistant") {
      const at = args.turns[i];
      if (at.text.trim()) parts.push(demoteHeadings(at.text.trim()));
      i++;
    }
    sections.push(`## ${headingTime} - Claude\n\n${parts.join("\n\n")}\n`);
  }

  return front + sections.join("\n");
}

// Smart fence: keep prose with wikilinks rendering live; only fence-wrap
// when the body shows signs of having been pasted from elsewhere and
// could break the markdown cascade.
function wrapUserContent(body: string): string {
  if (looksDangerous(body)) {
    let longest = 0;
    const matches = body.match(/`+/g);
    if (matches) for (const m of matches) if (m.length > longest) longest = m.length;
    const fence = "`".repeat(Math.max(3, longest + 1));
    return `${fence}markdown\n${body}\n${fence}`;
  }
  return demoteHeadings(body);
}

function looksDangerous(body: string): boolean {
  if (/<[a-zA-Z][\w-]*(?:\s|>|\/)/.test(body)) return true;
  const fenceCount = (body.match(/^```/gm) || []).length;
  if (fenceCount % 2 !== 0) return true;
  if (/\S{300,}/.test(body)) return true;
  if (body.length > 4000) return true;
  return false;
}

// Speaker headings are H2. Anything inside a message must start at H3 or deeper.
// Find the shallowest heading in the body and shift everything so it lands at H3.
// Cap at H6 (Obsidian's max).
function demoteHeadings(body: string): string {
  const headingRe = /^(#{1,6})\s+/gm;
  let shallowest = 7;
  for (const m of body.matchAll(headingRe)) {
    const level = m[1].length;
    if (level < shallowest) shallowest = level;
  }
  if (shallowest >= 3 || shallowest === 7) return body;
  const shift = 3 - shallowest;
  return body.replace(headingRe, (_, hashes: string) => {
    const newLevel = Math.min(6, hashes.length + shift);
    return "#".repeat(newLevel) + " ";
  });
}

function renderToolBlock(tool: ToolUse, result: ToolResult | undefined): string {
  const desc = pickDescription(tool);
  const headerLine = desc
    ? `> **Tool: ${tool.name}** — *${desc}*`
    : `> **Tool: ${tool.name}**`;
  const lang = LANG_BY_TOOL[tool.name] || "";
  const inputText = pickInput(tool);
  const inputFence = blockquoteFence(inputText, lang);
  const outputContent = result ? truncate(result.content) : "";
  const outputFence = result ? blockquoteFence(outputContent, "") : "";
  const errorTag = result && result.isError ? "> *(error)*\n>" : "";
  return [
    headerLine,
    ">",
    inputFence,
    ...(outputFence ? [">", outputFence] : []),
    ...(errorTag ? [errorTag] : []),
  ].join("\n");
}

function pickDescription(tool: ToolUse): string {
  const i = tool.input;
  if (!i || typeof i !== "object") return "";
  if (typeof i.description === "string" && i.description.trim()) return i.description.trim();
  if (typeof i.command === "string") {
    const c = i.command.trim();
    return c.length > 60 ? c.slice(0, 60) + "…" : c;
  }
  return "";
}

function pickInput(tool: ToolUse): string {
  const i = tool.input;
  if (!i || typeof i !== "object") return String(i ?? "");
  if (typeof i.command === "string") return i.command;
  return JSON.stringify(i, null, 2);
}

function blockquoteFence(content: string, lang: string): string {
  const fence = "```";
  const lines = [`> ${fence}${lang}`];
  for (const line of content.split("\n")) {
    lines.push(`> ${line}`);
  }
  lines.push(`> ${fence}`);
  return lines.join("\n");
}

function truncate(s: string): string {
  if (s.length <= MAX_TOOL_OUTPUT_CHARS) return s;
  return s.slice(0, MAX_TOOL_OUTPUT_CHARS) + "\n... (truncated, full output in jsonl)";
}

function formatTime(iso: string): string {
  if (!iso) return "??:??";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "??:??";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localStamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return nowStamp();
  return `${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function nowStamp(): string {
  const d = new Date();
  return `${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function todayDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// Skill-injection detection. When the agent invokes a skill, Claude
// Code emits a separate `user` text message carrying the SKILL.md body
// for the model's context. The message always starts with this prefix.
// Mirrors the same check in view.ts — both surfaces filter consistently.
function isSkillInjection(text: string): boolean {
  return text.trimStart().startsWith("Base directory for this skill:");
}

function slugify(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned.slice(0, 40).replace(/-$/, "");
}
