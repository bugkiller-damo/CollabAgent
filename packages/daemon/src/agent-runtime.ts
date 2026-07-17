import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { PersistentClaude } from "./drivers/persistent-claude.js";
import { createAgentManager } from "./agent-manager.js";
import { createPostStartInputWriter, type PostStartInputWriter } from "./post-start-input-writer.js";
import { createAgentStdinDispatcher } from "./agent-stdin-dispatcher.js";
import { resolveCommandOnPath } from "./drivers/probe.js";
import { resolveCommand } from "./command-resolver.js";
import { createIdleReclaimer } from "./idle-reclaimer.js";
import { createCredentialsClient } from "./agent-runtime-credentials.js";
import { createAgentStateMachine } from "./agent-runtime-state.js";
import { createTurnTracker, BUSY_MARKER_RE, PROMPT_RE } from "./agent-runtime-turn-tracker.js";
import { createExitChain } from "./agent-runtime-exit.js";
import { createSpawnPtyForAgent } from "./agent-runtime-spawn.js";
import { createDispatch } from "./agent-runtime-dispatch.js";
import type {
  IAgentTokenRegistry,
  ILiveRunRegistry,
  IAgentManager,
  IAgentRunStore,
  IAgentStdinDispatcher,
  AgentStatus,
} from "./types/index.js";

// 重新导出，保持既有 import { BUSY_MARKER_RE, PROMPT_RE } from "./agent-runtime.js" 的调用方
// （包括 test/round-end-detection.test.ts）不需要跟着改路径
export { BUSY_MARKER_RE, PROMPT_RE };

// 四态状态机（uninit/idle/starting/working/stopped）已拆到 agent-runtime-state.ts
// 回合结束检测用到的 BUSY_MARKER_RE/PROMPT_RE + pending/busyObserved 状态已拆到
// agent-runtime-turn-tracker.ts

const PTY_COMMAND = "claude"; // TODO: read from command-resolver

/**
 * 解析 Claude CLI 的可执行文件路径。
 *
 * Windows 上的 npm 全局安装会创建 `claude.cmd` shim（实质是 batch 包装器），
 * node-pty 的 ConPTY 后端在调用 CreateProcessW 时不会沿 PATH 查找 .cmd，
 * 会直接报 ERROR_FILE_NOT_FOUND (code 2)。
 *
 * 解法：先用 `where` / 已知的 npm 路径找到 .cmd/.exe 的真实绝对路径。
 * 若找到的是 .cmd shim，进一步解析其内容，定位它真正 exec 的 .exe，
 * 避免 ConPTY 多走一层 cmd.exe 解释（也避免奇怪的路径传递问题）。
 */
