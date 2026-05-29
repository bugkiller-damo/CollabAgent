import type { AgentContext } from "./auth.js";
export interface ApiResponse<T = unknown> {
    ok: boolean;
    status: number;
    data: T | null;
    error: string | null;
    errorCode: string | null;
}
export declare class ApiClient {
    private ctx;
    constructor(ctx: AgentContext);
    private usesAgentApiSurface;
    /** Rewrite internal agent paths to the agent-api surface (14 rules). */
    rewriteAgentCredentialPath(pathname: string): string;
    private buildAuthHeaders;
    private parseJsonResponse;
    request<T = unknown>(method: string, pathname: string, body?: unknown): Promise<ApiResponse<T>>;
    requestMultipart<T = unknown>(method: string, pathname: string, form: FormData): Promise<ApiResponse<T>>;
}
//# sourceMappingURL=client.d.ts.map