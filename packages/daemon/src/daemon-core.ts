import { WebSocket } from "ws";
import type { AgentContext } from "./auth.js";
import type { DaemonConfig } from "./types/index.js";
import { ApiClient } from "./client.js";
import { probeClaude } from "./drivers/probe.js";
import { createAgentTokenRegistry } from "./agent-tokens.js";
import { createLiveRunRegistry } from "./live-run-registry.js";
import { createAgentRuntime, type IAgentRuntime } from "./agent-runtime.js";
import { setupSlockWrapper } from "./setup-slock-wrapper.js";
import { createJsonRunStore, defaultStorePath } from "./agent-run-store.js";

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
  /** 崩溃前处于 starting/running 状态的 agent（autostart 方案 A 用），见 constructor 里的采集顺序说明 */
  private autostartCandidates: { agentId: string; agentName: string }[] = [];

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
    const runStore = createJsonRunStore(defaultStorePath());
    // 必须在 markUnfinishedRunsStale() 之前采集——那个方法会把这些记录的
    // status 改写成 "error"，先后顺序反了 listActiveAgents() 就永远查到空列表
    // （见 docs/2026-07-16/13-autostart-session-resume-plan.md 方案 A）。
    this.autostartCandidates = runStore.listActiveAgents();
    // 崩溃恢复：上次进程若被硬杀（未走到正常 exit 清理），遗留的 starting/running
    // 记录会一直卡在那，把它们标记为 error，避免重启摘要里显示"永远在启动中"
    const staleCount = runStore.markUnfinishedRunsStale();
    if (staleCount > 0) {
      console.warn(`[Daemon] Marked ${staleCount} unfinished run(s) as stale (previous crash)`);
    }
    this.runtime = createAgentRuntime(
      { serverUrl: this.serverUrl, apiKey: this.apiKey },
      tokenRegistry,
      liveRunRegistry,
      runStore,
    );
  }

  async start(): Promise<void> {
    console.log(`[Daemon] Starting with server ${this.config.serverUrl}`);
    this.checkClaude();
    await this.setupSlockWrapper();
    this.connect();
    await this.runtime.loadExistingAgents();
    this.wireAgentOutput();
    await this.autostartCrashedAgents();
  }

  /**
   * Autostart 方案 A（见 docs/2026-07-16/13-autostart-session-resume-plan.md）：
   * 只拉起"崩溃前正在运行"的 agent，不是所有注册过的 agent——多数正常场景下
   * （上次是优雅关闭，或从没崩溃过）这个列表是空的，完全零成本。逐个顺序
   * await（不是 Promise.all 并发拉起），避免同时崩溃多个 agent 时一次性并发
   * spawn 一堆 Claude Code 进程抢资源。
   */
  private async autostartCrashedAgents(): Promise<void> {
    if (!this.autostartCandidates.length) return;
    console.log(`[Daemon] Autostarting ${this.autostartCandidates.length} agent(s) active before last crash/restart`);
    for (const { agentName } of this.autostartCandidates) {
      try {
        await this.runtime.autostartAgent(agentName);
      } catch (err: any) {
        console.error(`[Daemon] Autostart failed for @${agentName}:`, err?.message ?? err);
      }
    }
  }

  /**
   * 接入 agent-manager 的 PtyOutputBus。
   *
   * 实际的 PTY 输出转发已经在 agent-runtime 内部按需订阅（每个新 run 自动挂订阅）。
   * 这里仅做接入检查：确认 bus 已就绪、记录已建立的订阅者数。
   * 通过 `SLOCK_VERBOSE_PTY=0` 可关闭本日志。
   */
  private wireAgentOutput(): void {
    if (process.env.SLOCK_VERBOSE_PTY === "0") return;
    const manager = this.runtime.__getAgentManager();
    const bus = manager.getOutputBus();
    console.log(`[Daemon] PTY output bus ready (type=${typeof bus.subscribe})`);
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
        if (!content || typeof content !== "string") break;
        if (content.startsWith("🤖 ")) break;

        // 经理/worker 任务派发通知（agents-dispatch.ts 插入的消息）：sender_type
        // 本来就是 'agent'，会被下面的防自环判断挡掉——用一个显式的 forceDeliverTo
        // 字段（携带目标 agent 的 handle）绕开那个判断，直接路由过去。没有这个
        // 字段的普通 agent 消息仍然照旧被挡，不会打开新的自环口子。
        const forceTarget = m.forceDeliverTo as string | undefined;
        if (forceTarget) {
          if (this.runtime.hasAgent(forceTarget)) {
            const rawChannel = (m.channelId as string) || "general";
            const channelName = rawChannel.replace(/^#/, "").split(":")[0];
            const threadId = (m.threadId as string) || (m.thread_id as string) || "";
            const replyTarget = threadId ? `#${channelName}:${threadId.slice(0, 8)}` : `#${channelName}`;
            const senderName = (m.senderName as string) || (m.senderId as string) || "unknown";
            console.log(`[Daemon] Dispatch message for @${forceTarget} in ${replyTarget}: ${content.slice(0, 50)}`);
            try { await this.runtime.runAgent(forceTarget, channelName, replyTarget, senderName, content); }
            catch (err: any) { console.error("[Daemon] Dispatch routing failed:", err?.message); }
          }
          break;
        }

        if (m.senderType === "agent") break;

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
