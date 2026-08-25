import type { Command } from "commander";
import { fail } from "../output.js";
import { getClient } from "./context.js";

export function registerAction(parent: Command) {
  parent
    .command("prepare")
    .description("Prepare an action card for a human to commit")
    .requiredOption("--target <ch>", "Target channel")
    .action(async (opts: { target: string }) => {
      const { ctx, client } = getClient();
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const actionJson = Buffer.concat(chunks).toString("utf-8");
      const action = JSON.parse(actionJson);
      const res = await client.request("POST", `/internal/agent/${encodeURIComponent(ctx.agentId)}/prepare-action`, {
        target: opts.target,
        action,
      });
      if (!res.ok) fail("ACTION_PREPARE_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}
