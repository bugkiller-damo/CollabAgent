import { writeMcpConfig } from "./agent-mcp-config.js";
import type { ProgressTurn } from "./agent-progress.js";
import type { ICredentialsClient } from "./agent-runtime-credentials.js";
import { abortTurnGuards, armTurnGuard, type TurnGuard } from "./agent-runtime-dispatch-stream.js";
import type { IAgentStateMachine } from "./agent-runtime-state.js";
import { createWorkspaceDir, writeSystemPromptFile } from "./agent-startup.js";
import type { IThreadSessionStore } from "./agent-thread-sessions.js";
import { writeAgentTokenFile } from "./agent-token-file.js";
import { claudePrint } from "./claude-print.js";
import { loadDaemonEnv } from "./config.js";
import { PersistentClaude } from "./drivers/persistent-claude.js";
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
  agentSessions: Map<string, string>;
  threadSessions?: IThreadSessionStore;
  turnGuards: Map<string, TurnGuard>;
  progressTurns: Map<string, ProgressTurn>;
  handleStreamEvent: (agentName: string, ev: any) => void;
  createProgressPoster?: (agentName: string) => import("./agent-progress.js").ProgressPoster;
  onProgress?: (agentName: string, channelName: string, headline: string, phase: "start" | "update" | "end") => void;
  enterWorking: (agentName: string, expectedGen?: number) => boolean;
  releaseToIdle: (agentName: string) => void;
  assertLive: () => void;
}

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
    agentSessions,
    threadSessions,
    turnGuards,
    progressTurns,
    handleStreamEvent,
    enterWorking,
    releaseToIdle,
    assertLive,
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
    } catch (err: any) {
      console.warn(
        `[Daemon] @${agentName} MCP config setup failed (headless), CLI-only fallback: ${err?.message ?? err}`,
      );
    }
    assertLive();

    const usePersistent = !loadDaemonEnv().oneshotClaude;
    if (usePersistent) {
      let session = persistentSessions.get(agentName);
      if (!session) {
        session = new PersistentClaude({
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
        });
        persistentSessions.set(agentName, session);
      }
      if (!enterWorking(agentName, haltGen)) {
        throw new Error(`[Daemon] @${agentName} is stopped, cannot dispatch`);
      }
      if (persistentSessions.get(agentName) !== session) {
        releaseToIdle(agentName);
        throw new Error(`[Daemon] @${agentName} session was stopped during spawn`);
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
      // 回合级交付：await 到 result 事件（进程 mid-turn 退出则 reject → A1 队列
      // 退避重试，换 fresh 会话重投这条消息）。状态机回 idle 由 handleStreamEvent
      // 的 result 分支负责（早于这里的 resolve，顺序无害）。
      await session.send(userMsg);
      console.log(`[Daemon] @${agentName} turn finished (persistent)`);
    } else {
      if (!enterWorking(agentName, haltGen)) {
        throw new Error(`[Daemon] @${agentName} is stopped, cannot dispatch`);
      }
      const sid = threadId
        ? (threadSessions?.lookup(agentName, threadId)?.sessionId ?? agentSessions.get(agentName))
        : agentSessions.get(agentName);
      const claude = await claudePrint(userMsg, sid, promptFile, env, workspace);
      if (claude.sessionId) {
        agentSessions.set(agentName, claude.sessionId);
        if (threadId) threadSessions?.remember(agentName, threadId, claude.sessionId);
      }
      console.log(`[Daemon] @${agentName} turn finished (one-shot)`);
      releaseToIdle(agentName);
      // one-shot 不留常驻进程，无需 touch；显式 untrack 以免上一路径残留计时。
      idleReclaimer.untrack(agentName);
    }
  } catch (err: any) {
    releaseToIdle(agentName);
    idleReclaimer.touch(agentName);
    abortTurnGuards(agentName, turnGuards, progressTurns, opts.onProgress);
    console.error("[Daemon] dispatchToAgent failed:", err?.message);
    throw err;
  }
};
