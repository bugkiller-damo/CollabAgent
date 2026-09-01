import type { AgentContext } from "./auth.js";
import { buildFetchDispatcher } from "./proxy.js";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
  errorCode: string | null;
}

export class ApiClient {
  constructor(private ctx: AgentContext) {}

  // P1.20：删除 /internal/agent-api 重写面（原 usesAgentApiSurface + rewriteAgentCredentialPath
  // 共 14 条规则）——该 surface 在 server 上从未存在，managed-runner/self-hosted-runner 模式
  // 一旦激活所有 agent REST 请求都会 404（潜伏地雷）；当前 spawn 链路只走 legacy-machine，
  // 重写面从未生效过。clientMode 字段保留（cli auth 自省展示用）。

  private buildAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.ctx.token}`,
      "X-Agent-Id": this.ctx.agentId,
      "X-Slock-Client": "cli",
    };
    if (this.ctx.serverId) headers["X-Server-Id"] = this.ctx.serverId;
    if (this.ctx.activeCapabilities?.length) {
      headers["X-Slock-Agent-Active-Capabilities"] = this.ctx.activeCapabilities.join(",");
    }
    return headers;
  }

  private async parseJsonResponse<T>(res: Response): Promise<ApiResponse<T>> {
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return {
        ok: res.ok,
        status: res.status,
        data: null,
        error: res.ok ? null : `HTTP ${res.status}`,
        errorCode: null,
      };
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      return {
        ok: false,
        status: res.status,
        data: null,
        error: `Invalid JSON response (HTTP ${res.status})`,
        errorCode: "INVALID_JSON_RESPONSE",
      };
    }

    if (res.ok) {
      return { ok: true, status: res.status, data: parsed as T, error: null, errorCode: null };
    }

    const body = isRecord(parsed) ? parsed : {};
    const requiredScope = body.requiredScope;
    if (res.status === 403 && typeof requiredScope === "string" && requiredScope) {
      return {
        ok: false,
        status: 403,
        data: null,
        error: `Permission denied. The human has revoked the \`${requiredScope}\` capability.`,
        errorCode: "SCOPE_DENIED",
      };
    }

    return {
      ok: false,
      status: res.status,
      data: null,
      error: typeof body.error === "string" ? body.error : `HTTP ${res.status}`,
      errorCode: typeof body.errorCode === "string" ? body.errorCode : null,
    };
  }

  async request<T = unknown>(method: string, pathname: string, body?: unknown): Promise<ApiResponse<T>> {
    const url = new URL(pathname, this.ctx.serverUrl).toString();
    const headers = this.buildAuthHeaders();
    // content-type 只在有 body 时带：无 body 的 DELETE/POST 带 JSON content-type
    // 会被 Fastify 拒成 400 "Body cannot be empty"（2026-07-29 实测 reminder cancel）
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const dispatcher = buildFetchDispatcher(url);
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (dispatcher) (init as Record<string, unknown>).dispatcher = dispatcher;

    const res = await fetch(url, init);
    return this.parseJsonResponse<T>(res);
  }

  async requestMultipart<T = unknown>(method: string, pathname: string, form: FormData): Promise<ApiResponse<T>> {
    const url = new URL(pathname, this.ctx.serverUrl).toString();
    const headers = this.buildAuthHeaders();
    // Let fetch set Content-Type with boundary

    const dispatcher = buildFetchDispatcher(url);
    const init: RequestInit = { method, headers, body: form };
    if (dispatcher) (init as Record<string, unknown>).dispatcher = dispatcher;

    const res = await fetch(url, init);
    return this.parseJsonResponse<T>(res);
  }
}
