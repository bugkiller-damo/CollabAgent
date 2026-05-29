import { spawn, ChildProcess } from "node:child_process";
import { resolveCommandOnPath } from "./probe.js";

export interface ClaudeEvent {
  kind: "thinking" | "text" | "tool_call" | "tool_output" | "session_init" | "error" | "turn_end";
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  sessionId?: string;
  message?: string;
}

export interface ClaudeDriverOptions {
  workingDirectory: string;
  model?: string;
  systemPrompt?: string;
  onEvent: (event: ClaudeEvent) => void;
  onExit?: (code: number | null) => void;
}

export class ClaudeDriver {
  private proc: ChildProcess | null = null;
  private opts: ClaudeDriverOptions;
  private buffer = "";

  constructor(opts: ClaudeDriverOptions) {
    this.opts = opts;
  }

  async start(prompt: string, sessionId?: string): Promise<void> {
    const claudeCmd = resolveCommandOnPath("claude") || "claude";
    const args = [
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--model", this.opts.model || "sonnet",
      "--permission-mode", "bypassPermissions",
      "--dangerously-skip-permissions",
    ];
    if (sessionId) args.push("--resume", sessionId);
    if (this.opts.systemPrompt) args.push("--append-system-prompt", this.opts.systemPrompt);

    this.proc = spawn(claudeCmd, args, {
      cwd: this.opts.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      console.error("[ClaudeDriver] stderr:", chunk.toString().slice(0, 200));
    });

    this.proc.on("exit", (code) => {
      console.log(`[ClaudeDriver] exited with code ${code}`);
      this.opts.onExit?.(code);
    });

    // Send initial prompt
    const input = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: prompt }] },
      ...(sessionId ? { session_id: sessionId } : {}),
    });
    this.proc.stdin?.write(input + "\n");
  }

  sendMessage(text: string): void {
    if (!this.proc?.stdin) return;
    const input = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    });
    this.proc.stdin.write(input + "\n");
  }

  sendToolResult(toolUseId: string, content: string, isError = false): void {
    if (!this.proc?.stdin) return;
    const input = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
      },
    });
    this.proc.stdin.write(input + "\n");
  }

  async stop(): Promise<void> {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  get isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        this.parseEvent(event);
      } catch {
        // Skip unparseable
      }
    }
  }

  private parseEvent(event: Record<string, unknown>): void {
    switch (event.type) {
      case "system": {
        if (event.subtype === "init" && event.session_id) {
          this.opts.onEvent({ kind: "session_init", sessionId: event.session_id as string });
        }
        break;
      }
      case "assistant": {
        const msg = event.message as Record<string, unknown> | undefined;
        const content = msg?.content as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block.type === "thinking" && block.thinking) {
            this.opts.onEvent({ kind: "thinking", text: block.thinking as string });
          } else if (block.type === "text" && block.text) {
            this.opts.onEvent({ kind: "text", text: block.text as string });
          } else if (block.type === "tool_use") {
            this.opts.onEvent({
              kind: "tool_call",
              name: (block.name as string) || "unknown",
              input: (block.input as Record<string, unknown>) || {},
            });
          }
        }
        break;
      }
      case "user": {
        const msg = event.message as Record<string, unknown> | undefined;
        const content = msg?.content as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") {
              this.opts.onEvent({ kind: "tool_output", name: (block.tool_use_id as string) || "tool" });
            }
          }
        }
        break;
      }
      case "result": {
        if (event.subtype === "success") {
          this.opts.onEvent({ kind: "turn_end" });
        } else if (event.is_error) {
          const msg = (event.errors as string[])?.join("; ") || "unknown error";
          this.opts.onEvent({ kind: "error", message: msg });
        }
        break;
      }
    }
  }
}
