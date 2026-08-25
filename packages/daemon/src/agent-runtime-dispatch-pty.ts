/**
 * ❄️ LEGACY / FROZEN（2026-08-20 Step 3；P1.9 整块迁出，内部不改）
 * 本文件全部内容仅服务 PTY fallback（SLOCK_USE_PTY=1）。headless 是默认且受
 * 支持的路径。冻结纪律：不接受新功能与非缺陷改动；仅在 headless 出现不可
 * 修复问题时作回退启用。删除评估：headless 稳定运行满 6 周后（2026-09 底）按
 * docs/2026-08-20/02-daemon-evolution-tracker.md Step 3 原删除方案执行。
 *
 * 从 agent-runtime-dispatch.ts 的 `if (usePty)` 分支原样抽出，行为不变。
 */
import type { ICredentialsClient } from "./agent-runtime-credentials.js";
import type { IExitChain } from "./agent-runtime-exit.js";
import type { SpawnPtyForAgent } from "./agent-runtime-spawn.js";
import type { IAgentStateMachine } from "./agent-runtime-state.js";
import type { ITurnTracker } from "./agent-runtime-turn-tracker.js";
import { createWorkspaceDir, fetchDispatchContext, writeSystemPromptFile } from "./agent-startup.js";
import { writeAgentTokenFile } from "./agent-token-file.js";
import type { IIdleReclaimer } from "./idle-reclaimer.js";
import type { PostStartInputWriter } from "./post-start-input-writer.js";

export interface DispatchPtyTurnOpts {
  agentName: string;
  agentId: string;
  channelName: string;
  userMsg: string;
  haltGen: number;
  serverUrl: string;
  apiKey: string;
  stateMachine: IAgentStateMachine;
  turnTracker: ITurnTracker;
  exitChain: IExitChain;
  idleReclaimer: IIdleReclaimer;
  mintAgentCredential: ICredentialsClient["mintAgentCredential"];
  postStartWriter: PostStartInputWriter;
  spawnPtyForAgent: SpawnPtyForAgent;
  agentInfo: Map<string, { displayName?: string; description?: string }>;
  runIdByAgent: Map<string, string>;
  enterWorking: (agentName: string, expectedGen?: number) => boolean;
  releaseToIdle: (agentName: string) => void;
  assertLive: () => void;
}

export const dispatchPtyTurn = async (opts: DispatchPtyTurnOpts): Promise<void> => {
  const {
    agentName,
    agentId,
    channelName,
    userMsg,
    haltGen,
    stateMachine,
    turnTracker,
    exitChain,
    idleReclaimer,
    mintAgentCredential,
    postStartWriter,
    spawnPtyForAgent,
    agentInfo,
    runIdByAgent,
    enterWorking,
    releaseToIdle,
    assertLive,
  } = opts;
  const { transitionState } = stateMachine;

  try {
    // 首次发送：启动 PTY（bootstrap 系统提示 + 本条用户消息合并成一次写入，
    // 见 spawnPtyForAgent 注释——避免两次独立写产生竞态）；后续发送：复用现有 PTY。
    // 系统提示文件只在这里（新 spawn）生成才有意义——已运行的 PTY 不会重读它。
    if (!runIdByAgent.has(agentName)) {
      transitionState(agentName, "starting");
      // 启动超时 15s
      const timer = setTimeout(() => {
        releaseToIdle(agentName);
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
        assertLive();
        // O11：token 落盘（workspace/.slock/agent-token, 0600），子进程 env 只带
        // 文件路径不带明文。env 对象里保留 SLOCK_AGENT_TOKEN 是给 daemon 内部用的
        // （spawn 侧 registerRunContext → 退出时 tokenRegistry.revokeIfMatches），
        // 真正传给 PTY 子进程前由 buildPtyEnv 剥离。
        const tokenFile = writeAgentTokenFile(workspace, runtimeToken);
        // 查一下自己是不是这个频道的经理、频道里还有哪些别的 agent——写进
        // 系统提示里当确定事实，而不是让 agent 自己猜（见 agent-startup.ts
        // fetchDispatchContext 注释）。查询失败时退回通用提示文案，不阻塞启动。
        const dispatchContext = await fetchDispatchContext(opts.serverUrl, opts.apiKey, agentId, channelName);
        assertLive();
        const promptFile = writeSystemPromptFile(agentName, channelName, true, info, dispatchContext);
        const env = {
          SLOCK_AGENT_ID: agentId,
          SLOCK_AGENT_TOKEN: runtimeToken,
          SLOCK_AGENT_TOKEN_FILE: tokenFile,
          SLOCK_SERVER_URL: opts.serverUrl,
        };
        const runId = await spawnPtyForAgent(agentName, agentId, workspace, promptFile, env, userMsg);
        if (!enterWorking(agentName, haltGen)) {
          throw new Error(`[Daemon] @${agentName} is stopped, cannot dispatch`);
        }
        idleReclaimer.untrack(agentName);
        exitChain.incrementMessagesProcessed(runId);
        console.log(`[Daemon] @${agentName} message dispatched (pty, bootstrap+first msg)`);
      } catch (err: any) {
        releaseToIdle(agentName);
        console.error(`[Daemon] @${agentName} PTY start failed:`, err?.message ?? err);
        // A1：抛出让派发队列重试（token 换取失败、spawn 失败都可能是瞬时的）
        throw err;
      }
    } else {
      if (!enterWorking(agentName, haltGen)) {
        throw new Error(`[Daemon] @${agentName} is stopped, cannot dispatch`);
      }
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
    releaseToIdle(agentName);
    console.error("[Daemon] dispatchToAgent (pty) failed:", err?.message ?? err);
    throw err;
  }
};
