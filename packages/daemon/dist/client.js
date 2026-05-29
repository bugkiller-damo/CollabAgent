import { buildFetchDispatcher } from "./proxy.js";
export class ApiClient {
    ctx;
    constructor(ctx) {
        this.ctx = ctx;
    }
    usesAgentApiSurface() {
        return this.ctx.clientMode === "managed-runner" || this.ctx.clientMode === "self-hosted-runner";
    }
    /** Rewrite internal agent paths to the agent-api surface (14 rules). */
    rewriteAgentCredentialPath(pathname) {
        if (!this.usesAgentApiSurface())
            return pathname;
        // Attachment download passthrough
        const attachMatch = /^\/api\/attachments\/([^/?]+)(.*)$/.exec(pathname);
        if (attachMatch) {
            return `/internal/agent-api/attachments/${attachMatch[1]}${attachMatch[2] ?? ""}`;
        }
        const agentPrefix = `/internal/agent/${encodeURIComponent(this.ctx.agentId)}`;
        if (!pathname.startsWith(agentPrefix))
            return pathname;
        const suffix = pathname.slice(agentPrefix.length);
        // 14 path rewrite rules
        if (suffix === "/server")
            return "/internal/agent-api/server";
        if (suffix === "/send")
            return "/internal/agent-api/send";
        if (suffix.startsWith("/history"))
            return `/internal/agent-api/history${suffix.slice("/history".length)}`;
        if (suffix.startsWith("/search"))
            return `/internal/agent-api/search${suffix.slice("/search".length)}`;
        if (suffix.startsWith("/channel-members"))
            return `/internal/agent-api/channel-members${suffix.slice("/channel-members".length)}`;
        if (suffix === "/profile" || suffix.startsWith("/profile/"))
            return `/internal/agent-api${suffix}`;
        if (suffix === "/integrations" || suffix.startsWith("/integrations/"))
            return `/internal/agent-api${suffix}`;
        if (suffix === "/upload")
            return "/internal/agent-api/upload";
        if (suffix === "/resolve-channel")
            return "/internal/agent-api/resolve-channel";
        if (suffix === "/threads/unfollow")
            return "/internal/agent-api/threads/unfollow";
        if (suffix === "/prepare-action")
            return "/internal/agent-api/prepare-action";
        if (suffix === "/tasks" || suffix.startsWith("/tasks?") || suffix.startsWith("/tasks/"))
            return `/internal/agent-api${suffix}`;
        if (suffix === "/reminders" || suffix.startsWith("/reminders?") || suffix.startsWith("/reminders/"))
            return `/internal/agent-api${suffix}`;
        if (suffix === "/receive" || suffix.startsWith("/receive?"))
            return "/internal/agent-api/events?since=latest";
        // Reaction: /messages/{id}/reactions
        const reactionMatch = /^\/messages\/([^/]+)\/reactions$/.exec(suffix);
        if (reactionMatch)
            return `/internal/agent-api/messages/${reactionMatch[1]}/reactions`;
        // Channel membership: /channels/{name}/(join|leave)
        const chMatch = /^\/channels\/([^/]+)\/(join|leave)$/.exec(suffix);
        if (chMatch)
            return `/internal/agent-api/channels/${chMatch[1]}/${chMatch[2]}`;
        return pathname;
    }
    buildAuthHeaders() {
        const headers = {
            "Authorization": `Bearer ${this.ctx.token}`,
            "X-Agent-Id": this.ctx.agentId,
            "X-Slock-Client": "cli",
        };
        if (this.ctx.serverId)
            headers["X-Server-Id"] = this.ctx.serverId;
        if (this.ctx.activeCapabilities?.length) {
            headers["X-Slock-Agent-Active-Capabilities"] = this.ctx.activeCapabilities.join(",");
        }
        return headers;
    }
    async parseJsonResponse(res) {
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
        let parsed;
        try {
            parsed = await res.json();
        }
        catch {
            return {
                ok: false,
                status: res.status,
                data: null,
                error: `Invalid JSON response (HTTP ${res.status})`,
                errorCode: "INVALID_JSON_RESPONSE",
            };
        }
        if (res.ok) {
            return { ok: true, status: res.status, data: parsed, error: null, errorCode: null };
        }
        const body = parsed;
        if (res.status === 403 && body?.requiredScope) {
            return {
                ok: false,
                status: 403,
                data: null,
                error: `Permission denied. The human has revoked the \`${body.requiredScope}\` capability.`,
                errorCode: "SCOPE_DENIED",
            };
        }
        return {
            ok: false,
            status: res.status,
            data: null,
            error: body?.error ?? `HTTP ${res.status}`,
            errorCode: body?.errorCode ?? null,
        };
    }
    async request(method, pathname, body) {
        pathname = this.rewriteAgentCredentialPath(pathname);
        const url = new URL(pathname, this.ctx.serverUrl).toString();
        const headers = this.buildAuthHeaders();
        headers["Content-Type"] = "application/json";
        const dispatcher = buildFetchDispatcher(url);
        const init = { method, headers };
        if (body !== undefined)
            init.body = JSON.stringify(body);
        if (dispatcher)
            init.dispatcher = dispatcher;
        const res = await fetch(url, init);
        return this.parseJsonResponse(res);
    }
    async requestMultipart(method, pathname, form) {
        pathname = this.rewriteAgentCredentialPath(pathname);
        const url = new URL(pathname, this.ctx.serverUrl).toString();
        const headers = this.buildAuthHeaders();
        // Let fetch set Content-Type with boundary
        const dispatcher = buildFetchDispatcher(url);
        const init = { method, headers, body: form };
        if (dispatcher)
            init.dispatcher = dispatcher;
        const res = await fetch(url, init);
        return this.parseJsonResponse(res);
    }
}
//# sourceMappingURL=client.js.map