import type { WsToDaemonMessage } from "@collabagent/shared";
import { listWorkspaceFiles, readWorkspaceFile } from "../agent-workspace.js";
import type { HandlerContext } from "./types.js";

type WorkspaceMsg = Extract<WsToDaemonMessage, { type: "workspace:read" }>;

export function handleWorkspaceRead(ctx: HandlerContext, msg: WorkspaceMsg): void {
  const requestId = msg.requestId;
  const agentName = msg.agentName;
  const rel = msg.path ?? "";
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
