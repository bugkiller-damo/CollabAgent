import type { Command } from "commander";
import { fail } from "../output.js";
import { getClient } from "./context.js";

export function registerServer(parent: Command) {
  parent
    .command("info")
    .description("List channels, agents, and humans on the current server")
    .action(async () => {
      const { ctx, client } = getClient();
      const res = await client.request("GET", `/internal/agent/${encodeURIComponent(ctx.agentId)}/server`);
      if (!res.ok) fail("INFO_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}
