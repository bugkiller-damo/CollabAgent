/**
 * Phase 0（见 docs/2026-09-20/02-daemon-langchain-langgraph-runtime-design.md §6/§7）：
 * provider-neutral 的 runtime 事件模型。
 *
 * 通用编排层（dispatch / observation / cost）只消费本联合；provider 私有事件
 * （Claude stream-json、SARP/1 帧……）在各自 driver 边界内转换完成后才进入。
 * turn.end.usage.costUsd 是**本回合增量**——累计→差值的换算由各 driver 完成
 * （Claude 见 drivers/claude-runtime.ts 的 createSessionCostDelta）。
 */

export interface AgentRuntimeUsage {
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
}

export type AgentRuntimeEvent =
  | { type: "session"; subtype?: string; sessionRef?: string; model?: string }
  | { type: "text"; turnId?: string; text: string }
  | { type: "thinking"; turnId?: string; text: string }
  | {
      type: "tool.start";
      turnId?: string;
      toolName: string;
      toolUseId?: string;
      input?: unknown;
      provider?: string;
      operation?: string;
    }
  | {
      type: "tool.end";
      turnId?: string;
      toolName?: string;
      toolUseId?: string;
      output: string;
    }
  | {
      type: "turn.end";
      status: "success" | "error";
      subtype?: string;
      result?: string;
      usage: AgentRuntimeUsage;
    };
