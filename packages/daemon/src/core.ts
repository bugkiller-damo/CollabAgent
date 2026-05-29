import { WebSocket } from "ws";
import { ClaudeDriver } from "./drivers/claude.js";
import { ApiClient } from "./client.js";
import type { AgentContext } from "./auth.js";
import { AgentProcessManager, type AgentStatus } from "./agent-manager.js";

export interface DaemonConfig {
  serverUrl: string;
  apiKey: string;
  dataDir?: string;
}

export class DaemonCore {
  private ws: WebSocket | null = null;
  private serverUrl: string;
  private apiKey: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private client: ApiClient;
  private agentId = "00000000-0000-0000-0000-000000000001";
  private agentDrivers = new Map<string, ClaudeDriver>();

  constructor(private config: DaemonConfig) {
    this.serverUrl = config.serverUrl;
    this.apiKey = config.apiKey;
    const ctx: AgentContext = {
      agentId: this.agentId,
      serverUrl: config.serverUrl,
      serverId: null,
      token: config.apiKey,
      clientMode: "legacy-machine",
      secretSource: "legacy-token-env",
      activeCapabilities: null,
    };
    this.client = new ApiClient(ctx);
  }

  start(): void {
    console.log(`[Daemon] Starting with server ${this.config.serverUrl}`);
    this.connect();
  }

