import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WsFromDaemonMessage, WsToDaemonMessage } from "@collabagent/shared";
import { WebSocket } from "ws";
import { createJsonCostTracker, defaultCostStorePath } from "./agent-cost-tracker.js";
import { createJsonRunStore, defaultStorePath } from "./agent-run-store.js";
import { createAgentRuntime, type IAgentRuntime } from "./agent-runtime.js";
import { pickLocalTriageAgent } from "./agent-runtime-dispatch.js";
import { createJsonThreadSessionStore, defaultThreadSessionStorePath } from "./agent-thread-sessions.js";
import { createAgentTokenRegistry } from "./agent-tokens.js";
import { listWorkspaceFiles, readWorkspaceFile } from "./agent-workspace.js";
import { probeClaude } from "./drivers/probe.js";
import { createLiveRunRegistry } from "./live-run-registry.js";
import { buildReadyPayload } from "./ready-payload.js";
import { setupSlockWrapper } from "./setup-slock-wrapper.js";
import { readTerminalLogTail } from "./terminal-log.js";
import type { DaemonConfig } from "./types/index.js";

export class DaemonCore {
  private ws: WebSocket | null = null;
  private serverUrl: string;
  private apiKey: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private authFailed = false;
  private runtime: IAgentRuntime;
  private agentId = "00000000-0000-0000-0000-000000000001";
  /** 崩溃前处于 starting/running 状态的 agent（autostart 方案 A 用），见 constructor 里的采集顺序说明 */
  private autostartCandidates: { agentId: string; agentName: string }[] = [];
  /** 终端观察（G3）：agentName -> 推帧定时器；agentName -> 上次推过的帧（去重） */
  private terminalWatchers = new Map<string, ReturnType<typeof setInterval>>();
  private terminalLastFrame = new Map<string, string>();
  /** B1：观看期间的观察帧转发订阅（agentName → unsubscribe） */
  private terminalObsUnsubs = new Map<string, () => void>();

