import * as fs from "fs";

interface Turn {
  role: "user" | "assistant";
  timestamp: string;
  text: string;
}

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
        });
      } else if (Array.isArray(content)) {
        // Skill-injection user messages and tool_result-only user messages
        // both get filtered here. Skill injections are explicit. Tool
        // results just produce empty `texts` and the `if (texts.length)`
        // guard skips the push.
        const texts: string[] = [];
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string") {
            texts.push(block.text);
          }
        }
        if (texts.length) {
          const joined = texts.join("\n");
          if (isSkillInjection(joined)) continue;
          turns.push({
            role: "user",
            timestamp: evt.timestamp || "",
            text: joined,
          });
        }
      }
      continue;
    }

    if (evt.type === "assistant" && evt.message?.content) {
      // Prose-only export: collect text blocks, ignore tool_use blocks.
      // The visible chat panel renders tool calls; saved transcripts are
      // distilled to the conversation thread.
      let text = "";
      for (const block of evt.message.content) {
        if (block?.type === "text" && typeof block.text === "string") {
          text += block.text;
        }
      }
      // Each assistant event lands as its own turn. Consecutive
      // assistant turns render under one heading via grouping at output
      // time in renderBody.
      turns.push({
        role: "assistant",
        timestamp: evt.timestamp || "",
        text,
      });
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
    dateRange,
  });

  return { filename, body };
}

function renderBody(args: {
  turns: Turn[];
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
