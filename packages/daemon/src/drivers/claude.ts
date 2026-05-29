import { execFile } from "node:child_process";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolveCommandOnPath } from "./probe.js";

export interface ClaudeEvent {
  kind: "thinking" | "text" | "tool_call" | "tool_output" | "session_init" | "error" | "turn_end";
  text?: string; name?: string; input?: Record<string, unknown>;
  sessionId?: string; message?: string;
}

export interface ClaudeDriverOptions {
  workingDirectory: string;
  model?: string;
  systemPrompt?: string;
}

export class ClaudeDriver {
  private sessionId: string | null = null;
  private promptFile: string = "";
  isRunning = true;

  constructor(private opts: ClaudeDriverOptions) {}

  async start(sessionId?: string): Promise<void> {
    this.sessionId = sessionId || null;
    if (this.opts.systemPrompt) {
      mkdirSync(join(this.opts.workingDirectory, ".slock"), { recursive: true });
      this.promptFile = join(this.opts.workingDirectory, ".slock", "system-prompt.md");
      writeFileSync(this.promptFile, this.opts.systemPrompt);
    }
  }

  async query(text: string): Promise<string | null> {
    return new Promise((resolve) => {
      const claudeCmd = resolveCommandOnPath("claude") || "claude.cmd";
      const args = ["--print", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
      if (this.sessionId) args.push("--resume", this.sessionId);
      if (this.promptFile) args.push("--append-system-prompt-file", this.promptFile);
      args.push(text);

      execFile(claudeCmd, args, {
        cwd: this.opts.workingDirectory,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120000,
      }, (err, stdout, stderr) => {
        if (stderr) console.error("[Claude]", stderr.slice(0, 200));
        if (err) { resolve(null); return; }

        let result = "";
        for (const line of stdout.split("\n")) {
          try {
            const evt = JSON.parse(line.trim());
            if (evt.type === "system" && evt.session_id && !this.sessionId) {
              this.sessionId = evt.session_id;
            }
            if (evt.type === "assistant") {
              for (const b of evt.message?.content || []) {
                if (b.type === "text") result += b.text;
              }
            }
          } catch {}
        }
        resolve(result || null);
      });
    });
  }

  async stop(): Promise<void> { this.sessionId = null; }
}
