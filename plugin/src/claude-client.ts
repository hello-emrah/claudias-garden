import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import type { ClaudeForObsidianSettings } from "./settings";

export type StreamEvent =
  | { kind: "system"; raw: any }
  | { kind: "assistant-text"; text: string }
  | { kind: "tool-use"; name: string; input: any }
  | { kind: "tool-result"; content: string; isError: boolean }
  | { kind: "result"; raw: any }
  | { kind: "error"; message: string }
  | { kind: "stderr"; line: string }
  | { kind: "exit"; code: number | null };

export interface RunOptions {
  prompt: string;
  cwd: string;
  settings: ClaudeForObsidianSettings;
  resumeSessionId?: string | null;
  onEvent: (event: StreamEvent) => void;
}

export class ClaudeRun {
  private child: ChildProcessWithoutNullStreams | null = null;
  private cancelled = false;

  constructor(private opts: RunOptions) {}

  start(): void {
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      this.opts.settings.permissionMode,
    ];
    if (this.opts.settings.model) {
      args.push("--model", this.opts.settings.model);
    }
    if (this.opts.resumeSessionId) {
      args.push("--resume", this.opts.resumeSessionId);
    }

    const env = { ...process.env };
    const pathAdditions = ["/opt/homebrew/bin", "/usr/local/bin"];
    const existingPath = env.PATH ?? "";
    const pathParts = existingPath.split(":").filter(Boolean);
    for (const p of pathAdditions) {
      if (!pathParts.includes(p)) pathParts.unshift(p);
    }
    env.PATH = pathParts.join(":");

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.opts.settings.claudeBinaryPath, args, {
        cwd: this.opts.cwd,
        env,
      });
    } catch (e: any) {
      this.opts.onEvent({ kind: "error", message: `Failed to spawn claude: ${e.message}` });
      this.opts.onEvent({ kind: "exit", code: null });
      return;
    }
    this.child = child;

    child.stdin.write(this.opts.prompt);
    child.stdin.end();

    let stdoutBuffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, nl).trim();
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        if (!line) continue;
        this.dispatchLine(line);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) {
        if (line.trim()) this.opts.onEvent({ kind: "stderr", line });
      }
    });

    child.on("error", (err) => {
      this.opts.onEvent({ kind: "error", message: err.message });
    });

    child.on("close", (code) => {
      if (stdoutBuffer.trim()) this.dispatchLine(stdoutBuffer.trim());
      this.opts.onEvent({ kind: "exit", code });
    });
  }

  cancel(): void {
    this.cancelled = true;
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
  }

  private dispatchLine(line: string): void {
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      this.opts.onEvent({ kind: "stderr", line: `[non-json] ${line}` });
      return;
    }
    const type = evt.type;
    if (type === "system") {
      this.opts.onEvent({ kind: "system", raw: evt });
      return;
    }
    if (type === "assistant" && evt.message?.content) {
      for (const block of evt.message.content) {
        if (block.type === "text") {
          this.opts.onEvent({ kind: "assistant-text", text: block.text });
        } else if (block.type === "tool_use") {
          this.opts.onEvent({ kind: "tool-use", name: block.name, input: block.input });
        }
      }
      return;
    }
    if (type === "user" && evt.message?.content) {
      for (const block of evt.message.content) {
        if (block.type === "tool_result") {
          const content = typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content);
          this.opts.onEvent({
            kind: "tool-result",
            content,
            isError: !!block.is_error,
          });
        }
      }
      return;
    }
    if (type === "result") {
      this.opts.onEvent({ kind: "result", raw: evt });
      return;
    }
  }
}
