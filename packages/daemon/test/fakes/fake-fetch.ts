/**
 * 给测试用的假 `fetch`——只需要覆盖 agent-runtime.ts 里 mintAgentCredential/
 * revokeAgentCredential 打的两个请求（POST/DELETE .../credentials），
 * 不需要真的起一个假服务器。
 */
export function installFakeFetch(): { restore(): void; calls: Array<{ url: string; method: string }> } {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; method: string }> = [];

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });

    if (url.includes("/credentials") && method === "POST") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: "sk_agent_test_token", agentId: "test-agent", expiresAt: new Date().toISOString() }),
        text: async () => "",
      } as Response;
    }
    if (url.includes("/credentials") && method === "DELETE") {
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "" } as Response;
    }
    // 其他请求（比如 loadExistingAgents 打的 /api/agents，本测试不涉及）默认成功返回空
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as Response;
  }) as typeof fetch;

  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}
