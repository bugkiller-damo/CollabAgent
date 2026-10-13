/**
 * Phase 0：runtime driver 边界。通用层不再 import provider 实现类型——
 * Claude / 将来的 SARP bridge 都收成同一组 session / driver contract。
 *
 * - `AgentRuntimeSession`：一个已打开的执行会话（常驻进程或一次性包装），
 *   send() 返回回合级 Promise（persistent 到 turn.end，oneshot 到进程结束）。
 * - `AgentRuntimeDriver`：按 mode 打开会话；forgetAgent 清该 agent 在 driver
 *   内累积的状态（如 Claude 的会话成本基线）。
 * - `AgentRuntimeRegistry`：runtimeId → driver 的唯一映射；重复注册在构造期
 *   拒绝（启动配置错误），未知 runtime 在派发路径抛 permanent DispatchError。
 */

import type { DispatchKind } from "./agent-dispatch-queue.js";
import type { AgentRuntimeEvent, AgentRuntimeInterrupt, AgentRuntimeUsage } from "./agent-runtime-events.js";
import { DispatchError } from "./errors.js";
import type { SarpResumeDecision, SarpTurnMessage } from "./sarp-protocol.js";

export type AgentRuntimeMode = "persistent" | "oneshot";

/**
 * Phase 2（设计 §8.4）：回合请求。turnId 由队列 item 携带（首次入队生成，
 * A1 retry 复用、attempt 递增）；conversationId 由 dispatch 按 §11.1 分类法
 * 生成（thread/channel/dm/triage/reminder）。Claude driver 只用 prompt，
 * bridge driver 把整包写进 SARP turn.start。
 */
export interface AgentTurnRequest {
  turnId: string;
  conversationId: string;
  attempt: number;
  prompt: string;
  source: {
    kind: DispatchKind;
    channel?: string;
    threadId?: string;
    sender?: string;
  };
  /**
   * WP7：触发本回合的人类消息原文与结构化附件（队列合并批次已按
   * "\n\n" 拼接 text、顺序拼接 attachments）。仅人类消息来源的批次
   * 携带；reminder/triage/nudge 等缺省。Claude driver 忽略。
   */
  message?: SarpTurnMessage;
  /**
   * WP7：平台注入的会话历史信封文本（与 prompt 内嵌历史同源）。
   * 仅 bridge 回合填充——Claude 的 prompt 已包含历史，无需重复下发。
   */
  contextText?: string;
  /** interrupt 恢复（§8.7.6）：同 conversation 下一条消息作为 resume.value */
  resume?: {
    interruptId: string;
    resumeToken: string;
    /**
     * WP7/G2：人类回复原文（message.text 合并值）——不是组装后的
     * prompt（含平台指令/历史信封）。
     */
    value: string;
    /**
     * WP7：结构化审批决定（中立形状）。无结构化来源（纯文本回复）时
     * 缺省——daemon 不从回复文本推断决定。
     */
    decision?: SarpResumeDecision;
  };
}

export interface AgentRuntimeTurnResult {
  sessionRef?: string;
  /** Phase 2：非 success 终态（interrupted / cancelled）；缺省视为 success */
  status?: "success" | "interrupted" | "cancelled";
  /** bridge worker 的规范最终文本（§8.7.5：不以 delta 拼接为准） */
  finalText?: string;
  usage?: AgentRuntimeUsage;
  /** status=interrupted 的规范 interrupt 记录（dispatch 据此持久化待恢复） */
  interrupt?: AgentRuntimeInterrupt;
}

/**
 * WP11：回合级取消结果。
 * - `"idle"`：无活动回合（调用方语义上的 no-op）；
 * - `"cancelled"`：取消已生效——活动回合到达任一终态（turn.end），
 *   常驻进程保留、会话可继续接后续回合；
 * - `"killed"`：等不到终态/进程已死/写帧失败——已回退既有 kill 路径，
 *   进程不保（下次 dispatch 冷启动重建）。
 */
export type CancelTurnResult = "cancelled" | "killed" | "idle";

export interface AgentRuntimeSession {
  readonly alive: boolean;
  // biome-ignore lint/suspicious/noConfusingVoidType: void 是有意的——persistent 会话可只经事件结算不返回值
  send(request: AgentTurnRequest): Promise<void | AgentRuntimeTurnResult>;
  /**
   * WP11：停止当前回合（不销毁会话/进程）。可选能力——目前只有
   * bridge/SARP 常驻 worker 会话实现（turn.cancel 帧）；未实现 = 该
   * runtime 不支持回合级取消，runtime 层按 no-op 处理。
   */
  cancelTurn?(reason: string): Promise<CancelTurnResult>;
  stop(): void | Promise<void>;
}

export interface AgentRuntimeOpenOptions {
  agentName: string;
  mode: AgentRuntimeMode;
  cwd: string;
  systemPromptFile?: string;
  env: Record<string, string>;
  label?: string;
  model?: string;
  /**
   * Phase 1：resolved profile 的 manifest entrypoint ID（bridge runtime 专属；
   * claude 等内置 runtime 恒为 undefined）。driver 按它去本机 manifest 取
   * 启动命令——openSession 只收到稳定 ID，命令/路径不随 profile 流动。
   */
  entrypoint?: string;
  resumeSessionRef?: string;
  onResumeFailed?: (sessionRef: string) => void;
  onEvent: (event: AgentRuntimeEvent) => void;
  onExit?: () => void;
  /**
   * Phase 2：bridge runtime 的 initialize 载荷素材（claude driver 忽略）。
   * platformPrompt 是 runtime-neutral 平台提示文本（区别于 Claude 的
   * systemPromptFile）；mcp 是 slock MCP server 的 stdio 描述——worker
   * 用它自己挂 MCP client，daemon 不再写 .mcp.json。
   */
  agent?: { id: string; name: string; displayName?: string; description?: string };
  platformPrompt?: string;
  mcp?: {
    transport: "stdio";
    command: string;
    args: string[];
    env?: Record<string, string>;
    /** P1.6：manifest 条目的 MCP 工具暴露面收敛（缺省 = 全部工具） */
    allowTools?: string[];
  };
}

export interface AgentRuntimeDriver {
  readonly driverId: string;
  readonly runtimeIds: readonly string[];
  openSession(options: AgentRuntimeOpenOptions): AgentRuntimeSession;
  forgetAgent(agentName: string): void;
}

export class AgentRuntimeRegistry {
  private readonly byRuntime = new Map<string, AgentRuntimeDriver>();

  constructor(drivers: AgentRuntimeDriver[]) {
    for (const driver of drivers) {
      for (const runtimeId of driver.runtimeIds) {
        if (this.byRuntime.has(runtimeId)) {
          throw new Error(`Duplicate runtime driver registration: ${runtimeId}`);
        }
        this.byRuntime.set(runtimeId, driver);
      }
    }
  }

  resolve(runtimeId: string): AgentRuntimeDriver {
    const driver = this.byRuntime.get(runtimeId);
    if (!driver) {
      throw new DispatchError("runtime-unsupported", `Unsupported runtime: ${runtimeId}`);
    }
    return driver;
  }

  forgetAgent(agentName: string): void {
    const seen = new Set<AgentRuntimeDriver>();
    for (const driver of this.byRuntime.values()) {
      if (seen.has(driver)) continue;
      seen.add(driver);
      driver.forgetAgent(agentName);
    }
  }
}
