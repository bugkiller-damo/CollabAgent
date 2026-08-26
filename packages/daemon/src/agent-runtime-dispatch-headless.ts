import { writeMcpConfig } from "./agent-mcp-config.js";
import type { ProgressTurn } from "./agent-progress.js";
import type { ICredentialsClient } from "./agent-runtime-credentials.js";
import { abortTurnGuards, armTurnGuard, type TurnGuard } from "./agent-runtime-dispatch-stream.js";
import type { IAgentStateMachine } from "./agent-runtime-state.js";
import { createWorkspaceDir, writeSystemPromptFile } from "./agent-startup.js";
import type { IThreadSessionStore } from "./agent-thread-sessions.js";
import { writeAgentTokenFile } from "./agent-token-file.js";
import { claudePrint } from "./claude-print.js";
import type { ClaudeStreamEvent } from "./claude-stream.js";
import { loadDaemonEnv } from "./config.js";
import { PersistentClaude } from "./drivers/persistent-claude.js";
import { DispatchError, errMessage } from "./errors.js";
import type { IIdleReclaimer } from "./idle-reclaimer.js";
import { bundleSlockMcpServer } from "./mcp-bundle.js";

export interface DispatchHeadlessTurnOpts {
  agentName: string;
  agentId: string;
  channelName: string;
  userMsg: string;
  threadId?: string;
  haltGen: number;
  serverUrl: string;
  stateMachine: IAgentStateMachine;
  idleReclaimer: IIdleReclaimer;
  mintAgentCredential: ICredentialsClient["mintAgentCredential"];
  agentInfo: Map<string, { displayName?: string; description?: string }>;
  persistentSessions: Map<string, PersistentClaude>;
  /**
   * P1.12：per-agent 会话创建单飞。A1 队列在 in-flight 超时后会与仍在跑的
   * deliver 重叠，两个 dispatchHeadlessTurn 都可能看到空 map 并各 new 一个
   * PersistentClaude——后写覆盖前写，旧实例永不 stop。
   */
  sessionCreates: Map<string, Promise<PersistentClaude>>;
  agentSessions: Map<string, string>;
  threadSessions?: IThreadSessionStore;
  turnGuards: Map<string, TurnGuard>;
  progressTurns: Map<string, ProgressTurn>;
  handleStreamEvent: (agentName: string, ev: ClaudeStreamEvent) => void;
  createProgressPoster?: (agentName: string) => import("./agent-progress.js").ProgressPoster;
  onProgress?: (agentName: string, channelName: string, headline: string, phase: "start" | "update" | "end") => void;
  enterWorking: (agentName: string, expectedGen?: number) => boolean;
  releaseToIdle: (agentName: string) => void;
  assertLive: () => void;
  /** P0.5 / P1.12：丢掉常驻会话后清成本基线，避免新进程少记 */
  forgetSessionCost?: (agentName: string) => void;
}

/**
 * P1.12：同一 agent 的 PersistentClaude 创建单飞。
 * 先在同步路径占坑 `sessionCreates`，再 `then` 里 create——两个从 await mint
 * 回来的调用会共用同一个 Promise，不会各 new 一个实例。create 抛错不占
 * persistentSessions，锁在 finally 清掉，调用方可重试。
 */
export const ensurePersistentSession = (
  agentName: string,
  persistentSessions: Map<string, PersistentClaude>,
  sessionCreates: Map<string, Promise<PersistentClaude>>,
  create: () => PersistentClaude,
): Promise<PersistentClaude> => {
  const hit = persistentSessions.get(agentName);
  if (hit) return Promise.resolve(hit);
  const pending = sessionCreates.get(agentName);
  if (pending) return pending;

  const created = Promise.resolve().then(() => {
    const raced = persistentSessions.get(agentName);
    if (raced) return raced;
    const session = create();
    persistentSessions.set(agentName, session);
    return session;
  });
  sessionCreates.set(agentName, created);
  // catch 吞掉这条旁路链上的拒绝，避免 create 抛错时变成 unhandled rejection
  // （调用方仍通过返回的 created 自己处理）。
  void created
    .finally(() => {
      if (sessionCreates.get(agentName) === created) sessionCreates.delete(agentName);
    })
    .catch(() => {});
  return created;
};