  constructor(private config: DaemonConfig) {
    this.serverUrl = config.serverUrl;
    this.apiKey = config.apiKey;
    const tokenRegistry = createAgentTokenRegistry();
    const liveRunRegistry = createLiveRunRegistry();
    const runStore = createJsonRunStore(defaultStorePath());
    const costTracker = createJsonCostTracker(defaultCostStorePath());
    const threadSessions = createJsonThreadSessionStore(defaultThreadSessionStorePath());
    // 「计划内重启」标记（supervisor watch 重启 / 上次优雅 stop 写入）：
    // 有标记说明上次不是崩溃——run 记录虽然是 stale 的，但那是故意停掉的，
    // 不该触发 autostart 把 agent 全部拉起一遍（2026-07-18 实测：热重启后
    // agent 没被提问就自动 spawn，用户困惑）。
    const plannedMarker = join(process.cwd(), ".slock", "planned-restart");
    const isPlannedRestart = existsSync(plannedMarker);
    if (isPlannedRestart) {
      try {
        unlinkSync(plannedMarker);
      } catch {
        /* ignore */
      }
      console.log("[Daemon] Planned restart detected (marker file) — skipping autostart");
    }
    // 必须在 markUnfinishedRunsStale() 之前采集——那个方法会把这些记录的
    // status 改写成 "error"，先后顺序反了 listActiveAgents() 就永远查到空列表
    // （见 docs/2026-07-16/13-autostart-session-resume-plan.md 方案 A）。
    this.autostartCandidates = isPlannedRestart ? [] : runStore.listActiveAgents();
    // 崩溃恢复：上次进程若被硬杀（未走到正常 exit 清理），遗留的 starting/running
    // 记录会一直卡在那，把它们标记为 error，避免重启摘要里显示"永远在启动中"
    const staleCount = runStore.markUnfinishedRunsStale();
    if (staleCount > 0) {
      console.warn(`[Daemon] Marked ${staleCount} unfinished run(s) as stale (previous crash)`);
    }
    this.runtime = createAgentRuntime(
      {
        serverUrl: this.serverUrl,
        apiKey: this.apiKey,
        // 门控投递反馈：消息排队时经 WS 告诉 server（server 中继给浏览器 toast）。
        // 注意 connect() 在 start() 里先于 loadExistingAgents 调用，但回调触发
        // 只在消息到达后，此时 this.ws 必然已就绪；ws 未 OPEN 时静默丢弃即可。
        onDeliveryQueued: (agentName, channelName) => {
          this.sendWs({ type: "agent:delivery-queued", agentName, channelName });
        },
        // A1 派发队列死信：重试耗尽/不可投递的消息经 WS 上报 server，
        // 由 server 标记 delivery_failed（不自动重投，避免死信循环）。
        onDeliveryDeadLetter: (agentName, channelName, err) => {
          this.sendWs({
            type: "agent:delivery-dead-letter",
            agentName,
            channelName,
            error: String((err as any)?.message ?? err).slice(0, 300),
          });
        },
        // C1：agent 本地工具调用生命周期进审计流（仅 headless 路径有结构化事件源）。
        // 参数/结果摘要已在上游截断（agent-observation.ts 的 truncate 纪律），
        // 完整内容留在本地 run 历史，不上 WS。
        onToolCall: (agentName, info) => {
          this.sendWs({
            type: "agent:tool-call",
            agentName,
            // server 审计链需要稳定 actorId（名字可改，id 不变）
            agentId: this.runtime.resolveAgentId(agentName) || agentName,
            toolName: info.toolName ?? null,
            toolUseId: info.toolUseId ?? null,
            status: info.status,
            text: info.text ?? null,
            time: new Date().toISOString(),
          });
        },
        // 回复守卫代发 / D3 成本熔断 / D4 进度：daemon 以 machine token 调
        // /internal/agent/:id/send（不 mint scoped token，避免覆盖 MCP 凭证）。
        onReplyMissing: (agentName, channel, content) => {
          void this.postAsAgent(agentName, channel, content, "reply-guard");
        },
        onCircuitBreak: (agentName, channel, content) => {
          void this.postAsAgent(agentName, channel, content, "cost-circuit");
        },
        onProgress: (agentName, channelName, headline, phase) => {
          this.sendWs({ type: "agent:progress", agentName, channelName, headline, phase });
        },
        createProgressPoster: (agentName) => ({
          post: (channel, content, threadId) => this.postAsAgent(agentName, channel, content, "progress", threadId),
          edit: (messageId, content) => this.editAsAgent(agentName, messageId, content, "progress"),
          remove: (messageId) => this.deleteAsAgent(agentName, messageId, "progress"),
        }),
        costTracker,
        threadSessions,
      },
      tokenRegistry,
      liveRunRegistry,
      runStore,
    );
  }

