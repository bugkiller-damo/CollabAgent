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

import type { AgentRuntimeEvent } from "./agent-runtime-events.js";
import { DispatchError } from "./errors.js";

export type AgentRuntimeMode = "persistent" | "oneshot";

export interface AgentRuntimeTurnResult {
  sessionRef?: string;
}

export interface AgentRuntimeSession {
  readonly alive: boolean;
  send(prompt: string): Promise<void | AgentRuntimeTurnResult>;
  stop(): void;
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
