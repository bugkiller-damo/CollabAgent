import { WebSocket } from "ws";
import { ApiClient } from "./client.js";
import type { AgentContext } from "./auth.js";

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

  constructor(private config: DaemonConfig) {
    this.serverUrl = config.serverUrl;
    this.apiKey = config.apiKey;
    // Create a minimal agent context for API calls
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
      // Send ready message
      this.ws?.send(JSON.stringify({
        type: "ready",
        capabilities: ["send", "read"],
        runtimes: ["daemon-cli"],
        hostname: process.env.COMPUTERNAME || "unknown",
        daemonVersion: "0.1.0",
      }));
    });

    this.ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch {
        // Ignore unparseable messages
      }
    });

    this.ws.on("close", () => {
      console.log("[Daemon] Disconnected, reconnecting...");
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      console.error("[Daemon] WebSocket error:", err.message);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.connect();
    }, this.reconnectDelay);
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    const type = msg.type as string | undefined;
    switch (type) {
      case "agent:deliver": {
        const m = (msg.message || msg) as Record<string, unknown>;
        const content = m.content as string;
        const rawChannel = (m.channelId as string) || "general"; const channelName = rawChannel.startsWith("#") ? rawChannel.slice(1) : rawChannel;
        const senderName = (m.senderName as string) || (m.senderId as string) || "unknown";
        console.log(`[Daemon] Message from @${senderName} in #${channelName}: ${content?.slice(0, 50)}`);

        // Auto-reply: only respond to messages not from this daemon
        if (m.senderId !== this.agentId && content && typeof content === "string") {
          const reply = `🤖 Daemon received: "${content.slice(0, 100)}" — from @${senderName}`;
          try {
            // Send reply via agent route (machine token auth, no JWT needed)
            const replyRes = await fetch(`${this.serverUrl}/internal/agent/${this.agentId}/send`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${this.apiKey}`,
              },
              body: JSON.stringify({ target: `#${channelName}`, content: reply }),
            });
            const res = { ok: replyRes.ok };
            if (res.ok) {
              console.log(`[Daemon] Auto-replied to #${channelName}`);
            }
          } catch (err) {
            console.error("[Daemon] Failed to send reply:", (err as Error).message);
          }
        }
        break;
      }
      case "agent:start":
        console.log("[Daemon] Agent start requested", msg.config);
        break;
      case "agent:stop":
        console.log("[Daemon] Agent stop requested", msg.agentId);
        break;
      case "reminder.upsert":
        console.log("[Daemon] Reminder upsert", msg.reminder);
        break;
      case "reminder.cancel":
        console.log("[Daemon] Reminder cancel", msg.reminderId);
        break;
      case "ping":
        this.ws?.send(JSON.stringify({ type: "pong" }));
        break;
      default:
        break;
    }
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    console.log("[Daemon] Stopped");
  }
}
