import { PersistentClaude } from "./drivers/persistent-claude.js";
import { claudePrint } from "./claude-print.js";
import { writeSystemPromptFile, createWorkspaceDir } from "./agent-startup.js";
import type { IAgentTokenRegistry } from "./types/index.js";
import type { ILiveRunRegistry } from "./types/index.js";
import type { AgentStatus } from "./types/index.js";

// ---- 状态机辅助 ----

/** 单 agent 状态跟踪 */
interface AgentState {
  status: AgentStatus;
  lastTransitionAt: number;
  startupTimer: ReturnType<typeof setTimeout> | null;
}

const VALID_TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
  uninit: ["idle", "stopped"],
  idle: ["starting", "stopped"],
  starting: ["working", "idle", "stopped"],
  working: ["idle", "stopped"],
  stopped: ["idle"],
};

function assertTransition(from: AgentStatus, to: AgentStatus): void {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed?.includes(to)) {
    console.warn(`[Runtime] Invalid state transition: ${from} → ${to} (ignored)`);
    throw new Error(`Invalid state transition: ${from} → ${to}`);
  }
}

const STATE_LABEL: Record<AgentStatus, string> = {
  uninit: "未初始化",
  idle: "空闲",
  starting: "启动中",
  working: "工作中",
  stopped: "已停止",
};

/**
 * Agent 运行时编排器。
 *
 * 负责：
 * - 消息分发（dispatchToAgent / runAgent / runAgentDm / runAgentReminder）
 * - Agent 注册表管理
 * - 常驻会话缓存
 * - 与 agent-tokens / live-run-registry 集成
 */
export interface AgentRuntimeOptions {
  serverUrl: string;
  apiKey: string;
}

export interface IAgentRuntime {
  // 消息分发
  dispatchToAgent(agentName: string, channelName: string, userMsg: string): Promise<void>;
  runAgent(agentName: string, channelName: string, replyTarget: string, senderName: string, content: string): Promise<void>;
  runAgentDm(agentName: string, replyTarget: string, senderName: string, content: string): Promise<void>;
  runAgentReminder(agentName: string, reminder: { title?: string; channel?: string }): Promise<void>;

  // 注册表
  registerAgent(id: string, name: string, info: { displayName?: string; description?: string }): void;
  unregisterAgent(name: string): void;
  loadExistingAgents(): Promise<void>;
  resolveAgentId(agentName: string): string | null;
  findMentionedAgent(content: string): string | null;
  mentionedAgentNames(content: string): string[];

  // 生命周期
  stopAgent(agentName: string): void;
  stopAll(): void;

  // 查询
  getAgentInfo(name: string): { displayName?: string; description?: string } | undefined;
  hasAgent(name: string): boolean;
  getAgentState(name: string): AgentStatus | undefined;
}

