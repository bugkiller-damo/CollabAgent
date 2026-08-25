import { listWorkspaceFiles, readWorkspaceFile } from "../agent-workspace.js";
import type { HandlerContext } from "./types.js";

export function handleWorkspaceRead(ctx: HandlerContext, msg: Record<string, unknown>): void {
  const requestId = String(msg.requestId || "");
  const agentName = String(msg.agentName || "");
  const rel = typeof msg.path === "string" && msg.path ? msg.path : "";
  if (!requestId || !agentName) return;
  if (rel) {
    const r = readWorkspaceFile(agentName, rel);
    if (r.ok) {
      ctx.sendWs({
        type: "workspace:result",
        requestId,
        agentName,
        exists: true,
        path: r.path,
        content: r.content,
        bytes: r.bytes,
      });
    } else {
      ctx.sendWs({
        type: "workspace:result",
        requestId,
        agentName,
        exists: false,
        path: rel,
        error: r.error,
      });
    }
  } else {
    const listing = listWorkspaceFiles(agentName);
    ctx.sendWs({
      type: "workspace:result",
      requestId,
      agentName,
      exists: listing.exists,
      files: listing.files,
    });
  }
}
