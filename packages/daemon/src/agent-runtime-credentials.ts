/**
 * Per-agent-run scoped token（对应服务端 `agent_credentials` 端点，见
 * docs/2026-07-16/09-server-agent-auth-gap-analysis.md §4.2）。
 *
 * 每次 spawn 前用 daemon 自己的账号级 apiKey 换一个只在这个 agentId 范围内
 * 有效的 sk_agent_... token，注入子进程 env；PTY 退出时撤销。取代之前
 * "共享账号级 apiKey"的临时方案。
 */
import { DispatchError, errMessage } from "./errors.js";

export interface ICredentialsClient {
  mintAgentCredential(agentId: string): Promise<string>;
  /** best-effort：撤销失败不影响调用方的退出清理流程（token 反正有 24h TTL 兜底） */
  revokeAgentCredential(agentId: string): Promise<void>;
}

export const createCredentialsClient = (serverUrl: string, apiKey: string): ICredentialsClient => {
  return {
    async mintAgentCredential(agentId: string): Promise<string> {
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/credentials`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) {
        // P1.14：mint 失败多为网络/服务端临时故障，retriable=true 走队列退避重试
        throw new DispatchError(
          "credential-mint-failed",
          `mint credential failed: ${res.status} ${await res.text().catch(() => "")}`,
        );
      }
      const data = (await res.json()) as { token: string };
      return data.token;
    },

    async revokeAgentCredential(agentId: string): Promise<void> {
      try {
        const res = await fetch(`${serverUrl}/internal/agent/${agentId}/credentials`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) console.warn(`[Runtime] revoke credential for agent ${agentId} returned ${res.status}`);
      } catch (err) {
        console.warn(`[Runtime] revoke credential failed for agent ${agentId}:`, errMessage(err));
      }
    },
  };
};
