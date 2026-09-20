/**
 * Phase 0（见 docs/2026-09-20/02-daemon-langchain-langgraph-runtime-design.md §6/§7）：
 * provider-neutral 的 runtime 事件模型。
 *
 * 通用编排层（dispatch / observation / cost）只消费本联合；provider 私有事件
 * （Claude stream-json、SARP/1 帧……）在各自 driver 边界内转换完成后才进入。
 * turn.end.usage.costUsd 是**本回合增量**——累计→差值的换算由各 driver 完成
 * （Claude 见 drivers/claude-runtime.ts 的 createSessionCostDelta）。
 *
 * Phase 2 扩展（§7）：progress / usage / interrupt / warning 事件与
 * turn.end 的 interrupted|cancelled 终态——SARP/1 bridge worker 的规范化出口。
 * 约束：progress 只允许 provider 公开的安全摘要，不传递模型隐藏思维链；
 * interrupt 是预览帧，规范来源以 turn.end.interrupt 为准（§8.7.6）。
 */

export interface AgentRuntimeUsage {
  /** 本回合成本增量（USD）；provider 未上报 → null（不填 0 冒充已计量） */
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  /** Phase 2：token 计量（bridge worker 通常没有 USD，只有 token 数） */
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  /** 实际计量的模型（可能与 profile.model 不同——worker 侧覆盖） */
  model?: string;
}

/** turn.interrupt 的规范化载荷（§8.7.6：resumeToken 一次性、payload 尺寸受限） */
export interface AgentRuntimeInterrupt {
  interruptId: string;
  resumeToken: string;
  prompt: string;
  payload?: unknown;
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
      /** §7：provider="slock" + operation="send_message" 是 reply guard 的稳定信号 */
      provider?: string;
      operation?: string;
    }
  | {
      type: "tool.end";
      turnId?: string;
      toolName?: string;
      toolUseId?: string;
      output: string;
      /** Phase 2：工具成败与错误摘要（SARP tool.end.ok/error） */
      ok?: boolean;
      error?: string;
    }
  | {
      type: "turn.end";
      status: "success" | "error" | "interrupted" | "cancelled";
      subtype?: string;
      /** success → finalText；error → 错误摘要 */
      result?: string;
      usage: AgentRuntimeUsage;
      /** status=interrupted 时的规范 interrupt 记录（§8.7.6） */
      interrupt?: AgentRuntimeInterrupt;
    }
  | {
      /** Phase 2：provider 公开的安全进度摘要（SARP assistant.progress） */
      type: "progress";
      turnId?: string;
      message: string;
    }
  | {
      /** Phase 2：回合内 usage 快照（观察用；终态以 turn.end.usage 为准 §8.7.7） */
      type: "usage";
      turnId?: string;
      usage: AgentRuntimeUsage;
    }
  | {
      /** Phase 2：interrupt 预览帧——规范记录以 turn.end.interrupt 为准 */
      type: "interrupt";
      turnId?: string;
      interrupt: AgentRuntimeInterrupt;
    }
  | {
      /** Phase 2：worker 主动告警（SARP optional warning / 未知 optional 帧） */
      type: "warning";
      turnId?: string;
      code?: string;
      message: string;
    };
