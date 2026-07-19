import { createExitCoordinator } from "./exit-coordinator.js";
import { createExitHandler, createMinimalExitHandler } from "./exit-handler.js";
import { appendTerminalLog } from "./terminal-log.js";
import type {
  IAgentTokenRegistry,
  ILiveRunRegistry,
  IAgentManager,
  IAgentRunStore,
  LiveAgentRun,
} from "./types/index.js";
import type { IAgentStateMachine } from "./agent-runtime-state.js";
import type { ITurnTracker } from "./agent-runtime-turn-tracker.js";
import type { IIdleReclaimer } from "./idle-reclaimer.js";
import type { ICredentialsClient } from "./agent-runtime-credentials.js";

/**
 * PTY 退出清理链（仿照 Hive `agent-run-exit-handler.ts`）。
 *
 * PTY 自然退出（崩溃/正常退出）时，`runIdByAgent`/`unsubByRunId`/live-run-registry
 * 之前完全没有清理入口，导致下一次 dispatch 仍认为该 agent "在运行"，消息被
 * postStartWriter 静默丢弃，agent 永久卡死（live bug 3 的根因之一）。这个模块
 * 把"一个 run 死掉之后要做的所有清理"串成一条链，串联了 exit-coordinator.ts
 * （时序保护）+ exit-handler.ts（token 吊销 + 落盘）+ 服务端 scoped token 撤销 +
 * pending/busyObserved 状态重置（live bug 9）+ agentManager 内部记录清理。
 */
export interface RunContextEntry {
  agentName: string;
  agentId: string;
  token: string;
  startedAt: number;
}

export interface IExitChain {
  /** spawnPtyForAgent 启动一个新 run 时调用，登记这次 run 的上下文 */
  registerRunContext(runId: string, ctx: RunContextEntry): void;
  /** 每次往这个 run 写入一条用户消息时调用，供 runStore 持久化 + 重启摘要展示 */
  incrementMessagesProcessed(runId: string): void;
  /** spawnPtyForAgent 在 agentManager.startAgent 的 onExit 里直接转发 */
  onExit(runId: string, exitCode: number | null): void;
  /** spawnPtyForAgent 拿到 snapshot 之后调用，登记退出时序保护通道 */
  preSpawn(runId: string): void;
  /** spawnPtyForAgent 拿到 snapshot 之后调用，登记到 live-run-registry */
  register(run: LiveAgentRun): void;
}

export interface ExitChainDeps {
  tokenRegistry: IAgentTokenRegistry;
  runStore?: IAgentRunStore;
  liveRunRegistry: ILiveRunRegistry;
  agentManager: IAgentManager;
  idleReclaimer: IIdleReclaimer;
  turnTracker: ITurnTracker;
  stateMachine: IAgentStateMachine;
  credentialsClient: ICredentialsClient;
  /** runId -> unsubscribe 函数（回合结束订阅），退出时要一并取消 */
  unsubByRunId: Map<string, () => void>;
  /** agentName -> runId，退出时仅当仍指向这次 run 才清理（防止新 run 已覆盖旧 runId 的竞态） */
  runIdByAgent: Map<string, string>;
}

export const createExitChain = (deps: ExitChainDeps): IExitChain => {
  const {
    tokenRegistry, runStore, liveRunRegistry, agentManager,
    idleReclaimer, turnTracker, stateMachine, credentialsClient,
    unsubByRunId, runIdByAgent,
  } = deps;

  const runContext = new Map<string, RunContextEntry>();
  const messagesProcessedByRun = new Map<string, number>();

  // 有 runStore 时用完整 handler（吊销 token + 落盘 run 记录）；否则退化为仅撤销 token
  const exitHandler = runStore
    ? createExitHandler({ tokenRegistry, runStore })
    : createMinimalExitHandler(tokenRegistry);

  const exitCoordinator = createExitCoordinator(liveRunRegistry, (runId, exitCode) => {
    const ctx = runContext.get(runId);
    if (!ctx) return;
    runContext.delete(runId);
    const messagesProcessed = messagesProcessedByRun.get(runId) ?? 0;
    messagesProcessedByRun.delete(runId);

    // 1) 吊销本地 token 记录（仅在仍匹配时——防止新 run 已重新签发的 token 被误删）
    //    +（若有 runStore）落盘最终状态
    exitHandler({
      runId, agentId: ctx.agentId, token: ctx.token, exitCode,
      startedAt: ctx.startedAt, messagesProcessed,
    });
    // 1b) 撤销服务端那份 scoped runtime token（best-effort，不阻塞/不影响退出流程）
    void credentialsClient.revokeAgentCredential(ctx.agentId);

    // 2) 取消输出订阅
    const unsub = unsubByRunId.get(runId);
    if (unsub) { unsub(); unsubByRunId.delete(runId); }

    idleReclaimer.untrack(ctx.agentName);
    // pending/busyObserved 是按 agentName（不是 runId）存的；这个 run 已经死了，
    // 任何"还在等回复"/"观察到过忙碌"的期待都不再有意义。不清理的话，下次给
    // 同一个 agent 全新 spawn 一个 PTY 时，hasPending() 会带着这个陈年 true 直接
    // 放行回合结束检测的门槛检查，导致刚启动的空闲欢迎屏被立刻误判成"回复已
    // 完成"（复现过 live bug 3/9 的症状）。
    turnTracker.decPending(ctx.agentName);
    turnTracker.clearBusyObserved(ctx.agentName);

    // 3) 仅当 runIdByAgent 仍指向这次 run 才清理（防止新 run 已覆盖旧 runId 的竞态）
    if (runIdByAgent.get(ctx.agentName) === runId) {
      runIdByAgent.delete(ctx.agentName);
      stateMachine.clearStartupTimer(ctx.agentName);
      const currentStatus = stateMachine.getState(ctx.agentName);
      // "stopped" 只应由显式 unregisterAgent 设置；崩溃退出转回 "idle"，
      // 让下一条消息能重新拉起 PTY，而不是被 doDispatch 的 stopped 检查拦截。
      if (currentStatus && currentStatus !== "stopped") {
        try { stateMachine.transitionState(ctx.agentName, "idle"); } catch { /* 无效迁移已在内部吞掉 */ }
      }
    }

    // 3.5) 终端日志落盘（G3 历史回看）：在 removeRun 清掉终端镜像之前，把本次
    // run 的 scrollback+当前屏文本追加到 .slock/terminal-logs/<agent>.log——
    // agent 被回收/重启之后，观众仍能回看这个 run 干了什么。
    const dyingRun = agentManager.getRun(runId);
    if (dyingRun?.historyText) {
      appendTerminalLog(ctx.agentName, runId, exitCode, dyingRun.historyText);
    }

    // 4) 清理 agent-manager 内部的 processes Map + outputBus 订阅
    agentManager.removeRun(runId);

    console.warn(
      `[Runtime] @${ctx.agentName} PTY exited (code=${exitCode}); cleaned up runId=${runId.slice(0, 8)}`,
    );
  });

  return {
    registerRunContext: (runId, ctx) => runContext.set(runId, ctx),
    incrementMessagesProcessed: (runId) => messagesProcessedByRun.set(runId, (messagesProcessedByRun.get(runId) ?? 0) + 1),
    onExit: (runId, exitCode) => exitCoordinator.onExit(runId, exitCode),
    preSpawn: (runId) => exitCoordinator.preSpawn(runId),
    register: (run) => exitCoordinator.register(run),
  };
};
