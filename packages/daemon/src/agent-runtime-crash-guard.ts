/**
 * Phase 5 §15：worker crash-loop 抑制（熔断器）。
 *
 * 问题：A1 队列的重试语义是「单条消息 attempts 用尽 → 死信」——但队列外的
 * 每条新消息都会重新走一遍 spawn → 崩溃 → 重试 ×3 → 死信。manifest 里一个
 * 坏掉的 entrypoint（缺依赖/坏参数/provider 配额耗尽）会让每条进站消息都
 * 热 spawn 一轮：烧钱、刷日志、MCP/token 文件反复 mint。
 *
 * 本模块做跨消息的 agent 级熔断：
 * - 以 (agentName, profileIdentity) 为键累计连续启动/生命周期失败——
 *   manifest revision 变化会改 identity（§Phase 1），配置修复后熔断自然复位；
 * - 连续失败 ≥ threshold 次 → 熔断开启，冷却期内派发直接 fail-closed
 *   （worker-crash-loop，不可重试 → 立即死信，不烧 spawn）；
 * - 冷却按指数增长封顶 maxCooldownMs；冷却结束后放行一次探测，
 *   再失败重新进入更长的冷却；
 * - 任一回合成功（turn 到达终态）即复位。
 *
 * 只统计「worker 生命周期类」失败——provider 错误（rate limit/auth/network）
 * 说明 worker 正常活着、模型侧坏了，不是 crash loop；永久配置错误
 * （manifest-invalid / entrypoint-* / command-not-found / secret-env-missing
 * / cwd-not-found / protocol-violation / runtime-id-mismatch）虽不可重试，
 * 但每条新消息仍会烧一次 spawn，同样计入熔断。
 */

import type { DispatchErrorCode } from "./errors.js";

/** 计入熔断的失败码：worker 进程生命周期 + 静态配置（每条消息都在烧 spawn） */
const CRASH_CLASS: ReadonlySet<DispatchErrorCode> = new Set([
  "worker-exited",
  "runtime-start-timeout",
  "runtime-silence-timeout",
  "mcp-start-failed",
  "protocol-violation",
  "runtime-id-mismatch",
  "command-not-found",
  "cwd-not-found",
  "secret-env-missing",
  "manifest-invalid",
  "entrypoint-not-found",
]);

export const crashGuardCounts = (code: DispatchErrorCode | undefined): boolean =>
  code !== undefined && CRASH_CLASS.has(code);

export interface CrashGuardDecision {
  blocked: boolean;
  /** 剩余冷却时长（blocked=true 时有值） */
  retryAfterMs?: number;
  consecutiveFailures: number;
}

interface GuardEntry {
  identity: string;
  failures: number;
  /** 熔断截止时刻（ms epoch）；0 = 未熔断 */
  openUntil: number;
  /** 当前冷却档位（每次开启翻倍） */
  cooldownMs: number;
}

export interface CrashGuardOptions {
  /** 连续失败多少次后熔断，默认 3 */
  threshold?: number;
  /** 首次冷却时长，默认 30s */
  baseCooldownMs?: number;
  /** 冷却上限，默认 30min */
  maxCooldownMs?: number;
  now?: () => number;
}

export interface IWorkerCrashGuard {
  /** 投递前检查：熔断期内返回 blocked + 剩余冷却 */
  check(agentName: string, identity: string): CrashGuardDecision;
  /** 派发失败后记账；非熔断类失败码不计 */
  recordFailure(agentName: string, identity: string, code: DispatchErrorCode | undefined): void;
  /** 任一回合到达终态 → 复位（worker 健康） */
  recordSuccess(agentName: string, identity: string): void;
  /** agent 停止/注销时清账 */
  reset(agentName: string): void;
}

export const createWorkerCrashGuard = (opts?: CrashGuardOptions): IWorkerCrashGuard => {
  const threshold = Math.max(1, opts?.threshold ?? 3);
  const baseCooldownMs = Math.max(1000, opts?.baseCooldownMs ?? 30_000);
  const maxCooldownMs = Math.max(baseCooldownMs, opts?.maxCooldownMs ?? 30 * 60_000);
  const now = opts?.now ?? (() => Date.now());
  const entries = new Map<string, GuardEntry>();

  const entryFor = (agentName: string, identity: string): GuardEntry => {
    const cur = entries.get(agentName);
    // identity 变化（runtime/entrypoint/model/manifest revision）= 配置变了，
    // 旧熔断对新配置不成立——复位重数。
    if (!cur || cur.identity !== identity) {
      const fresh: GuardEntry = { identity, failures: 0, openUntil: 0, cooldownMs: baseCooldownMs };
      entries.set(agentName, fresh);
      return fresh;
    }
    return cur;
  };

  return {
    check(agentName, identity) {
      const e = entryFor(agentName, identity);
      const remaining = e.openUntil - now();
      if (e.openUntil > 0 && remaining > 0) {
        return { blocked: true, retryAfterMs: remaining, consecutiveFailures: e.failures };
      }
      return { blocked: false, consecutiveFailures: e.failures };
    },

    recordFailure(agentName, identity, code) {
      if (!crashGuardCounts(code)) return;
      const e = entryFor(agentName, identity);
      e.failures += 1;
      if (e.failures >= threshold && e.openUntil <= now()) {
        e.openUntil = now() + e.cooldownMs;
        console.error(
          `[Daemon] @${agentName} worker crash-loop breaker OPEN after ${e.failures} consecutive failures` +
            ` (code=${code}, cooldown ${Math.round(e.cooldownMs / 1000)}s) — dispatches fail fast until manifest/config changes`,
        );
        e.cooldownMs = Math.min(e.cooldownMs * 2, maxCooldownMs);
      }
    },

    recordSuccess(agentName, identity) {
      const e = entryFor(agentName, identity);
      if (e.failures > 0 || e.openUntil > 0) {
        console.log(`[Daemon] @${agentName} worker crash-loop breaker reset (healthy turn)`);
      }
      e.failures = 0;
      e.openUntil = 0;
      e.cooldownMs = baseCooldownMs;
    },

    reset(agentName) {
      entries.delete(agentName);
    },
  };
};
