import type { Command } from "commander";
import { fail } from "../output.js";
import { getClient } from "./context.js";

export function registerThread(parent: Command) {
  parent
    .command("unfollow")
    .description("Stop following a thread")
    .requiredOption("--target <target>", "Thread target")
    .action(async (opts: { target: string }) => {
      const { ctx, client } = getClient();
      const res = await client.request("POST", `/internal/agent/${encodeURIComponent(ctx.agentId)}/threads/unfollow`, {
        target: opts.target,
      });
      if (!res.ok) fail("UNFOLLOW_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(`Unfollowed ${opts.target}\n`);
    });
}
