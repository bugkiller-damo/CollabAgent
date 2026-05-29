#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const args = process.argv.slice(2);
let agentId = "";
let serverUrl = "http://localhost:3001";
let authToken = "";
for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agent-id" && args[i + 1])
        agentId = args[++i];
    if (args[i] === "--server-url" && args[i + 1])
        serverUrl = args[++i];
    if (args[i] === "--auth-token" && args[i + 1])
        authToken = args[++i];
}
if (!agentId) {
    console.error("Missing --agent-id");
    process.exit(1);
}
function headers() {
    const h = { "Content-Type": "application/json" };
    if (authToken)
        h["Authorization"] = "Bearer " + authToken;
    h["X-Agent-Id"] = agentId;
    return h;
}
async function apiFetch(path, method, body) {
    const res = await fetch(serverUrl + path, {
        method,
        headers: headers(),
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok)
        return { error: data.error || "HTTP " + res.status };
    return data;
}
const server = new McpServer({ name: "collabagent-chat", version: "1.0.0" });
server.tool("send_message", "Send a message to a channel or DM", {
    target: z.string(),
    content: z.string(),
}, async ({ target, content }) => {
    const data = await apiFetch("/internal/agent/" + agentId + "/send", "POST", { target, content });
    if (data.error)
        return { isError: true, content: [{ type: "text", text: String(data.error) }] };
    return { content: [{ type: "text", text: "Sent. ID: " + data.messageId }] };
});
server.tool("read_messages", "Read message history", {
    channel: z.string(),
    limit: z.number().optional(),
}, async ({ channel, limit }) => {
    const data = await apiFetch("/internal/agent/" + agentId + "/history?channel=" + encodeURIComponent(channel) + "&limit=" + (limit || 50), "GET");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
server.tool("server_info", "Get server info", {}, async () => {
    const data = await apiFetch("/api/server/info", "GET");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
server.tool("task_list", "List tasks in a channel", {
    channel: z.string(),
}, async ({ channel }) => {
    const data = await apiFetch("/internal/agent/" + agentId + "/tasks?channel=" + channel, "GET");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
server.tool("task_update", "Update task status", {
    channel: z.string(),
    number: z.number(),
    status: z.enum(["todo", "in_progress", "in_review", "done"]),
}, async ({ channel, number, status }) => {
    const data = await apiFetch("/internal/agent/" + agentId + "/tasks/update-status", "POST", { channel, number, status });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
const transport = new StdioServerTransport();
await server.connect(transport);
//# sourceMappingURL=chat-bridge.js.map