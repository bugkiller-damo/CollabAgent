import { PersistentClaude } from "./drivers/persistent-claude.js";
import { claudePrint } from "./claude-print.js";
import { writeSystemPromptFile, createWorkspaceDir, fetchDispatchContext } from "./agent-startup.js";
import type { AgentRuntimeOptions } from "./agent-runtime.js";
import type { IAgentStateMachine } from "./agent-runtime-state.js";
import type { ITurnTracker } from "./agent-runtime-turn-tracker.js";
import type { IExitChain } from "./agent-runtime-exit.js";
import type { IIdleReclaimer } from "./idle-reclaimer.js";
import type { PostStartInputWriter } from "./post-start-input-writer.js";
import type { SpawnPtyForAgent } from "./agent-runtime-spawn.js";
import type { ICredentialsClient } from "./agent-runtime-credentials.js";

export interface IDispatch {
  dispatchToAgent(agentName: string, channelName: string, userMsg: string): Promise<void>;
  runAgent(agentName: string, channelName: string, replyTarget: string, senderName: string, content: string): Promise<void>;
  runAgentDm(agentName: string, replyTarget: string, senderName: string, content: string): Promise<void>;
  runAgentReminder(agentName: string, reminder: { title?: string; channel?: string }): Promise<void>;
}

export interface DispatchDeps {
  options: AgentRuntimeOptions;
  stateMachine: IAgentStateMachine;
  turnTracker: ITurnTracker;
  exitChain: IExitChain;
  idleReclaimer: IIdleReclaimer;
  credentialsClient: ICredentialsClient;
  postStartWriter: PostStartInputWriter;
  spawnPtyForAgent: SpawnPtyForAgent;
  usePty: boolean;
  resolveAgentId(agentName: string): string | null;
  /** agentName -> displayName/description（PTY 环境准备用） */
  agentInfo: Map<string, { displayName?: string; description?: string }>;
  /** agentName -> runId 缓存（常驻 PTY） */
  runIdByAgent: Map<string, string>;
  /** 旧 PersistentClaude 路径（兜底）常驻会话 */
  persistentSessions: Map<string, PersistentClaude>;
  /** claudePrint 一次性模式的 session 缓存 */
  agentSessions: Map<string, string>;
  /** 按 agentName 去重，避免同一 agent 并发 dispatch 互相踩 */
  dispatchPromises: Map<string, Promise<void>>;
}

/**
 * 消息分发核心（对应 Hive `team-operations.ts` 的角色）。
 * 见 doc `docs/2026-07-16/14-agent-runtime-split-plan.md` Step 6。
 */
