import { WebSocket } from "ws";
import type { AgentContext } from "./auth.js";
import type { DaemonConfig } from "./types/index.js";
import { ApiClient } from "./client.js";
import { probeClaude } from "./drivers/probe.js";
import { createAgentTokenRegistry } from "./agent-tokens.js";
import { createLiveRunRegistry } from "./live-run-registry.js";
import { createAgentRuntime, type IAgentRuntime } from "./agent-runtime.js";
import { setupSlockWrapper } from "./setup-slock-wrapper.js";

export class DaemonCore {
  private ws: WebSocket | null = null;
  private serverUrl: string;
  private apiKey: string;
  private slockDir: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private authFailed = false;
  private client: ApiClient;
  private runtime: IAgentRuntime;
  private agentId = "00000000-0000-0000-0000-000000000001";

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
    const tokenRegistry = createAgentTokenRegistry();
    const liveRunRegistry = createLiveRunRegistry();
    this.runtime = createAgentRuntime(
      { serverUrl: this.serverUrl, apiKey: this.apiKey },
      tokenRegistry,
      liveRunRegistry,
    );
  }

  async start(): Promise<void> {
    console.log(`[Daemon] Starting with server ${this.config.serverUrl}`);
    this.checkClaude();
    await this.setupSlockWrapper();
    this.connect();
    await this.runtime.loadExistingAgents();
  }

  // 启动预检：本机 claude CLI 是否可用。缺失/未登录不阻断启动（daemon 仍连服务器），
  // 但打印清晰指引，避免用户在 agent 被 @ 时才遇到静默失败。
  private checkClaude(): void {
    const { available, version } = probeClaude();
    if (available) {
      console.log(`[Daemon] ✅ 已检测到本机 Claude CLI（${version}），Agent 可正常运行`);
      return;
    }
    console.warn(
      [
        "",
        "──────────────────────────────────────────────",
        "[Daemon] ⚠️  未检测到本机 Claude CLI",
        "  daemon 会照常连上服务器，但 Agent 被 @ 时无法响应。",
        "  请先安装并登录 Claude Code：",
        "    1. 安装： npm install -g @anthropic-ai/claude-code",
        "    2. 登录： claude  （首次运行按提示完成登录）",
        "    3. 验证： claude --version",
        "  完成后重启本 daemon 即可。",
        "──────────────────────────────────────────────",
        "",
      ].join("\n")
    );
  }

  private async setupSlockWrapper() {
    this.slockDir = await setupSlockWrapper(this.agentId, this.serverUrl, this.apiKey);
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
      try { this.handleMessage(JSON.parse(data.toString())); } catch (err: any) {
        console.error("[Daemon] WS message parse/handle error:", err?.message || String(err));
      }
    });
    this.ws.on("close", (code, reason) => {
      // 4001 = 服务端鉴权拒绝（机器令牌无效/被吊销）。无限重连无意义，直接退出并提示。
      if (code === 4001) {
        console.error(
          [
            "",
            "──────────────────────────────────────────────",
            "[Daemon] ❌ 鉴权失败：机器令牌无效或已被吊销。",
            `  服务端关闭原因：${reason?.toString() || "unauthorized"}`,
            "  daemon 不会重连。请在网页端重新生成机器令牌，",
            "  用新的 --api-key 重启 daemon。",
            "──────────────────────────────────────────────",
            "",
          ].join("\n")
        );
        this.authFailed = true;
        void this.stop();
        process.exitCode = 1;
        return;
      }
      console.log("[Daemon] Disconnected, reconnecting...");
      this.scheduleReconnect();
    });
    this.ws.on("error", (err) => console.error("[Daemon] WebSocket error:", err.message));
  }

  private scheduleReconnect(): void {
    if (this.authFailed) return; // 鉴权失败后不再重连
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.connect();
    }, this.reconnectDelay);
  }


  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    const type = msg.type as string | undefined;
    switch (type) {
      case "agent:start": {
        const agent = msg.agent as Record<string, unknown> | undefined;
        const config = (msg.config as Record<string, unknown> | undefined) || {};
        const agentId = (agent?.id as string) || (msg.agentId as string) || "";
        const agentName = (agent?.name as string) || (config.name as string) || "";
        const displayName = (agent?.displayName as string) || (config.displayName as string) || agentName;
        const description = (agent?.description as string) || (config.description as string) || "";
        if (!agentName) { console.log("[Daemon] agent:start without name, ignored"); break; }
        this.runtime.registerAgent(agentId, agentName, { displayName, description });
        break;
      }
      case "agent:deliver": {
        const m = (msg.message || msg) as Record<string, unknown>;
        const content = m.content as string;
        if (m.senderType === "agent") break;
        if (!content || typeof content !== "string") break;
        if (content.startsWith("🤖 ")) break;

        if (m.dm) {
          const recipients = (m.dmAgentRecipients as string[]) || [];
          const senderHandle = (m.senderHandle as string) || (m.senderName as string) || "unknown";
          const replyTarget = `dm:@${senderHandle}`;
          for (const name of recipients) {
            if (!this.runtime.hasAgent(name)) continue;
            console.log(`[Daemon] DM -> @${name} (reply ${replyTarget})`);
            try { await this.runtime.runAgentDm(name, replyTarget, senderHandle, content); }
            catch (err: any) { console.error("[Daemon] DM dispatch failed:", err?.message); }
          }
          break;
        }

        const mentionedAgent = this.runtime.findMentionedAgent(content || "");
        if (!mentionedAgent) break;
        const rawChannel = (m.channelId as string) || "general";
        const channelName = rawChannel.replace(/^#/, "").split(":")[0];
        const threadId = (m.threadId as string) || (m.thread_id as string) || "";
        const replyTarget = threadId ? `#${channelName}:${threadId.slice(0, 8)}` : `#${channelName}`;
        const senderName = (m.senderName as string) || (m.senderId as string) || "unknown";
        console.log(`[Daemon] Message from @${senderName} in ${replyTarget}: ${content?.slice(0, 50)}`);

        if (m.senderId === this.agentId || !content || typeof content !== "string") break;
        if (content.startsWith("🤖 ")) break;

        const mentionedAgents = this.runtime.mentionedAgentNames(content);
        try {
          const target = mentionedAgents[0];
          if (target) {
            console.log(`[Daemon] Routing to agent @${target} -> ${replyTarget}`);
            await this.runtime.runAgent(target, channelName, replyTarget, senderName, content);
          }
        } catch (err: any) {
          console.error("[Daemon] Failed:", err.message);
        }
        break;
      }
      case "agent:stop": {
        const stoppedId = msg.agentId as string;
        // 按 id 找到对应名字，通过运行时注销
        for (const name of this.runtime.mentionedAgentNames("@" + stoppedId)) {
          // 粗略匹配：stoppedId 可能是 agent name 或 UUID
          this.runtime.unregisterAgent(name);
        }
        break;
      }
      case "reminder.fire": {
        const remAgentId = msg.agentId as string;
        const reminder = (msg.reminder as any) || {};
        // 尝试用 agentId 作为 name（agent:deliver 场景），也可能是未知 agent
        if (!this.runtime.hasAgent(remAgentId)) {
          console.log("[Daemon] reminder.fire for unknown agent", remAgentId);
          break;
        }
        console.log(`[Daemon] reminder fired for @${remAgentId}: ${reminder.title}`);
        await this.runtime.runAgentReminder(remAgentId, reminder);
        break;
      }
      case "ping": this.ws?.send(JSON.stringify({ type: "pong" })); break;
    }
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) { this.ws.close(); this.ws = null; }
    this.runtime.stopAll();
    console.log("[Daemon] Stopped");
  }
}