  private connect(): void {
    const url = new URL("/ws", this.config.serverUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(url.toString(), {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    });
    this.ws.on("open", () => {
      console.log("[Daemon] Connected to server");
      this.reconnectDelay = 1000;
      this.ws?.send(JSON.stringify({
        type: "ready", capabilities: ["send", "read"],
        runtimes: ["daemon-cli"],
        hostname: process.env.COMPUTERNAME || "unknown",
        daemonVersion: "0.1.0",
      }));
    });
    this.ws.on("message", (data) => {
      try { this.handleMessage(JSON.parse(data.toString())); } catch {}
    });
    this.ws.on("close", () => {
      console.log("[Daemon] Disconnected, reconnecting...");
      this.scheduleReconnect();
    });
    this.ws.on("error", (err) => console.error("[Daemon] WebSocket error:", err.message));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.connect();
    }, this.reconnectDelay);
  }

  // Agent tools definitions
  private getTools() {
    return [
      {
        type: "function" as const,
        function: {
          name: "read_file",
          description: "Read a file from the local filesystem",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Absolute file path" },
            },
            required: ["path"],
          },
        },
      },
      {
        type: "function" as const,
        function: {
          name: "write_file",
          description: "Write content to a local file (creates parent directories if needed)",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Absolute file path" },
              content: { type: "string", description: "Content to write" },
            },
            required: ["path", "content"],
          },
        },
      },
      {
        type: "function" as const,
        function: {
          name: "list_files",
          description: "List files in a directory",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Absolute directory path" },
            },
            required: ["path"],
          },
        },
      },
      {
        type: "function" as const,
        function: {
          name: "execute_command",
          description: "Execute a shell command and return the output. Use for git, npm, node, or other CLI tools.",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "Shell command to execute" },
              cwd: { type: "string", description: "Working directory (default: D:\\code\\slock)" },
            },
            required: ["command"],
          },
        },
      },
    ];
  }

  private async executeTool(name: string, args: Record<string, string>): Promise<string> {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const childProcess = await import("node:child_process");

    switch (name) {
      case "read_file": {
        const filePath = args.path;
        if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;
        const content = fs.readFileSync(filePath, "utf-8");
        return content.slice(0, 5000) + (content.length > 5000 ? "\n... (truncated)" : "");
      }
      case "write_file": {
        const dir = path.dirname(args.path);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(args.path, args.content, "utf-8");
        return `Successfully wrote ${args.content.length} bytes to ${args.path}`;
      }
      case "list_files": {
        const dirPath = args.path;
        if (!fs.existsSync(dirPath)) return `Error: Directory not found: ${dirPath}`;
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        return entries
          .slice(0, 50)
          .map((e) => `${e.isDirectory() ? "[dir]" : "[file]"} ${e.name}`)
          .join("\n");
      }
      case "execute_command": {
        return new Promise((resolve) => {
          const cwd = args.cwd || "D:\\code\\slock";
          childProcess.exec(args.command, { cwd, timeout: 30000, maxBuffer: 1024 * 1024 },
            (error, stdout, stderr) => {
              if (error) resolve(`Exit code ${error.code}: ${stderr || error.message}`);
              else resolve(stdout || "(no output)");
            });
        });
      }
      default:
        return `Unknown tool: ${name}`;
    }
  }

  private async sendStatus(target: string, status: string, detail?: string) {
    try {
      await fetch(`${this.serverUrl}/internal/agent/${this.agentId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.apiKey}` },
        body: JSON.stringify({ target, content: `🤖 ${status}${detail ? "\n> " + detail : ""}` }),
      });
    } catch { /* silent */ }
  }

  
  private async spawnAgent(agentId: string, prompt: string): Promise<ClaudeDriver> {
    const existing = this.agentDrivers.get(agentId);
    if (existing?.isRunning) return existing;

    const sysPrompt = [
      "You are an AI agent in the CollabAgent platform — an AI-native team collaboration system.",
      "You can read/write files, run commands, and communicate via the slock CLI.",
      "Available tools:",
      "- slock message send --target <target>: Send a message to a channel or DM",
      "- slock message read --channel <target>: Read message history",
      "- slock task claim/update: Manage tasks",
      "- slock server info: List channels and agents",
      "Read and write files using standard tools. Be helpful and proactive.",
    ].join("\n");

    const driver = new ClaudeDriver({
      workingDirectory: process.env.AGENT_WORKSPACE || process.cwd(),
      model: "sonnet",
      systemPrompt: sysPrompt,
      onEvent: (event) => {
        console.log("[Agent " + agentId.slice(0, 8) + "] " + event.kind + (event.text ? ": " + event.text.slice(0, 80) : ""));
      },
      onExit: (code) => {
        console.log("[Agent " + agentId.slice(0, 8) + "] exited with code " + code);
        this.agentDrivers.delete(agentId);
      },
    });

    await driver.start(prompt);
    this.agentDrivers.set(agentId, driver);
    return driver;
  }

  private async sendToAgent(agentId: string, message: string): Promise<string | null> {
    const driver = this.agentDrivers.get(agentId);
    if (!driver?.isRunning) return null;
    
    // Collect text replies from the agent's response
    let reply = "";
    driver.sendMessage(message);
    // Note: In a full implementation, we'd await the turn_end event.
    // For now, this starts the agent thinking — the reply mechanism
    // will be handled by the onEvent callback.
    return reply;
  }

  private async callAI(
    userMessage: string,
    senderName: string,
    channelName: string
  ): Promise<string | null> {
    const target = "#" + channelName;
    const dsKey = process.env.DEEPSEEK_API_KEY;

    // No AI key — echo mode
    if (!dsKey && !process.env.ANTHROPIC_API_KEY) {
      return "🤖 Echo: \"" + userMessage.slice(0, 100) + "\" — from @" + senderName;
    }

    if (dsKey) {
      try {
        await this.sendStatus(target, "正在思考...");
        const messages: any[] = [
          { role: "system", content: "You are a helpful AI agent in the #" + channelName + " channel. You can read/write files, list directories, and execute commands. Reply concisely in Chinese." },
          { role: "user", content: "@" + senderName + " said: " + userMessage },
        ];

        const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + dsKey },
          body: JSON.stringify({
            model: "deepseek-chat",
            messages,
            tools: this.getTools(),
            tool_choice: "auto",
          }),
        });
        const data = await res.json() as any;
        const choice = data.choices?.[0];
        const assistantMsg = choice?.message;

        // Handle tool calls
        if (assistantMsg?.tool_calls?.length) {
          for (const tc of assistantMsg.tool_calls) {
            const toolName = tc.function.name;
            const toolArgs = JSON.parse(tc.function.arguments);
            await this.sendStatus(target, `调用工具: ${toolName}`, JSON.stringify(toolArgs).slice(0, 200));
            const result = await this.executeTool(toolName, toolArgs);
            await this.sendStatus(target, `工具 ${toolName} 完成`, result.slice(0, 300));
            messages.push(assistantMsg);
            messages.push({ role: "tool", tool_call_id: tc.id, content: result });
          }
          // Get final response after tool calls
          const finalRes = await fetch("https://api.deepseek.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + dsKey },
            body: JSON.stringify({ model: "deepseek-chat", messages }),
          });
          const finalData = await finalRes.json() as any;
          return finalData.choices?.[0]?.message?.content || null;
        }
        return assistantMsg?.content || null;
      } catch (err: any) {
        console.error("[Daemon] AI error:", err.message);
        return "🤖 AI 出错: " + err.message;
      }
    }

    // Claude fallback (no tool calling)
    try {
      const claudeKey = process.env.ANTHROPIC_API_KEY!;
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": claudeKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6", max_tokens: 500,
          system: "You are an AI agent in the #" + channelName + " channel.",
          messages: [{ role: "user", content: userMessage }],
        }),
      });
      const data = await res.json() as any;
      return data.content?.[0]?.text || null;
    } catch (err: any) {
      console.error("[Daemon] Claude error:", err.message);
      return null;
    }
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    const type = msg.type as string | undefined;
    switch (type) {
      case "agent:deliver": {
        const m = (msg.message || msg) as Record<string, unknown>;
        const content = m.content as string;
        const rawChannel = (m.channelId as string) || "general";
        const channelName = rawChannel.startsWith("#") ? rawChannel.slice(1) : rawChannel;
        const senderName = (m.senderName as string) || (m.senderId as string) || "unknown";
        console.log(`[Daemon] Message from @${senderName} in #${channelName}: ${content?.slice(0, 50)}`);

        if (m.senderId !== this.agentId && content && typeof content === "string") {
          try {
            const reply = await this.callAI(content, senderName, channelName);
            if (reply) {
              const replyRes = await fetch(`${this.serverUrl}/internal/agent/${this.agentId}/send`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.apiKey}` },
                body: JSON.stringify({ target: "#" + channelName, content: reply }),
              });
              if (replyRes.ok) console.log(`[Daemon] AI replied to #${channelName}`);
            }
          } catch (err: any) {
            console.error("[Daemon] Failed to send reply:", err.message);
          }
        }
        break;
      }
      case "agent:start": console.log("[Daemon] Agent start", msg.config); break;
      case "agent:stop": console.log("[Daemon] Agent stop", msg.agentId); break;
      case "reminder.upsert": console.log("[Daemon] Reminder upsert", msg.reminder); break;
      case "reminder.cancel": console.log("[Daemon] Reminder cancel", msg.reminderId); break;
      case "ping": this.ws?.send(JSON.stringify({ type: "pong" })); break;
    }
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) { this.ws.close(); this.ws = null; }
    console.log("[Daemon] Stopped");
  }
}
