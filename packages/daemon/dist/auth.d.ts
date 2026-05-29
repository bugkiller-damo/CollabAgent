export interface AgentContext {
    agentId: string;
    serverUrl: string;
    serverId: string | null;
    token: string;
    clientMode: "managed-runner" | "self-hosted-runner" | "legacy-machine";
    secretSource: "agent-proxy-token-file" | "agent-proxy-token-env" | "agent-credential-file" | "legacy-token-file" | "legacy-token-env";
    activeCapabilities: string[] | null;
}
export declare class AgentBootstrapError extends Error {
    code: string;
    constructor(code: string, message: string);
}
export declare function loadAgentContext(env?: Record<string, string | undefined>): AgentContext;
//# sourceMappingURL=auth.d.ts.map