/** P1.12：只踢掉「本回合持有」的实例，避免误杀并发赢家刚换上的新会话。 */
export const dropStalePersistentSession = (
  agentName: string,
  persistentSessions: Map<string, PersistentClaude>,
  session: PersistentClaude | undefined,
  forgetSessionCost?: (agentName: string) => void,
): void => {
  if (!session) return;
  if (persistentSessions.get(agentName) !== session) return;
  try {
    session.stop();
  } catch {
    /* stop 失败仍要从 map 摘掉，避免下次 send 打到死实例 */
  }
  persistentSessions.delete(agentName);
  try {
    forgetSessionCost?.(agentName);
  } catch {
    /* 基线清理是旁路 */
  }
};

export const dispatchHeadlessTurn = async (opts: DispatchHeadlessTurnOpts): Promise<void> => {
  const {
    agentName,
    agentId,
    channelName,
    userMsg,
    threadId,
    haltGen,
    stateMachine,
    idleReclaimer,
    mintAgentCredential,
    agentInfo,
    persistentSessions,
    sessionCreates,
    agentSessions,
    threadSessions,
    turnGuards,
    progressTurns,
    handleStreamEvent,
    enterWorking,
    releaseToIdle,
    assertLive,
    forgetSessionCost,
  } = opts;
  const { transitionState } = stateMachine;

  // 整段 dispatch（含 await mint）期间不计入空闲，避免复用路径上
  // mint 等待时扫描把即将 send 的常驻进程杀掉（P0.2）。
  idleReclaimer.untrack(agentName);
  const needsSpawn = !persistentSessions.has(agentName);
  if (needsSpawn) {
    transitionState(agentName, "starting");
    const timer = setTimeout(() => {
      releaseToIdle(agentName);
      console.warn(`[Daemon] @${agentName} startup timed out (15s)`);
    }, 15000);
    stateMachine.setStartupTimer(agentName, timer);
  }

  try {
    const info = agentInfo.get(agentName) || {};
    const promptFile = writeSystemPromptFile(agentName, channelName, true, info);
    const workspace = createWorkspaceDir(agentName, info);

    // 见 PTY 分支的注释：服务端不认账号级 apiKey 之外的凭证要走 scoped
    // runtime token；这条兜底路径较少用，直接每次都换一个（幂等 upsert，
    // 覆盖上一条也无妨）
    const runtimeToken = await mintAgentCredential(agentId);
    assertLive();
    // O11：这条路径的 env 直接进子进程（PersistentClaude / claudePrint），
    // 只放 token 文件路径，不放明文 token。
    const env = {
      SLOCK_AGENT_ID: agentId,
      SLOCK_AGENT_TOKEN_FILE: writeAgentTokenFile(workspace, runtimeToken),
      SLOCK_SERVER_URL: opts.serverUrl,
    };

    // MCP 工具接入（与 PTY 路径对齐，见 agent-runtime-spawn.ts）：headless
    // 路径此前漏写 .mcp.json——agent 没有 send_message MCP 工具，只能靠记住
    // `slock` CLI 命令回复；弱模型在受挫回合里会忘（2026-08-18 真机：天气
    // 查到了但纯文本作答结束回合，频道永远收不到）。失败不阻塞：CLI 兜底仍在。
    try {
      const mcpBundlePath = await bundleSlockMcpServer();
      if (mcpBundlePath) {
        writeMcpConfig(workspace, agentId, env.SLOCK_AGENT_TOKEN_FILE ?? "", env.SLOCK_SERVER_URL ?? "", mcpBundlePath);
      }
    } catch (err) {
      console.warn(`[Daemon] @${agentName} MCP config setup failed (headless), CLI-only fallback: ${errMessage(err)}`);
    }
    assertLive();

    const usePersistent = !loadDaemonEnv().oneshotClaude;
    if (usePersistent) {
      // P1.12：创建加锁。mint/MCP 之后再 ensure，避免两个重叠的 deliver
      // 各 new 一个 PersistentClaude，后写覆盖前写、旧实例永不 stop。
      const session = await ensurePersistentSession(
        agentName,
        persistentSessions,
        sessionCreates,
        () =>
          new PersistentClaude({
            cwd: workspace,
            systemPromptFile: promptFile,
            env,
            label: "@" + agentName,
            onStreamEvent: (ev) => handleStreamEvent(agentName, ev),
            // 当前进程崩溃 / 外部 kill：headless 下不会再有 result 事件，状态机
            // 靠这个回调从 working 解封。沉默超时由 session.send reject → 下方
            // catch 解封，不走本回调（P0.1：迟到 onExit 会拆掉新回合的进度条）。
            onExit: () => {
              if (stateMachine.getState(agentName) === "working") {
                transitionState(agentName, "idle");
                idleReclaimer.touch(agentName);
                console.log(`[Daemon] @${agentName} persistent process exited mid-turn, state -> idle`);
              }
              abortTurnGuards(agentName, turnGuards, progressTurns, opts.onProgress);
            },
          }),
      );
      if (!enterWorking(agentName, haltGen)) {
        dropStalePersistentSession(agentName, persistentSessions, session, forgetSessionCost);
        throw new DispatchError("agent-stopped", `[Daemon] @${agentName} is stopped, cannot dispatch`);
      }
      if (persistentSessions.get(agentName) !== session) {
        releaseToIdle(agentName);
        throw new DispatchError("session-lost", `[Daemon] @${agentName} session was stopped during spawn`);
      }
      // 与 PTY 复用分支对齐：进入 working 后从空闲计时器摘掉，
      // 否则上一回合 touch 的倒计时会在本回合中途把常驻进程杀掉（P0.2）。
      idleReclaimer.untrack(agentName);
      armTurnGuard({
        agentName,
        channelName,
        userMsg,
        threadId,
        turnGuards,
        progressTurns,
        createProgressPoster: opts.createProgressPoster,
        onProgress: opts.onProgress,
      });
      try {
        // 回合级交付：await 到 result 事件（进程 mid-turn 退出则 reject → A1 队列
        // 退避重试，换 fresh 会话重投这条消息）。状态机回 idle 由 handleStreamEvent
        // 的 result 分支负责（早于这里的 resolve，顺序无害）。
        await session.send(userMsg);
      } catch (err) {
        // P1.12：send 失败后踢掉本实例。否则下一条以为无需 spawn，
        // 直接对死/停过的实例 send（Fake 不会自愈；真驱动虽能 respawn
        // 但 env/onExit 仍是失败那次的）。
        dropStalePersistentSession(agentName, persistentSessions, session, forgetSessionCost);
        throw err;
      }
      console.log(`[Daemon] @${agentName} turn finished (persistent)`);
    } else {
      if (!enterWorking(agentName, haltGen)) {
        throw new DispatchError("agent-stopped", `[Daemon] @${agentName} is stopped, cannot dispatch`);
      }
      armTurnGuard({
        agentName,
        channelName,
        userMsg,
        threadId,
        turnGuards,
        progressTurns,
        createProgressPoster: opts.createProgressPoster,
        onProgress: opts.onProgress,
      });
      const sid = threadId
        ? (threadSessions?.lookup(agentName, threadId)?.sessionId ?? agentSessions.get(agentName))
        : agentSessions.get(agentName);
      const claude = await claudePrint(userMsg, sid, promptFile, env, workspace, (ev) =>
        handleStreamEvent(agentName, ev),
      );
      if (claude.sessionId) {
        agentSessions.set(agentName, claude.sessionId);
        if (threadId) threadSessions?.remember(agentName, threadId, claude.sessionId);
      }
      console.log(`[Daemon] @${agentName} turn finished (one-shot)`);
      releaseToIdle(agentName);
      // one-shot 不留常驻进程，无需 touch；显式 untrack 以免上一路径残留计时。
      idleReclaimer.untrack(agentName);
    }
  } catch (err) {
    releaseToIdle(agentName);
    idleReclaimer.touch(agentName);
    abortTurnGuards(agentName, turnGuards, progressTurns, opts.onProgress);
    console.error("[Daemon] dispatchToAgent failed:", errMessage(err));
    throw err;
  }
};
