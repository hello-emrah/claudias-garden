import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EFFORT_OPTIONS } from "./settings";
import type { ClaudeForObsidianSettings } from "./settings";

// Validation set so a stale settings value (e.g. `extra-high` left over
// from before the 2026-05-11 audit) doesn't get passed to the CLI and
// trigger an "unknown effort" error.
const VALID_EFFORTS = new Set<string>(EFFORT_OPTIONS.map((e) => e.id));

export type StreamEvent =
  | { kind: "system"; raw: any }
  | { kind: "assistant-text"; text: string }
  | { kind: "tool-use"; id: string | null; name: string; input: any }
  | { kind: "tool-result"; toolUseId: string | null; content: string; isError: boolean }
  | {
      kind: "permission-request";
      requestId: string;
      toolUseId: string;
      toolName: string;
      input: any;
      blockedPath?: string;
      decisionReason?: string;
    }
  | { kind: "result"; raw: any }
  | { kind: "error"; message: string }
  | { kind: "stderr"; line: string }
  | { kind: "exit"; code: number | null };

/** Decision payload sent back to the CLI when a permission dialog
 *  settles. The CLI consumes this via the PreToolUse hook protocol —
 *  `allow` permits the tool use (optionally with updated input);
 *  `deny` blocks it with an optional message back to the model. */
export type PermissionDecision =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message?: string };

const HOOK_CALLBACK_ID = "cfob-pretooluse";

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
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      this.opts.settings.permissionMode,
    ];
    if (this.opts.settings.model) {
      args.push("--model", this.opts.settings.model);
    }
    if (this.opts.settings.effort && VALID_EFFORTS.has(this.opts.settings.effort)) {
      args.push("--effort", this.opts.settings.effort);
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

    // Initialize handshake — registers a PreToolUse hook so the CLI
    // routes permission decisions back to us via hook_callback control
    // requests. Without this the CLI auto-denies any tool call that
    // would otherwise prompt the user (confirmed against the binary on
    // 2026-05-11). Hook matches every tool; our hook handler decides
    // whether to auto-allow safe operations or show the dialog.
    const initMsg = {
      type: "control_request",
      request_id: this.makeRequestId(),
      request: {
        subtype: "initialize",
        hooks: {
          PreToolUse: [
            {
              matcher: "",
              hookCallbackIds: [HOOK_CALLBACK_ID],
              timeout: 600000,
            },
          ],
        },
      },
    };
    // stream-json input: after initialize, send the user message as a
    // JSONL line. stdin stays open so we can write control_response
    // lines back when the CLI emits hook_callback requests mid-turn.
    // Closed on `result` or cancel so the CLI exits cleanly.
    const userMsg = {
      type: "user",
      message: { role: "user", content: this.opts.prompt },
      parent_tool_use_id: null,
    };
    try {
      child.stdin.write(JSON.stringify(initMsg) + "\n");
      child.stdin.write(JSON.stringify(userMsg) + "\n");
    } catch (e: any) {
      this.opts.onEvent({ kind: "error", message: `Failed to write to CLI: ${e.message}` });
    }

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
    this.endStdin();
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
  }

  /** Send a structured control_response back to the CLI's stdin to
   *  settle the PreToolUse hook callback. The PermissionDecision is
   *  translated into the CLI's expected hookSpecificOutput shape. */
  respondPermission(requestId: string, decision: PermissionDecision): void {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) return;
    const response =
      decision.behavior === "allow"
        ? {
            decision: "approve",
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              permissionDecisionReason: "User approved via Claude for Obsidian",
              updatedInput: decision.updatedInput,
            },
          }
        : {
            decision: "block",
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: decision.message ?? "User denied via Claude for Obsidian",
            },
          };
    const payload = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response,
      },
    };
    try {
      this.child.stdin.write(JSON.stringify(payload) + "\n");
    } catch (e: any) {
      this.opts.onEvent({ kind: "error", message: `Failed to send permission response: ${e.message}` });
    }
  }

  /** Generate a random request id for our outbound control_requests
   *  (initialize, etc.). Format matches the CLI's own usage — a UUID-ish
   *  string. */
  private makeRequestId(): string {
    return `cfob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /** Close stdin so the CLI can exit cleanly after the turn lands. */
  endStdin(): void {
    if (this.child && this.child.stdin && !this.child.stdin.destroyed) {
      try {
        this.child.stdin.end();
      } catch {
        // already closed; harmless
      }
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
          this.opts.onEvent({
            kind: "tool-use",
            id: typeof block.id === "string" ? block.id : null,
            name: block.name,
            input: block.input,
          });
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
            toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : null,
            content,
            isError: !!block.is_error,
          });
        }
      }
      return;
    }
    if (type === "control_request" && evt.request?.subtype === "hook_callback") {
      // CLI invoking our registered PreToolUse hook. The input payload
      // carries the tool name and arguments; we route to the view which
      // either auto-allows safe ops or shows the permission dialog.
      const req = evt.request;
      const input = req.input ?? {};
      if (input.hook_event_name === "PreToolUse") {
        this.opts.onEvent({
          kind: "permission-request",
          requestId: typeof evt.request_id === "string" ? evt.request_id : "",
          toolUseId: typeof input.tool_use_id === "string" ? input.tool_use_id : "",
          toolName: typeof input.tool_name === "string" ? input.tool_name : "",
          input: input.tool_input ?? {},
        });
      } else {
        // Unknown hook callback — return an empty success so the CLI
        // doesn't block waiting on a hook we didn't register.
        try {
          this.child?.stdin.write(
            JSON.stringify({
              type: "control_response",
              response: { subtype: "success", request_id: evt.request_id, response: {} },
            }) + "\n",
          );
        } catch {
          // best-effort
        }
      }
      return;
    }
    if (type === "result") {
      this.opts.onEvent({ kind: "result", raw: evt });
      // Turn landed. Close stdin so the CLI exits cleanly. Without this
      // the child sits waiting for more stream-json input until we kill
      // it on cancel — leaks subprocesses across turns.
      this.endStdin();
      return;
    }
  }
}
