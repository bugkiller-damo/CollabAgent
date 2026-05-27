import { WebSocket } from "ws";
import { buildFetchDispatcher } from "./proxy.js";

export interface DaemonConfig {
  serverUrl: string;
  apiKey: string;
  dataDir?: string;
}

export class DaemonCore {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;

  constructor(private config: DaemonConfig) {}

  start(): void {
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

  private handleMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string | undefined;
    switch (type) {
      case "agent:start":
        console.log("[Daemon] Agent start requested", msg.config);
        break;
      case "agent:stop":
        console.log("[Daemon] Agent stop requested", msg.agentId);
        break;
      case "agent:deliver":
        console.log("[Daemon] Message delivery", msg.seq);
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
