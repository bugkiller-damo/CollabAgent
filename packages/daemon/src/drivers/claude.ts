import { spawn, ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
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
  onSessionInit?: (sessionId: string) => void;
  onExit?: (code: number | null) => void;
}

export class ClaudeDriver {
  private proc: ChildProcess | null = null;
  private opts: ClaudeDriverOptions;
  private buffer = "";
  public onSessionInit: ((sessionId: string) => void) | undefined;

  constructor(opts: ClaudeDriverOptions) {
    this.opts = opts;
  }

  async start(prompt: string, sessionId?: string): Promise<void> {
    const claudeCmd = (() => {
    const found = resolveCommandOnPath("claude");
    if (found) return found;
    // Try common Windows npm global paths
    const candidates = [
      join(process.env.APPDATA || "", "npm", "claude.cmd"),
      join(process.env.LOCALAPPDATA || "", "Programs", "claude", "claude.cmd"),
      "claude.cmd",
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return "claude.cmd";
  })();
    const args = ["--print", "--output-format", "stream-json", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--model", "sonnet"];
    if (sessionId) args.push("--resume", sessionId);
    if (this.opts.systemPrompt) {
      // Write prompt to file — too long for command-line argument
      const promptFile = join(this.opts.workingDirectory, ".slock", "system-prompt.md");
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(this.opts.workingDirectory, ".slock"), { recursive: true });
      writeFileSync(promptFile, this.opts.systemPrompt);
      args.push("--append-system-prompt-file", promptFile);
    }
    const slockDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".slock");
    const env = { ...process.env, PATH: slockDir + ";" + (process.env.PATH || "") };
    args.push(prompt);
    this.proc = spawn(claudeCmd, args, {
      cwd: this.opts.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      env,
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
          const sid = event.session_id as string;
          this.opts.onEvent({ kind: "session_init", sessionId: sid });
          this.opts.onSessionInit?.(sid);
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