  /**
   * 以 agent 身份往频道发/改/删消息。用账号级 machine token（this.apiKey），
   * 不 mint scoped token——回合中 mint 会覆盖 MCP 子进程正在用的凭证。
   * requireOwnAgent 认 machine token（user.sub === agent.user_id）。
   */
  private async postAsAgent(
    agentName: string,
    channel: string,
    content: string,
    reason: string,
    threadId?: string,
  ): Promise<string | undefined> {
    try {
      const agentId = this.runtime.resolveAgentId(agentName);
      if (!agentId) {
        console.warn(`[Daemon] ${reason}: no agentId for @${agentName}`);
        return undefined;
      }
      const res = await fetch(`${this.serverUrl}/internal/agent/${agentId}/send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ target: channel, content, ...(threadId ? { threadId } : {}) }),
      });
      if (!res.ok) throw new Error(`send ${res.status} ${await res.text().catch(() => "")}`);
      const body = (await res.json().catch(() => ({}))) as { messageId?: string };
      console.log(`[Daemon] ${reason} posted for @${agentName} -> ${channel} (${content.length} chars)`);
      return body.messageId;
    } catch (err: any) {
      console.error(`[Daemon] ${reason} post failed for @${agentName}:`, err?.message ?? err);
      return undefined;
    }
  }

  private async editAsAgent(agentName: string, messageId: string, content: string, reason: string): Promise<boolean> {
    try {
      const agentId = this.runtime.resolveAgentId(agentName);
      if (!agentId) return false;
      const res = await fetch(`${this.serverUrl}/internal/agent/${agentId}/messages/${messageId}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error(`edit ${res.status} ${await res.text().catch(() => "")}`);
      return true;
    } catch (err: any) {
      console.error(`[Daemon] ${reason} edit failed for @${agentName}:`, err?.message ?? err);
      return false;
    }
  }

  private async deleteAsAgent(agentName: string, messageId: string, reason: string): Promise<boolean> {
    try {
      const agentId = this.runtime.resolveAgentId(agentName);
      if (!agentId) return false;
      const res = await fetch(`${this.serverUrl}/internal/agent/${agentId}/messages/${messageId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!res.ok) throw new Error(`delete ${res.status} ${await res.text().catch(() => "")}`);
      return true;
    } catch (err: any) {
      console.error(`[Daemon] ${reason} delete failed for @${agentName}:`, err?.message ?? err);
      return false;
    }
  }

  async start(): Promise<void> {
    console.log(`[Daemon] Starting with server ${this.config.serverUrl}`);
    this.checkClaude();
    await this.setupSlockWrapper();
    this.connect();
    await this.runtime.loadExistingAgents();
    this.wireAgentOutput();
    this.startStatusReporter();
    await this.autostartCrashedAgents();
  }

  /**
   * Agent 状态上报（G7 轻量版，照搬 hive last_pty_line 模式）：每 3s 轮询所有
   * 已注册 agent 的「状态 + 最后一行终端输出」，有变化才上报。server 中继给
   * 浏览器后，侧边栏 Agent 状态栏就能实时显示每个 agent 正在干什么。
   */
  private statusReporter: ReturnType<typeof setInterval> | null = null;
  private lastReportedByAgent = new Map<string, string>();

  private startStatusReporter(): void {
    if (this.statusReporter) return;
    const tick = () => {
      if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
      const manager = this.runtime.__getAgentManager();
      for (const name of this.runtime.listAgentNames()) {
        const runId = this.runtime.__getRunId(name);
        const run = runId ? manager.getRun(runId) : undefined;
        const state = this.runtime.getAgentState(name) ?? "unknown";
        const status = run || (state !== "stopped" && state !== "uninit" && state !== "unknown") ? state : "offline";
        // 最后一行非空终端输出（last_pty_line）；headless 用观察帧摘要
        let lastLine = "";
        if (run?.screenText) {
          const lines = run.screenText.split("\n");
          for (let i = lines.length - 1; i >= 0; i--) {
            const t = lines[i]!.trim();
            if (t) {
              lastLine = t.slice(0, 80);
              break;
            }
          }
        } else {
          const t = this.runtime.__getObservationBus().transcript(name, 400).trim();
          if (t) {
            const lines = t.split("\n");
            lastLine = (lines[lines.length - 1] ?? "").slice(0, 80);
          }
        }
        const key = status + "|" + lastLine;
        if (this.lastReportedByAgent.get(name) === key) continue;
        this.lastReportedByAgent.set(name, key);
        const agentId = this.runtime.resolveAgentId(name);
        this.sendWs({
          type: "agent:status",
          agentId: agentId || name,
          agentName: name,
          status,
          detail: lastLine,
        });
      }
    };
    this.statusReporter = setInterval(tick, 3000);
    if (typeof this.statusReporter.unref === "function") this.statusReporter.unref();
  }

  /**
   * 崩溃恢复（原 Autostart 方案 A，见 docs/2026-07-16/13-autostart-session-resume-plan.md）。
   *
   * 2026-07-29 起**不再主动拉起**：旧实现给每个候选 agent 注入一条"系统重启，
   * 安静等待"的恢复消息，但这是一条完整的 agent 回合（实测 55k 输出、1m23s），
   * 且 99% 的结论都是"没有真实消息，静默等待"——纯烧 token。新行为：只记日志，
   * agent 保持 lazy 注册，下一条真实消息到来时再 spawn；上下文由 session
   * resume（默认开）或 restart-summary 注入保住，不丢状态。
   */
  private async autostartCrashedAgents(): Promise<void> {
    if (!this.autostartCandidates.length) return;
    console.log(
      `[Daemon] ${this.autostartCandidates.length} agent(s) were active before last crash/restart — ` +
        `skipping eager autostart (they will lazy-spawn with session resume on their next real message)`,
    );
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
      ].join("\n"),
    );
  }

  private async setupSlockWrapper() {
    await setupSlockWrapper(this.agentId, this.serverUrl);
  }

  /** daemon→server 出站消息唯一出口：OPEN 检查 + 线协议类型（S2.3，shared WsFromDaemonMessage） */
  private sendWs(ev: WsFromDaemonMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(ev));
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
      this.sendWs(buildReadyPayload());
    });
    this.ws.on("message", (data) => {
      try {
        this.handleMessage(JSON.parse(data.toString()));
      } catch (err: any) {
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
          ].join("\n"),
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

  private async handleMessage(msgWire: WsToDaemonMessage): Promise<void> {
    // 接收体保留防御性解析：线协议有松散变体（thread_id 蛇形、msg.message||msg
    // 双路径、agent:start 三种变体），规范类型约束在发送侧生效（sendWs）。
    const msg = msgWire as Record<string, unknown>;
    const type = msg.type as string | undefined;
    switch (type) {
      case "agent:start": {
        const agent = msg.agent as Record<string, unknown> | undefined;
        const config = (msg.config as Record<string, unknown> | undefined) || {};
        const agentId = (agent?.id as string) || (msg.agentId as string) || "";
        const agentName = (agent?.name as string) || (config.name as string) || "";
        const displayName = (agent?.displayName as string) || (config.displayName as string) || agentName;
        const description = (agent?.description as string) || (config.description as string) || "";
        // runtime_profile.model（Web 端可选 sonnet/opus/haiku）——注册时带上，spawn 拼 --model。
        // 三种推送变体：创建时 model 在 agent.model；编辑（PATCH）时在 config.model；
        // 部分路径在 config.runtime_profile.model。三个位置都兜底。
        const rp = (config.runtime_profile ?? agent?.runtime_profile) as { model?: string } | undefined;
        const model = (agent?.model as string) || (config.model as string) || rp?.model || undefined;
        if (!agentName) {
          console.log("[Daemon] agent:start without name, ignored");
          break;
        }
        this.runtime.registerAgent(agentId, agentName, { displayName, description, model });
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
            try {
              await this.runtime.runAgent(
                forceTarget,
                channelName,
                replyTarget,
                senderName,
                content,
                threadId || undefined,
                typeof m.id === "string" ? m.id : undefined,
              );
            } catch (err: any) {
              console.error("[Daemon] Dispatch routing failed:", err?.message);
            }
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
            try {
              await this.runtime.runAgentDm(name, replyTarget, senderHandle, content);
            } catch (err: any) {
              console.error("[Daemon] DM dispatch failed:", err?.message);
            }
          }
          break;
        }

        // server 下发的「有权回应的 agent」列表（messages.ts /send 按频道权限预过滤）：
        // 有字段（含空数组）→ 只 spawn 列表内 agent，私有频道非成员 agent 不会起 PTY，
        // 避免「起了进程、思考半天、回复被 403」的资源浪费；无字段（旧 server）退回本地文本解析。
        const deliverList = m.mentionAgents as string[] | undefined;
        const target = Array.isArray(deliverList)
          ? deliverList.find((n) => this.runtime.hasAgent(n))
          : this.runtime.findMentionedAgent(content || "");
        const rawChannel = (m.channelId as string) || "general";
        const channelName = rawChannel.replace(/^#/, "").split(":")[0];
        const threadId = (m.threadId as string) || (m.thread_id as string) || "";
        const replyTarget = threadId ? `#${channelName}:${threadId.slice(0, 8)}` : `#${channelName}`;
        const senderName = (m.senderName as string) || (m.senderId as string) || "unknown";

        if (target) {
          console.log(`[Daemon] Message from @${senderName} in ${replyTarget}: ${content?.slice(0, 50)}`);
          if (m.senderId === this.agentId || !content || typeof content !== "string") break;
          if (content.startsWith("🤖 ")) break;
          try {
            console.log(`[Daemon] Routing to agent @${target} -> ${replyTarget}`);
            await this.runtime.runAgent(
              target,
              channelName,
              replyTarget,
              senderName,
              content,
              threadId || undefined,
              typeof m.id === "string" ? m.id : undefined,
            );
          } catch (err: any) {
            console.error("[Daemon] Failed:", err.message);
          }
          break;
        }

        // T8：mention 未命中后的第四唤醒源——server 单选的分诊经理。
        // 位于 senderType==='agent' / DM / 🤖 拦截之后，agent 消息天然不触发。
        const triageTarget = pickLocalTriageAgent(m.triageAgents, (n) => this.runtime.hasAgent(n));
        if (triageTarget) {
          console.log(`[Daemon] Triage for @${triageTarget} in ${replyTarget}: ${content.slice(0, 50)}`);
          try {
            await this.runtime.runAgentTriage(
              triageTarget,
              channelName,
              replyTarget,
              senderName,
              content,
              threadId || undefined,
              typeof m.id === "string" ? m.id : undefined,
            );
          } catch (err: any) {
            console.error("[Daemon] Triage routing failed:", err?.message);
          }
        }
        break;
      }
      case "agent:stop": {
        const stoppedId = msg.agentId as string;
        const stoppedName = this.runtime.resolveAgentName(stoppedId);
        if (stoppedName) this.runtime.unregisterAgent(stoppedName);
        break;
      }
      case "agent:duty": {
        const duty = msg.duty as string;
        const dutyName = (msg.name as string) || this.runtime.resolveAgentName(msg.agentId as string) || "";
        if (!dutyName) {
          console.log("[Daemon] agent:duty without name, ignored");
          break;
        }
        if (duty === "off") {
          console.log(`[Daemon] @${dutyName} off duty — unregister`);
          this.runtime.unregisterAgent(dutyName);
        } else {
          const dutyId = (msg.agentId as string) || this.runtime.resolveAgentId(dutyName) || "";
          const info = this.runtime.getAgentInfo(dutyName) || {};
          console.log(`[Daemon] @${dutyName} on duty — register (lazy)`);
          this.runtime.registerAgent(dutyId, dutyName, info);
        }
        break;
      }
      case "reminder.fire": {
        const remAgentId = msg.agentId as string;
        const reminder = (msg.reminder as any) || {};
        // 注册表以 name 为键,入信只有 agentId(UUID)——先反查注册名
        // （此前直接用 UUID 查 hasAgent 必 false,agent 提醒静默丢弃,2026-08-19 E2E 实锤）
        const remName = this.runtime.resolveAgentName(remAgentId);
        if (!remName) {
          console.log("[Daemon] reminder.fire for unknown agent", remAgentId);
          break;
        }
        console.log(`[Daemon] reminder fired for @${remName}: ${reminder.title} (${reminder.kind || "reminder"})`);
        await this.runtime.runAgentReminder(remName, reminder);
        break;
      }
      case "terminal:watch": {
        // 浏览器观众上线：开始按 400ms 节拍推这个 agent 的终端帧（G3）。
        // 帧内容直接取终端模拟器渲染好的当前屏（screenText），无变化不推。
        // B1：headless（persistent）路径没有 PTY 屏——用观察帧 replay buffer 渲染
        // 的 transcript 作为 screen 推同一条 terminal:frame 通道，web 侧零改动。
        const agentName = msg.agentName as string;
        if (!agentName || this.terminalWatchers.has(agentName)) break;
        // B1 web 结构化视图：观看期间把观察帧原样推给浏览器（事件流面板消费），
        // 先补 replay buffer 作历史。PTY 路径无观察帧（bus 为空），订阅零开销；
        // 引用计数纪律与 terminal:frame 一致（无人观看不传输）。
        {
          const obsBus = this.runtime.__getObservationBus();
          const replay = obsBus.replay(agentName);
          if (replay.length > 0) {
            this.sendWs({ type: "terminal:obs-history", agentName, frames: replay });
          }
          const unsub = obsBus.subscribe(agentName, (f) => {
            this.sendWs({ type: "terminal:obs-frame", agentName, frame: f });
          });
          this.terminalObsUnsubs.set(agentName, unsub);
        }
        // 先补发一段历史：运行中的 run 发 scrollback（观众能看到打开终端前
        // 发生的事）；没有运行中的 run 则发观察帧 transcript（headless）或
        // 落盘日志的尾部（agent 已被回收也能回看）。
        {
          const runId = this.runtime.__getRunId(agentName);
          const run = runId ? this.runtime.__getAgentManager().getRun(runId) : undefined;
          const obsTranscript = this.runtime.__getObservationBus().transcript(agentName, 60_000);
          const historyText = run?.historyText || obsTranscript || readTerminalLogTail(agentName, 60_000);
          if (historyText.trim()) {
            this.sendWs({ type: "terminal:history", agentName, text: historyText });
          }
        }
        const tick = () => {
          const runId = this.runtime.__getRunId(agentName);
          const manager = this.runtime.__getAgentManager();
          const run = runId ? manager.getRun(runId) : undefined;
          const state = this.runtime.getAgentState(agentName) ?? "unknown";
          // headless：有观察帧内容就不算 offline（没有 PTY run 但 agent 活着）
          const obsScreen = run ? "" : this.runtime.__getObservationBus().transcript(agentName, 60_000);
          const status = run ? state : obsScreen ? state : "offline";
          const screen = run?.screenText ?? obsScreen;
          const key = status + "|" + screen;
          if (this.terminalLastFrame.get(agentName) === key) return;
          this.terminalLastFrame.set(agentName, key);
          this.sendWs({
            type: "terminal:frame",
            agentName,
            screen,
            status,
            time: new Date().toISOString(),
          });
        };
        tick(); // 立即推一帧，观众打开就能看到当前屏
        this.terminalWatchers.set(agentName, setInterval(tick, 400));
        console.log(`[Daemon] Terminal watch started for @${agentName}`);
        break;
      }
      case "terminal:history": {
        // 观众主动请求历史日志（面板「日志」页）：读落盘日志尾部回传
        const agentName = msg.agentName as string;
        if (!agentName) break;
        const text = readTerminalLogTail(agentName);
        this.sendWs({ type: "terminal:history", agentName, text });
        break;
      }
      case "terminal:unwatch": {
        const agentName = msg.agentName as string;
        const timer = this.terminalWatchers.get(agentName);
        if (timer) clearInterval(timer);
        this.terminalWatchers.delete(agentName);
        this.terminalLastFrame.delete(agentName);
        // B1：观察帧订阅一并退订（引用计数归零，停止传输）
        this.terminalObsUnsubs.get(agentName)?.();
        this.terminalObsUnsubs.delete(agentName);
        break;
      }
      case "terminal:resize": {
        // 面板尺寸协商（真改比例）：浏览器按面板宽度算出期望 cols/rows 发过来，
        // 这里实时 resize 正在运行的 PTY（Claude Code 收 SIGWINCH 重排画面），
        // 并记住偏好尺寸供下次 spawn 直接用。
        const agentName = msg.agentName as string;
        const cols = Math.min(400, Math.max(20, Math.round(Number(msg.cols) || 0)));
        const rows = Math.min(100, Math.max(5, Math.round(Number(msg.rows) || 0)));
        if (!agentName || !cols || !rows) break;
        this.runtime.setPreferredTermSize(agentName, { cols, rows });
        const runId = this.runtime.__getRunId(agentName);
        if (runId) {
          this.runtime.__getAgentManager().resizeRun(runId, cols, rows);
        }
        break;
      }
      case "workspace:read": {
        const requestId = String(msg.requestId || "");
        const agentName = String(msg.agentName || "");
        const rel = typeof msg.path === "string" && msg.path ? msg.path : "";
        if (!requestId || !agentName) break;
        if (rel) {
          const r = readWorkspaceFile(agentName, rel);
          if (r.ok) {
            this.sendWs({
              type: "workspace:result",
              requestId,
              agentName,
              exists: true,
              path: r.path,
              content: r.content,
              bytes: r.bytes,
            });
          } else {
            this.sendWs({
              type: "workspace:result",
              requestId,
              agentName,
              exists: false,
              path: rel,
              error: r.error,
            });
          }
        } else {
          const listing = listWorkspaceFiles(agentName);
          this.sendWs({
            type: "workspace:result",
            requestId,
            agentName,
            exists: listing.exists,
            files: listing.files,
          });
        }
        break;
      }
      case "ping":
        this.sendWs({ type: "pong" });
        break;
    }
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.statusReporter) {
      clearInterval(this.statusReporter);
      this.statusReporter = null;
    }
    for (const timer of this.terminalWatchers.values()) clearInterval(timer);
    this.terminalWatchers.clear();
    this.terminalLastFrame.clear();
    // 优雅停止也写「计划内重启」标记：用户主动停掉 daemon 后下次启动，
    // 同样不该把停掉的 agent 当崩溃恢复自动拉起。
    try {
      mkdirSync(join(process.cwd(), ".slock"), { recursive: true });
      writeFileSync(join(process.cwd(), ".slock", "planned-restart"), String(Date.now()));
    } catch {
      /* best-effort */
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.runtime.stopAll();
    console.log("[Daemon] Stopped");
  }
}