const resolveCmdShimTarget = (cmdPath: string): string | null => {
  try {
    const content = readFileSync(cmdPath, "utf-8");
    // .cmd shim 通常长这样：
    //   @"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
    // 提取引号内的 .exe 路径
    const m = content.match(/^[^"]*?"([^"]+\.exe)"/m);
    if (m) {
      const raw = m[1];
      // 把 %dp0% 替换为 .cmd 所在目录
      const resolved = raw.replace(/%~dp0%|%dp0%/gi, dirname(cmdPath));
      if (existsSync(resolved)) return resolved;
      // 也有可能 %dp0% 已展开（绝对路径）
      if (existsSync(raw)) return raw;
    }
  } catch { /* 解析失败，回退 */ }
  return null;
};

const resolveClaudeBinary = (): string => {
  const fromProbe = resolveCommandOnPath("claude");
  if (fromProbe) {
    if (/\.(cmd|bat)$/i.test(fromProbe)) {
      const realExe = resolveCmdShimTarget(fromProbe);
      if (realExe) return realExe;
      // 同目录替换（极少数情况 shim 与 exe 同目录）
      const sameDirExe = fromProbe.replace(/\.(cmd|bat)$/i, ".exe");
      if (existsSync(sameDirExe)) return sameDirExe;
    }
    return fromProbe;
  }
  // 最后兜底：用 command-resolver 的通用搜索
  const fallback = resolveCommand("claude");
  if (existsSync(fallback)) return fallback;
  return "claude";
};

/**
 * Agent 运行时编排器。
 *
 * 负责：
 * - 消息分发（dispatchToAgent / runAgent / runAgentDm / runAgentReminder）
 * - Agent 注册表管理
 * - 常驻会话缓存（PTY 模式单进程常驻 / PersistentClaude 模式类常驻）
 * - 与 agent-tokens / live-run-registry 集成
 *
 * ### 启动路径
 * - 默认（PTY 模式）：node-pty 启动 Claude CLI，等 `❯` 提示符就绪后写入
 * - 兜底（`SLOCK_PERSISTENT_CLAUDE=1`）：旧 PersistentClaude + stream-json
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
  /**
   * 崩溃恢复 autostart（见 docs/2026-07-16/13-autostart-session-resume-plan.md
   * 方案 A）：daemon 重启后，把崩溃前正在运行的 agent 重新拉起来，不等它们
   * 自然收到下一条真实消息才冷启动。内部直接复用 dispatchToAgent 的完整流程
   * （token 换取/PTY 启动/状态机迁移都不用重新实现），只是触发内容换成一条
   * "系统重启，安静等待，不用主动发言"的说明，而不是真实用户消息。
   */
  autostartAgent(agentName: string): Promise<void>;

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

  // PTY 接入（供外部注入 / 测试用）
  __getAgentManager(): IAgentManager;
  __getDispatcher(): IAgentStdinDispatcher;
  __getRunId(agentName: string): string | null;
}

export const createAgentRuntime = (
  options: AgentRuntimeOptions,
  tokenRegistry: IAgentTokenRegistry,
  liveRunRegistry: ILiveRunRegistry,
  runStore?: IAgentRunStore,
  /** 仅供测试注入假的 IAgentManager（见 test/fakes/fake-agent-manager.ts）；
   *  生产环境不传，默认走真实的 node-pty 实现。 */
  agentManagerOverride?: IAgentManager,
): IAgentRuntime => {
  // ---- 注册表 ----
  const agentDrivers = new Map<string, boolean>();
  const agentSessions = new Map<string, string>();
  const agentNameToId = new Map<string, string>();
  const agentInfo = new Map<string, { displayName?: string; description?: string }>();

  // ---- PTY 模式基础设施 ----
  const agentManager: IAgentManager = agentManagerOverride ?? createAgentManager();
  // agentName -> runId 缓存（常驻 PTY）
  const runIdByAgent = new Map<string, string>();
  // runId -> unsubscribe 函数
  const unsubByRunId = new Map<string, () => void>();
  // 旧 PersistentClaude 路径（兜底）
  const persistentSessions = new Map<string, PersistentClaude>();

  // 默认走 PTY；SLOCK_PERSISTENT_CLAUDE=1 走旧路径
  const usePty = process.env.SLOCK_PERSISTENT_CLAUDE !== "1";

  // ---- Per-agent-run scoped token（见 agent-runtime-credentials.ts）----
  const credentialsClient = createCredentialsClient(options.serverUrl, options.apiKey);

  // ---- 四态模型（见 agent-runtime-state.ts）----
  const stateMachine = createAgentStateMachine();

  // ---- 并发保护 ----
  const dispatchPromises = new Map<string, Promise<void>>();

  // ---- 回合消息计数 + "是否已经观察到忙碌过"（见 agent-runtime-turn-tracker.ts）----
  const turnTracker = createTurnTracker();
  const { hasPending, hasBeenBusy } = turnTracker;

  // ---- stdin 调度器（为每个 agent 复用同一个 writer，因为 runId 是动态的） ----
  const resolvedClaudePath = resolveClaudeBinary();
  if (resolvedClaudePath !== "claude") {
    console.log(`[Runtime] Resolved claude binary: ${resolvedClaudePath}`);
  }
  const postStartWriter: PostStartInputWriter = createPostStartInputWriter(
    agentManager,
    resolvedClaudePath,
  );
  const dispatcher: IAgentStdinDispatcher = createAgentStdinDispatcher(
    agentManager,
    (agentName: string) => runIdByAgent.get(agentName) ?? null,
    postStartWriter,
  );

  const { transitionState, clearStartupTimer } = stateMachine;

  // ---- 空闲回收（对应 ADR-005："工作中的 agent 队列空 + 60s 无活动 -> 优雅关闭"）----
  // touch() 在每次回合结束（working -> idle）时调用；untrack() 在开始新一轮 working 或
  // 显式停止时调用，避免正在处理消息的 agent 被计入空闲时间。
  const idleReclaimer = createIdleReclaimer({
    onReclaim: (name) => {
      const runId = runIdByAgent.get(name);
      if (runId) agentManager.stopRun(runId); // 真正的清理交给下面的退出清理链回调
    },
  });
  idleReclaimer.start();

  // ---- 退出清理链（见 agent-runtime-exit.ts）----
  const exitChain = createExitChain({
    tokenRegistry, runStore, liveRunRegistry, agentManager,
    idleReclaimer, turnTracker, stateMachine, credentialsClient,
    unsubByRunId, runIdByAgent,
  });

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

  // ---- 卡住检测器（诊断用） ----

  /**
   * 每 5s 扫描一次 working 状态的 agent；如果超 30s 还没回到 idle，
   * 打印警告 + 当前 output 长度和尾部 200 字符（去 ANSI），便于排查
   * 回合结束检测为啥没触发。
   */
  let _stuckDetectorInstalled = false;
  const installStuckDetector = (): void => {
    if (_stuckDetectorInstalled) return;
    _stuckDetectorInstalled = true;
    const lastWarnedAt = new Map<string, number>();
    setInterval(() => {
      const now = Date.now();
      for (const { name: agentName, lastTransitionAt } of stateMachine.getWorkingAgents()) {
        const elapsed = now - lastTransitionAt;
        if (elapsed > 30000) {
          // 同一 agent 至少间隔 30s 才再警告一次
          const lastWarn = lastWarnedAt.get(agentName) ?? 0;
          if (now - lastWarn < 30000) continue;
          lastWarnedAt.set(agentName, now);

          const runId = runIdByAgent.get(agentName);
          const run = runId ? agentManager.getRun(runId) : undefined;
          const tail = (run?.output ?? "").slice(-200).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
          const screen = (run?.screenText ?? "").replace(/\s+/g, " ").trim().slice(-300);
          console.warn(
            `[Runtime] @${agentName} STUCK in 'working' for ${(elapsed / 1000).toFixed(1)}s ` +
            `(outputLen=${run?.output.length ?? 0}, pending=${hasPending(agentName)}, ` +
            `busyObserved=${hasBeenBusy(agentName)}); raw tail=...${tail} || screen=...${screen}`,
          );
        }
      }
    }, 5000).unref?.();
  };
  installStuckDetector();

  // ---- PTY 启动（见 agent-runtime-spawn.ts）----
  const spawnPtyForAgent = createSpawnPtyForAgent({
    agentManager, resolvedClaudePath, runStore, exitChain,
    stateMachine, turnTracker, idleReclaimer, postStartWriter,
    runIdByAgent, unsubByRunId,
  });

  // ---- 消息分发核心（见 agent-runtime-dispatch.ts）----
  const { dispatchToAgent, runAgent, runAgentDm, runAgentReminder } = createDispatch({
    options, stateMachine, turnTracker, exitChain, idleReclaimer,
    credentialsClient, postStartWriter, spawnPtyForAgent, usePty,
    resolveAgentId, agentInfo, runIdByAgent, persistentSessions,
    agentSessions, dispatchPromises,
  });

  // ---- 公开接口 ----

  return {
    dispatchToAgent,
    runAgent,
    runAgentDm,
    runAgentReminder,

    async autostartAgent(agentName: string): Promise<void> {
      // 崩溃恢复记录里的 agent 可能已经在服务端被删掉了——只对仍然注册着的
      // agent 生效，不要凭一条陈旧的本地记录去拉起一个已经不存在的 agent。
      if (!agentDrivers.has(agentName)) {
        console.log(`[Daemon] Skip autostart for @${agentName}: no longer registered`);
        return;
      }
      // 没有真实触发它的用户消息/频道，只能用 "general" 兜底（AgentRunRecord
      // 本身不记频道）。userMsg 明确说明这是系统重启、不是真实消息，用来压过
      // 系统提示里"被 @ 了就要回复"的默认框架——不保证 100% 生效（这条路径
      // 没有真机验证过），但至少给了明确指令，不是靠 agent 自己猜。
      const userMsg = [
        `[Slock 系统消息：daemon 重启后自动恢复]`,
        ``,
        `你在崩溃/重启前正在运行，现在被自动重新拉起来、恢复运行环境和记忆——`,
        `这不是用户发来的消息。如果没有真正待处理的用户消息，不需要主动发言，`,
        `安静等待下一条真实消息即可；只有确实有值得跟进的事情才主动开口。`,
      ].join("\n");
      await dispatchToAgent(agentName, "general", userMsg);
    },

    registerAgent(id: string, name: string, info: { displayName?: string; description?: string }): void {
      agentDrivers.set(name, true);
      if (id) agentNameToId.set(name, id);
      agentInfo.set(name, info);
      // 清理旧 PTY / 旧 session
      const oldRunId = runIdByAgent.get(name);
      if (oldRunId) {
        agentManager.stopRun(oldRunId);
        const unsub = unsubByRunId.get(oldRunId);
        if (unsub) { unsub(); unsubByRunId.delete(oldRunId); }
        runIdByAgent.delete(name);
      }
      persistentSessions.get(name)?.stop();
      persistentSessions.delete(name);
      idleReclaimer.untrack(name);
      transitionState(name, "idle");
    },

    unregisterAgent(name: string): void {
      agentNameToId.delete(name);
      agentDrivers.delete(name);
      agentInfo.delete(name);
      agentSessions.delete(name);
      const runId = runIdByAgent.get(name);
      if (runId) {
        agentManager.stopRun(runId);
        const unsub = unsubByRunId.get(runId);
        if (unsub) { unsub(); unsubByRunId.delete(runId); }
        runIdByAgent.delete(name);
      }
      persistentSessions.get(name)?.stop();
      persistentSessions.delete(name);
      clearStartupTimer(name);
      idleReclaimer.untrack(name);
      transitionState(name, "stopped");
    },

    async loadExistingAgents(): Promise<void> {
      try {
        // mine=1：只拉本账号名下的 agent。/api/agents 默认返回所属组织里所有人的
        // agent（给人看的列表需要这个视角），daemon 全注册进来会导致 hasAgent()
        // 谎报、真 spawn 时换不到凭证 403（见 agents-public.ts 的 mine 注释）。
        const res = await fetch(options.serverUrl + "/api/agents?mine=1", {
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
      const runId = runIdByAgent.get(agentName);
      if (runId) {
        agentManager.stopRun(runId);
        const unsub = unsubByRunId.get(runId);
        if (unsub) { unsub(); unsubByRunId.delete(runId); }
        runIdByAgent.delete(agentName);
      }
      persistentSessions.get(agentName)?.stop();
      persistentSessions.delete(agentName);
      idleReclaimer.untrack(agentName);
    },

    stopAll(): void {
      idleReclaimer.stop();
      for (const unsub of unsubByRunId.values()) unsub();
      unsubByRunId.clear();
      for (const runId of runIdByAgent.values()) agentManager.stopRun(runId);
      runIdByAgent.clear();
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
      return stateMachine.getState(name);
    },

    // ---- 内部接入（供测试 / 外部模块使用） ----

    __getAgentManager() {
      return agentManager;
    },

    __getDispatcher() {
      return dispatcher;
    },

    __getRunId(agentName: string): string | null {
      return runIdByAgent.get(agentName) ?? null;
    },
  };
};