export const createAgentRuntime = (
  options: AgentRuntimeOptions,
  tokenRegistry: IAgentTokenRegistry,
  _liveRunRegistry: ILiveRunRegistry,
): IAgentRuntime => {
  // ---- 注册表 ----
  const agentDrivers = new Map<string, boolean>();
  const agentSessions = new Map<string, string>();
  const agentNameToId = new Map<string, string>();
  const agentInfo = new Map<string, { displayName?: string; description?: string }>();
  const persistentSessions = new Map<string, PersistentClaude>();
  const usePersistent = process.env.SLOCK_PERSISTENT_CLAUDE !== "0";

  // ---- 四态模型 ----
  const agentStates = new Map<string, AgentState>();

  // ---- 并发保护：同一 agent 同时只允许一个 dispatch in-flight（规则 6） ----
  const dispatchPromises = new Map<string, Promise<void>>();

  const transitionState = (name: string, to: AgentStatus): void => {
    const current = agentStates.get(name);
    const from: AgentStatus = current?.status ?? "uninit";
    try { assertTransition(from, to); } catch { return; }
    agentStates.set(name, { status: to, lastTransitionAt: Date.now(), startupTimer: null });
    if (from !== to) {
      console.log(`[Runtime] @${name} ${STATE_LABEL[from]} → ${STATE_LABEL[to]}`);
    }
  };

  /** 重置 startup 超时计时器 */
  const clearStartupTimer = (name: string): void => {
    const st = agentStates.get(name);
    if (st?.startupTimer) { clearTimeout(st.startupTimer); st.startupTimer = null; }
  };

  // ---- 内部方法 ----

  const resolveAgentId = (agentName: string): string | null => {
    if (agentNameToId.has(agentName)) return agentNameToId.get(agentName)!;
    if (/^[0-9a-f-]{36}$/i.test(agentName)) return agentName;
    return null;
  };

  const mentionedAgentNames = (content: string): string[] => {
    const found: string[] = [];
    const names = Array.from(agentDrivers.keys()).sort((a, b) => b.length - a.length);
    for (const name of names) {
      if (content.includes("@" + name) && !found.includes(name)) found.push(name);
    }
    return found;
  };

  const findMentionedAgent = (content: string): string | null => {
    return mentionedAgentNames(content)[0] || null;
  };

  // ---- 消息分发核心 ----

  // 内部实现：实际执行 dispatch（被外层 dedup 包装）
  const doDispatch = async (agentName: string, channelName: string, userMsg: string): Promise<void> => {
    const agentId = resolveAgentId(agentName);
    if (!agentId) { console.error(`[Daemon] No agent id for @${agentName}, skip`); return; }

    // 状态机：非 idle/working 态不派发
    const state = agentStates.get(agentName);
    if (state && state.status === "stopped") {
      console.log(`[Daemon] @${agentName} is stopped, skipping dispatch`);
      return;
    }

    // idle → starting 转换
    const needsSpawn = !persistentSessions.has(agentName);
    if (needsSpawn) {
      transitionState(agentName, "starting");
      // 启动超时 15s → 回退到 idle
      const timer = setTimeout(() => {
        clearStartupTimer(agentName);
        transitionState(agentName, "idle");
        console.warn(`[Daemon] @${agentName} startup timed out (15s)`);
      }, 15000);
      const st = agentStates.get(agentName);
      if (st) st.startupTimer = timer;
    }

    const runtimeToken = tokenRegistry.issue(agentId);
    const env = {
      SLOCK_AGENT_ID: agentId,
      SLOCK_AGENT_TOKEN: runtimeToken,
      SLOCK_SERVER_URL: options.serverUrl,
    };

    try {
      const info = agentInfo.get(agentName) || {};
      const promptFile = writeSystemPromptFile(agentName, channelName, true, info);
      const workspace = createWorkspaceDir(agentName, info);

      if (usePersistent) {
        let session = persistentSessions.get(agentName);
        if (!session) {
          session = new PersistentClaude({
            cwd: workspace,
            systemPromptFile: promptFile,
            env,
            label: "@" + agentName,
          });
          persistentSessions.set(agentName, session);
        }
        clearStartupTimer(agentName);
        transitionState(agentName, "working");
        session.send(userMsg);
        console.log(`[Daemon] @${agentName} message dispatched (persistent)`);
      } else {
        clearStartupTimer(agentName);
        transitionState(agentName, "working");
        const sid = agentSessions.get(agentName);
        const claude = await claudePrint(userMsg, sid, promptFile, env, workspace);
        if (claude.sessionId) agentSessions.set(agentName, claude.sessionId);
        console.log(`[Daemon] @${agentName} turn finished (one-shot)`);
        transitionState(agentName, "idle");
      }
    } catch (err: any) {
      clearStartupTimer(agentName);
      transitionState(agentName, "idle");
      console.error("[Daemon] dispatchToAgent failed:", err?.message);
    }
  };

  // dedup 包装：同一 agent 同时只允许一个 dispatch in-flight（规则 6）。
  // 第二次 agent:deliver 到达时，串行等待前一个完成，避免双 spawn。
  const dispatchToAgent = async (agentName: string, channelName: string, userMsg: string): Promise<void> => {
    const inFlight = dispatchPromises.get(agentName);
    if (inFlight) {
      console.log(`[Daemon] @${agentName} dispatch already in-flight, chaining`);
      await inFlight.catch(() => {});
      return;
    }
    const promise = doDispatch(agentName, channelName, userMsg);
    dispatchPromises.set(agentName, promise);
    try {
      await promise;
    } finally {
      dispatchPromises.delete(agentName);
    }
  };

  const runAgent = async (
    agentName: string, channelName: string, replyTarget: string,
    senderName: string, content: string,
  ): Promise<void> => {
    const inThread = replyTarget.includes(":");
    const where = inThread ? `#${channelName} 的一个线程里` : `#${channelName} 频道`;
    const userMsg = [
      `你在 ${where}被 @ 了。来自 @${senderName} 的消息：${content}`,
      ``,
      `请用 \`slock message send --target "${replyTarget}"\`（内容从 stdin 传入）`,
      inThread ? "在该线程内" : "在该频道",
      `回复。注意 target 必须严格用 "${replyTarget}"。`,
    ].join("\n");
    await dispatchToAgent(agentName, channelName, userMsg);
  };

  const runAgentDm = async (
    agentName: string, replyTarget: string,
    senderName: string, content: string,
  ): Promise<void> => {
    const userMsg = [
      `你收到了一条来自 @${senderName} 的私信（DM）：${content}`,
      ``,
      `请用 \`slock message send --target "${replyTarget}"\`（内容从 stdin 传入）直接回复。`,
      `注意 target 必须严格用 "${replyTarget}"。`,
      `私信是一对一的，无需被 @ 也应当回应。`,
    ].join("\n");
    await dispatchToAgent(agentName, replyTarget, userMsg);
  };

  const runAgentReminder = async (
    agentName: string,
    reminder: { title?: string; channel?: string },
  ): Promise<void> => {
    const channelName = (reminder.channel || "").replace(/^#/, "").split(":")[0] || "general";
    const where = reminder.channel
      ? `相关频道：${reminder.channel}。如需发消息，用 \`echo "内容" | slock message send --target "${reminder.channel}"\`。`
      : `没有指定频道；如需发消息，先用 \`slock server info\` 找到合适频道，或按你 MEMORY.md 里的约定。`;
    const userMsg = [
      `⏰ 你之前设置的提醒触发了：「${reminder.title || "(无标题)"}」。`,
      where,
      `请据此完成相应跟进；处理完即结束本回合。`,
    ].join("\n");
    await dispatchToAgent(agentName, channelName, userMsg);
  };

  // ---- 公开接口 ----

  return {
    dispatchToAgent,
    runAgent,
    runAgentDm,
    runAgentReminder,

    registerAgent(id: string, name: string, info: { displayName?: string; description?: string }): void {
      agentDrivers.set(name, true);
      if (id) agentNameToId.set(name, id);
      agentInfo.set(name, info);
      persistentSessions.get(name)?.stop();
      persistentSessions.delete(name);
      transitionState(name, "idle");
    },

    unregisterAgent(name: string): void {
      agentNameToId.delete(name);
      agentDrivers.delete(name);
      agentInfo.delete(name);
      agentSessions.delete(name);
      persistentSessions.get(name)?.stop();
      persistentSessions.delete(name);
      clearStartupTimer(name);
      transitionState(name, "stopped");
    },

    async loadExistingAgents(): Promise<void> {
      try {
        const res = await fetch(options.serverUrl + "/api/agents", {
          headers: { Authorization: `Bearer ${options.apiKey}` },
        });
        const data = await res.json() as any;
        for (const agent of (data.agents || [])) {
          const name = agent.name as string;
          if (agent.id) agentNameToId.set(name, agent.id as string);
          agentInfo.set(name, { displayName: agent.display_name, description: agent.description });
          if (!agentDrivers.has(name)) {
            console.log("[Daemon] Registered (lazy): @" + name + " -> " + (agent.id || "?").slice(0, 8));
            agentDrivers.set(name, true);
            transitionState(name, "idle");
          }
        }
      } catch (err: any) {
        console.error("[Daemon] Could not load agents:", err?.message || String(err));
      }
    },

    resolveAgentId,
    findMentionedAgent,
    mentionedAgentNames,

    stopAgent(agentName: string): void {
      persistentSessions.get(agentName)?.stop();
      persistentSessions.delete(agentName);
    },

    stopAll(): void {
      for (const s of persistentSessions.values()) s.stop();
      persistentSessions.clear();
    },

    getAgentInfo(name: string) {
      return agentInfo.get(name);
    },

    hasAgent(name: string): boolean {
      return agentDrivers.has(name);
    },

    getAgentState(name: string): AgentStatus | undefined {
      return agentStates.get(name)?.status;
    },
  };
};
