import { spawn, type ChildProcess } from "child_process";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

export interface AgentConfig {
  id: string;
  name: string;
  runtime: string;   // "claude" | "deepseek-cli" | ...
  model?: string;
  workspace: string; // project directory
  serverUrl: string;
  apiKey: string;
}

export interface ParsedEvent {
  type: "thinking" | "text" | "tool_call" | "tool_output" | "error" | "session_init" | "turn_end";
  content?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolId?: string;
}

export interface AgentStatus {
  agentId: string;
  state: "offline" | "idle" | "thinking" | "working";
  currentAction?: string;
}

export class AgentProcessManager {
  private process: ChildProcess | null = null;
  private config: AgentConfig;
  private onStatusChange: (status: AgentStatus) => void;
  private onReply: (content: string) => Promise<void>;
  private stdoutBuffer = "";

  constructor(
    config: AgentConfig,
    callbacks: {
      onStatusChange: (status: AgentStatus) => void;
      onReply: (content: string) => Promise<void>;
    }
  ) {
    this.config = config;
    this.onStatusChange = callbacks.onStatusChange;
    this.onReply = callbacks.onReply;
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  async start(): Promise<boolean> {
    const runtime = await this.detectRuntime();
    if (!runtime) {
      console.log(`[AgentManager] No ${this.config.runtime} runtime detected`);
      return false;
    }

    const args = this.buildArgs(runtime);
    console.log(`[AgentManager] Starting ${runtime} with args:`, args.slice(0, 5).join(" "));
    this.process = spawn(runtime, args, {
      cwd: this.config.workspace,
      env: {
        ...process.env,
        SLOCK_AGENT_ID: this.config.id,
        SLOCK_SERVER_URL: this.config.serverUrl,
        SLOCK_AGENT_TOKEN: this.config.apiKey,
        FORCE_COLOR: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdout?.on("data", (chunk: Buffer) => this.handleStdout(chunk.toString()));
    this.process.stderr?.on("data", (chunk: Buffer) => console.error("[AgentManager] stderr:", chunk.toString().slice(0, 200)));
    this.process.on("exit", (code) => {
      console.log(`[AgentManager] Process exited with code ${code}`);
      this.process = null;
      this.onStatusChange({ agentId: this.config.id, state: "offline" });
    });

    this.onStatusChange({ agentId: this.config.id, state: "idle" });
    return true;
  }

  async sendMessage(content: string, senderName: string): Promise<void> {
    if (!this.process || !this.process.stdin) return;

    const message = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: `@${senderName} said in channel: ${content}`,
      },
      session_id: this.config.id,
    }) + "\n";

    this.process.stdin.write(message);
    this.onStatusChange({ agentId: this.config.id, state: "thinking", currentAction: "analyzing message" });
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill("SIGTERM");
      setTimeout(() => { if (this.process && !this.process.killed) this.process.kill("SIGKILL"); }, 5000);
    }
  }

  private async detectRuntime(): Promise<string | null> {
    // Check for Claude Code
    const claudePaths = ["claude", "claude-code", join(process.env.APPDATA || "", "npm", "claude.cmd")];
    for (const p of claudePaths) {
      if (this.commandExists(p)) return p;
    }
    return null;
  }

  private commandExists(cmd: string): boolean {
    try {
      const result = require("child_process").spawnSync(cmd, ["--version"], { timeout: 5000, windowsHide: true });
      return result.status === 0;
    } catch {
      return false;
    }
  }

  private buildArgs(runtime: string): string[] {
    // Generate slock CLI wrapper config for the agent
    const slockCli = join(process.cwd(), "..", "cli", "index.js");

    if (runtime.includes("claude")) {
      return [
        "--dangerously-skip-permissions",
        "--verbose",
        "--output-format", "stream-json",
        "--model", this.config.model || "sonnet",
      ];
    }
    return [];
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event: ParsedEvent = JSON.parse(line);
        this.handleEvent(event);
      } catch {
        // Non-JSON line (log output) — ignore
      }
    }
  }

  private handleEvent(event: ParsedEvent): void {
    switch (event.type) {
      case "thinking":
        this.onStatusChange({ agentId: this.config.id, state: "thinking", currentAction: event.content?.slice(0, 100) });
        break;
      case "text":
        if (event.content) {
          this.onReply(event.content);
        }
        break;
      case "tool_call":
        this.onStatusChange({
          agentId: this.config.id,
          state: "working",
          currentAction: `calling ${event.toolName || "unknown tool"}`,
        });
        // Tool calls are handled by Claude Code internally — no need to intercept
        break;
      case "tool_output":
        // Tool output received — agent is still working
        break;
      case "turn_end":
        this.onStatusChange({ agentId: this.config.id, state: "idle" });
        break;
      case "session_init":
        console.log("[AgentManager] Session initialized");
        break;
      case "error":
        console.error("[AgentManager] Error:", event.content);
        break;
    }
  }
}
