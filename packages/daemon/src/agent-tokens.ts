import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IAgentTokenRegistry } from "./types/index.js";

/**
 * 创建 Agent Token 注册表。
 *
 * ### 时序保护（竞态）
 *
 * 进程A: spawn ── work ── exit ── exit_cb ── revokeIfMatches(id, tokenA)
 *                                                        │
 * 进程B:          spawn ── issue(tokenB) ── work ───────→│
 *                                                        │
 *                                                 tokenA ≠ tokenB → 不删除
 *                                                 进程B 安全
 *
 * ### 安全规则
 * 1. SLOCK_AGENT_TOKEN 是运行时 token，不是 apiKey
 * 2. 不同 agent 会话的 token 不同
 * 3. 同一 agent 的不同轮次 token 不同（issue 覆盖旧 token）
 * 4. daemon apiKey 永不进入子进程 env
 * 5. token 永不入持久化文件，仅存运行时内存
 */
export const createAgentTokenRegistry = (): IAgentTokenRegistry => {
  const tokens = new Map<string, string>();

  return {
    /** 签发新 token（覆盖 agentId 之前的 token） */
    issue(agentId: string): string {
      const token = randomUUID();
      tokens.set(agentId, token);
      return token;
    },

    /** 查看当前 token（不修改状态） */
    peek(agentId: string): string | undefined {
      return tokens.get(agentId);
    },

    /** 验证 token 是否匹配 stored token */
    validate(agentId: string, token: string | undefined): boolean {
      if (!token) return false;
      const expected = tokens.get(agentId);
      if (!expected) return false;
      try {
        // constant-time 比较防止时序攻击
        const a = Buffer.from(expected);
        const b = Buffer.from(token);
        return a.length === b.length && timingSafeEqual(a, b);
      } catch {
        return false;
      }
    },

    /**
     * 匹配时吊销 — 只有 token 匹配才删除。
     * 防止旧进程退出回调误删新签发 token 的竞态。
     */
    revokeIfMatches(agentId: string, token: string): void {
      if (tokens.get(agentId) === token) {
        tokens.delete(agentId);
      }
    },
  };
};
