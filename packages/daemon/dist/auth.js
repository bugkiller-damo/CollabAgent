import fs from "node:fs";
export class AgentBootstrapError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "AgentBootstrapError";
    }
}
function readTokenFromFile(filePath) {
    let raw;
    try {
        raw = fs.readFileSync(filePath, "utf-8");
    }
    catch (err) {
        throw new AgentBootstrapError("TOKEN_FILE_UNREADABLE", `Token file ${filePath} could not be read: ${err.message}`);
    }
    const token = raw.trim();
    if (!token) {
        throw new AgentBootstrapError("TOKEN_FILE_EMPTY", `Token file ${filePath} is empty`);
    }
    return token;
}
export function loadAgentContext(env = process.env) {
    const agentId = env.SLOCK_AGENT_ID;
    const serverUrl = env.SLOCK_SERVER_URL;
    const serverId = env.SLOCK_SERVER_ID ?? null;
    const activeCapabilities = env.SLOCK_AGENT_ACTIVE_CAPABILITIES
        ? env.SLOCK_AGENT_ACTIVE_CAPABILITIES.split(",")
            .map((c) => c.trim())
            .filter(Boolean)
        : null;
    if (!agentId)
        throw new AgentBootstrapError("MISSING_AGENT_ID", "SLOCK_AGENT_ID is required");
    if (!serverUrl)
        throw new AgentBootstrapError("MISSING_SERVER_URL", "SLOCK_SERVER_URL is required");
    // Mode 1: managed-runner (proxy-based auth)
    const agentProxyUrl = env.SLOCK_AGENT_PROXY_URL;
    const agentProxyToken = env.SLOCK_AGENT_PROXY_TOKEN;
    const agentProxyTokenFile = env.SLOCK_AGENT_PROXY_TOKEN_FILE;
    if (agentProxyUrl || agentProxyToken || agentProxyTokenFile) {
        if (!agentProxyUrl) {
            throw new AgentBootstrapError("MISSING_AGENT_PROXY_URL", "SLOCK_AGENT_PROXY_URL is required when agent proxy auth is set");
        }
        if (agentProxyToken && agentProxyTokenFile) {
            throw new AgentBootstrapError("MULTIPLE_AGENT_PROXY_TOKENS", "Set only one of SLOCK_AGENT_PROXY_TOKEN or SLOCK_AGENT_PROXY_TOKEN_FILE");
        }
        const token = agentProxyToken ?? (agentProxyTokenFile ? readTokenFromFile(agentProxyTokenFile) : null);
        if (!token) {
            throw new AgentBootstrapError("MISSING_AGENT_PROXY_TOKEN", "SLOCK_AGENT_PROXY_TOKEN_FILE or SLOCK_AGENT_PROXY_TOKEN is required when SLOCK_AGENT_PROXY_URL is set");
        }
        return {
            agentId,
            serverUrl: agentProxyUrl,
            serverId,
            token,
            clientMode: "managed-runner",
            secretSource: agentProxyTokenFile ? "agent-proxy-token-file" : "agent-proxy-token-env",
            activeCapabilities,
        };
    }
    // Mode 2: self-hosted-runner (agent credential key file)
    const agentCredentialFile = env.SLOCK_AGENT_CREDENTIAL_KEY_FILE;
    if (agentCredentialFile) {
        return {
            agentId,
            serverUrl,
            serverId,
            token: readTokenFromFile(agentCredentialFile),
            clientMode: "self-hosted-runner",
            secretSource: "agent-credential-file",
            activeCapabilities,
        };
    }
    // Mode 3: legacy-machine (token file)
    const tokenFile = env.SLOCK_AGENT_TOKEN_FILE;
    if (tokenFile) {
        return {
            agentId,
            serverUrl,
            serverId,
            token: readTokenFromFile(tokenFile),
            clientMode: "legacy-machine",
            secretSource: "legacy-token-file",
            activeCapabilities,
        };
    }
    // Mode 4: legacy-machine (token literal)
    const tokenLiteral = env.SLOCK_AGENT_TOKEN;
    if (tokenLiteral) {
        return {
            agentId,
            serverUrl,
            serverId,
            token: tokenLiteral,
            clientMode: "legacy-machine",
            secretSource: "legacy-token-env",
            activeCapabilities,
        };
    }
    throw new AgentBootstrapError("MISSING_TOKEN", "No SLOCK_AGENT_PROXY_TOKEN_FILE, SLOCK_AGENT_PROXY_TOKEN, SLOCK_AGENT_CREDENTIAL_KEY_FILE, SLOCK_AGENT_TOKEN_FILE, or SLOCK_AGENT_TOKEN is set");
}
//# sourceMappingURL=auth.js.map