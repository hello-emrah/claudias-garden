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

export interface SessionOptions {
  cwd: string;
  settings: ClaudeForObsidianSettings;
  resumeSessionId?: string | null;
  onEvent: (event: StreamEvent) => void;
}

/**
 * One long-lived `claude` CLI subprocess per chat. Spawned lazily on
 * the first sendMessage; stays alive across subsequent user messages
 * in the same chat so in-memory state (CronCreate schedulers, watchers,
 * model-side context) survives between turns.
 *
 * Lifecycle:
 *   - new ClaudeSession({...}) — no side effects.
 *   - session.sendMessage(prompt) — first call spawns, sends initialize
 *     handshake, writes the user JSONL. Subsequent calls just write
 *     the next user JSONL to the same stdin.
 *   - session.respondPermission(id, decision) — writes a control_response
 *     for a pending PreToolUse hook_callback.
 *   - session.cancel() — sends an `interrupt` control_request. Subprocess
 *     stays alive; user can send another message.
 *   - session.end() — closes stdin so the CLI exits cleanly. Used on
 *     chat switch, new chat, delete-active-chat, panel close, plugin
 *     unload.
 */
export class ClaudeSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private initSent = false;
  private alive = false;
  private stdoutBuffer = "";

  constructor(private opts: SessionOptions) {}

  /** True if a subprocess is currently running for this session. */
  get isAlive(): boolean {
    return this.alive;
  }

  /** Send a user message to the CLI. Spawns the subprocess on first
   *  call. Idempotent across multiple turns within the same chat. */
  sendMessage(prompt: string): void {
    if (!this.alive) {
      this.spawnChild();
      if (!this.alive) return; // spawn failed; error event already emitted
    }
    if (!this.initSent) {
      this.writeStdin(this.initializeRequest());
      this.initSent = true;
    }
    const userMsg = {
      type: "user",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
    };
    this.writeStdin(userMsg);
  }

  /** Send an `interrupt` control_request to abort the current turn
   *  without killing the subprocess. The CLI honours this by stopping
   *  the in-flight model call and emitting a `result` event. */
  cancel(): void {
    if (!this.alive) return;
    this.writeStdin({
      type: "control_request",
      request_id: this.makeRequestId(),
      request: { subtype: "interrupt" },
    });
  }

  /** Close stdin so the CLI exits cleanly. Triggered on chat switch,
   *  new chat, delete-active-chat, panel close, plugin unload. */
  end(): void {
    if (this.child && this.child.stdin && !this.child.stdin.destroyed) {
      try {
        this.child.stdin.end();
      } catch {
        // already closed; harmless
      }
    }
  }

  /** Hard kill via SIGTERM. Used when end() doesn't bring the child
   *  down (or when we don't want to wait). */
  kill(): void {
    this.end();
    if (this.child && !this.child.killed) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // already dead; harmless
      }
    }
  }

  /** Send a structured control_response back to the CLI's stdin to
   *  settle the PreToolUse hook callback. */
  respondPermission(requestId: string, decision: PermissionDecision): void {
    if (!this.alive) return;
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
    this.writeStdin({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response,
      },
    });
  }

  // ---------- internals ----------

  private spawnChild(): void {
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
    this.alive = true;

    child.stdout.on("data", (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = this.stdoutBuffer.indexOf("\n")) !== -1) {
        const line = this.stdoutBuffer.slice(0, nl).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
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
      if (this.stdoutBuffer.trim()) this.dispatchLine(this.stdoutBuffer.trim());
      this.alive = false;
      this.opts.onEvent({ kind: "exit", code });
    });
  }

  /** Build the initialize control_request that registers the PreToolUse
   *  hook so the CLI routes permission decisions back to us. Without
   *  this the CLI auto-denies any tool call that would otherwise prompt
   *  the user (confirmed against the binary on 2026-05-11). */
  private initializeRequest(): any {
    return {
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
  }

  private writeStdin(payload: any): void {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) return;
    try {
      this.child.stdin.write(JSON.stringify(payload) + "\n");
    } catch (e: any) {
      this.opts.onEvent({ kind: "error", message: `Failed to write to CLI: ${e.message}` });
    }
  }

  private makeRequestId(): string {
    return `cfob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
        this.writeStdin({
          type: "control_response",
          response: { subtype: "success", request_id: evt.request_id, response: {} },
        });
      }
      return;
    }
    if (type === "result") {
      // Turn landed. UNLIKE the per-turn architecture (≤ v0.5.1), we do
      // not close stdin here — the subprocess stays alive for the next
      // user message in this chat so in-memory state (cron schedulers,
      // watchers) survives across turns. stdin closes on session.end()
      // when the chat switches or the panel closes.
      this.opts.onEvent({ kind: "result", raw: evt });
      return;
    }
  }
}
