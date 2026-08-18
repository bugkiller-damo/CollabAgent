import type { IAgentRunStore, IAgentTokenRegistry, LiveAgentRun } from "./types/index.js";

/**
 * 完整退出处理链（Full Exit Handler）。
 *
 * 进程退出时一次性完成所有清理：
 * 1. tokenRegistry.revokeIfMatches — 吊销 token（仅匹配时，防止竞态）
 * 2. runStore.updateAgentRun — 写入结束时间 + 退出码
 *
 * 设计原则：handler 接收所有上下文，不持有任何状态。
 */

export interface ExitContext {
  runId: string;
  agentId: string;
  token: string;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  startedAt: number;
  messagesProcessed?: number;
}

export type ExitHandler = (ctx: ExitContext) => LiveAgentRun | null;

export const createExitHandler = (opts: ExitHandlerOptions): ExitHandler => {
  return (ctx: ExitContext): LiveAgentRun | null => {
    if (ctx.token) {
      opts.tokenRegistry.revokeIfMatches(ctx.agentId, ctx.token);
    }

    const endedAt = Date.now();
    const result: LiveAgentRun = {
      runId: ctx.runId,
      agentId: ctx.agentId,
      pid: null,
      status: ctx.exitCode === 0 ? "exited" : "error",
      output: "",
      exitCode: ctx.exitCode,
      startedAt: ctx.startedAt,
    };

    if (opts.runStore) {
      try {
        opts.runStore.updateAgentRun(ctx.runId, {
          status: result.status,
          exitCode: ctx.exitCode,
          endedAt,
          messagesProcessed: ctx.messagesProcessed ?? 0,
          lastTurnDuration: endedAt - ctx.startedAt,
        });
      } catch (err: any) {
        console.error(`[ExitHandler] runStore.update failed: ${err?.message}`);
      }
    }

    console.log(
      `[ExitHandler] run=${ctx.runId.slice(0, 8)} agent=${ctx.agentId.slice(0, 8)} ` +
        `exit=${ctx.exitCode}${ctx.signal ? ` signal=${ctx.signal}` : ""}`,
    );
    return result;
  };
};

export interface ExitHandlerOptions {
  tokenRegistry: IAgentTokenRegistry;
  runStore?: IAgentRunStore;
}

/** 零依赖版 handler（仅吊销 token，无持久化） */
export const createMinimalExitHandler = (tokenRegistry: IAgentTokenRegistry): ExitHandler => {
  return createExitHandler({ tokenRegistry });
};
