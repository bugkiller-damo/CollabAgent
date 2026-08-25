import type { Command } from "commander";
import { fail } from "../output.js";
import { getClient } from "./context.js";

export function registerIntegration(parent: Command) {
  parent
    .command("list")
    .description("List registered third-party services and active logins")
    .action(async () => {
      const { ctx, client } = getClient();
      const res = await client.request("GET", `/internal/agent/${encodeURIComponent(ctx.agentId)}/integrations`);
      if (!res.ok) fail("INTEGRATION_LIST_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });

  parent
    .command("login")
    .description("Provision or reuse this agent's login for a registered service")
    .requiredOption("--service <id>", "Service ID")
    .option("--scope <scope>", "Requested scope")
    .action(async (opts: { service: string; scope?: string }) => {
      const { ctx, client } = getClient();
      const res = await client.request(
        "POST",
        `/internal/agent/${encodeURIComponent(ctx.agentId)}/integrations/login`,
        {
          service: opts.service,
          scope: opts.scope,
        },
      );
      if (!res.ok) fail("INTEGRATION_LOGIN_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}
