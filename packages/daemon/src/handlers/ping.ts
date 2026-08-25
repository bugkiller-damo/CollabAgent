import type { HandlerContext } from "./types.js";

export function handlePing(ctx: HandlerContext): void {
  ctx.sendWs({ type: "pong" });
}