export const createDispatch = (deps: DispatchDeps): IDispatch => {
  const {
    options, stateMachine, turnTracker, exitChain, idleReclaimer,
    credentialsClient, postStartWriter, spawnPtyForAgent, usePty,
    resolveAgentId, agentInfo, runIdByAgent, persistentSessions,
    agentSessions, dispatchPromises,
  } = deps;
  const { transitionState, clearStartupTimer } = stateMachine;
  const { mintAgentCredential } = credentialsClient;

  const doDispatch = async (agentName: string, channelName: string, userMsg: string): Promise<void> => {
    const agentId = resolveAgentId(agentName);
    if (!agentId) { console.error(`[Daemon] No agent id for @${agentName}, skip`); return; }

    if (stateMachine.getState(agentName) === "stopped") {
      console.log(`[Daemon] @${agentName} is stopped, skipping dispatch`);
      return;
    }

    if (usePty) {
      // ---- PTY 模式 ----
      try {
        // 首次发送：启动 PTY（bootstrap 系统提示 + 本条用户消息合并成一次写入，
        // 见 spawnPtyForAgent 注释——避免两次独立写产生竞态）；后续发送：复用现有 PTY。
        // 系统提示文件只在这里（新 spawn）生成才有意义——已运行的 PTY 不会重读它。
        if (!runIdByAgent.has(agentName)) {
          transitionState(agentName, "starting");
          // 启动超时 15s
          const timer = setTimeout(() => {
            clearStartupTimer(agentName);
            transitionState(agentName, "idle");
            console.warn(`[Daemon] @${agentName} PTY startup timed out (15s)`);
          }, 15000);
          stateMachine.setStartupTimer(agentName, timer);

          try {
            const info = agentInfo.get(agentName) || {};
            const workspace = createWorkspaceDir(agentName, info);
            // 换一个 scoped runtime token（只在启动新 PTY 时才需要——写入已运行
            // PTY 的消息不重新 spawn，不需要新 env）。换取失败就直接让本次
            // 启动失败：如果连服务端都换不到 token，agent 起来了也调不了
            // slock message send，不如现在就失败得明确，而不是悄悄退回共享
            // apiKey（那正是这套机制想关掉的安全洞）。
            const runtimeToken = await mintAgentCredential(agentId);
            // 查一下自己是不是这个频道的经理、频道里还有哪些别的 agent——写进
            // 系统提示里当确定事实，而不是让 agent 自己猜（见 agent-startup.ts
            // fetchDispatchContext 注释）。查询失败时退回通用提示文案，不阻塞启动。
            const dispatchContext = await fetchDispatchContext(options.serverUrl, options.apiKey, agentId, channelName);
            const promptFile = writeSystemPromptFile(agentName, channelName, true, info, dispatchContext);
            const env = {
              SLOCK_AGENT_ID: agentId,
              SLOCK_AGENT_TOKEN: runtimeToken,
              SLOCK_SERVER_URL: options.serverUrl,
            };
            const runId = await spawnPtyForAgent(agentName, agentId, workspace, promptFile, env, userMsg);
            clearStartupTimer(agentName);
            transitionState(agentName, "working");
            idleReclaimer.untrack(agentName);
            exitChain.incrementMessagesProcessed(runId);
            console.log(`[Daemon] @${agentName} message dispatched (pty, bootstrap+first msg)`);
          } catch (err: any) {
            clearStartupTimer(agentName);
            transitionState(agentName, "idle");
            console.error(`[Daemon] @${agentName} PTY start failed:`, err?.message ?? err);
            return;
          }
        } else {
          transitionState(agentName, "working");
          idleReclaimer.untrack(agentName);

          // 写入用户消息（内部已用 postStartWriter 等提示符）
          const runId = runIdByAgent.get(agentName)!;
          // 只有当前没有"还在等回复"的消息时才清掉"观察到过忙碌"这个标记——
          // 如果是重叠写入（上一条还没处理完这条又来了），Claude 可能已经在忙，
          // 不能把这个证据清掉，否则会重新要求"再忙碌一次"才能判定结束。
          if (!turnTracker.hasPending(agentName)) turnTracker.clearBusyObserved(agentName);
          turnTracker.incPending(agentName);
          postStartWriter(runId, userMsg);
          exitChain.incrementMessagesProcessed(runId);
          console.log(`[Daemon] @${agentName} message dispatched (pty)`);
        }
      } catch (err: any) {
        clearStartupTimer(agentName);
        transitionState(agentName, "idle");
        console.error("[Daemon] dispatchToAgent (pty) failed:", err?.message ?? err);
      }
      return;
    }

    // ---- 兜底：PersistentClaude / claudePrint 路径 ----
    const needsSpawn = !persistentSessions.has(agentName);
    if (needsSpawn) {
      transitionState(agentName, "starting");
      const timer = setTimeout(() => {
        clearStartupTimer(agentName);
        transitionState(agentName, "idle");
        console.warn(`[Daemon] @${agentName} startup timed out (15s)`);
      }, 15000);
      stateMachine.setStartupTimer(agentName, timer);
    }

    try {
      const info = agentInfo.get(agentName) || {};
      const promptFile = writeSystemPromptFile(agentName, channelName, true, info);
      const workspace = createWorkspaceDir(agentName, info);

      // 见上面 PTY 分支的注释：服务端不认账号级 apiKey 之外的凭证要走 scoped
      // runtime token；这条兜底路径较少用，直接每次都换一个（幂等 upsert，
      // 覆盖上一条也无妨）
      const runtimeToken = await mintAgentCredential(agentId);
      const env = {
        SLOCK_AGENT_ID: agentId,
        SLOCK_AGENT_TOKEN: runtimeToken,
        SLOCK_SERVER_URL: options.serverUrl,
      };

      const usePersistent = process.env.SLOCK_PERSISTENT_CLAUDE === "1";
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

  // dedup 包装
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
      `请用 \`send_message\` 工具（target="${replyTarget}"）回复；没有该工具时退回` +
        `\`slock message send --target "${replyTarget}"\`（内容从 stdin 传入）`,
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
      `请用 \`send_message\` 工具（target="${replyTarget}"）直接回复；没有该工具时退回` +
        `\`slock message send --target "${replyTarget}"\`（内容从 stdin 传入）。`,
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
      ? `相关频道：${reminder.channel}。如需发消息，用 \`send_message\` 工具（target="${reminder.channel}"），没有该工具时退回` +
        `\`echo "内容" | slock message send --target "${reminder.channel}"\`。`
      : `没有指定频道；如需发消息，先用 \`slock server info\` 找到合适频道，或按你 MEMORY.md 里的约定。`;
    const userMsg = [
      `⏰ 你之前设置的提醒触发了：「${reminder.title || "(无标题)"}」。`,
      where,
      `请据此完成相应跟进；处理完即结束本回合。`,
    ].join("\n");
    await dispatchToAgent(agentName, channelName, userMsg);
  };

  return { dispatchToAgent, runAgent, runAgentDm, runAgentReminder };
};
