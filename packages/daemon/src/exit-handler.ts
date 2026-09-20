import type { IAgentRunStore, LiveAgentRun } from "./types/index.js";

/**
 * 退出处理链（Exit Handler）。
 *
 * 进程退出时落盘 run 终态（结束时间 + 退出码）。
 * token 吊销不在本地做——scoped runtime token 由 server 侧
 * `credentialsClient.revokeAgentCredential` 撤销（H1：本地注册表
 * `issue()` 自 server 托管 mint 后零调用，已于 2026-09-20 删除）。
 *
 * 设计原则：handler 接收所有上下文，不持有任何状态。
 */

export interface ExitContext {
  runId: string;
  agentId: string;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  startedAt: number;
  messagesProcessed?: number;
}

export type ExitHandler = (ctx: ExitContext) => LiveAgentRun | null;

export const createExitHandler = (opts: ExitHandlerOptions): ExitHandler => {
  return (ctx: ExitContext): LiveAgentRun | null => {
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
  runStore?: IAgentRunStore;
}
