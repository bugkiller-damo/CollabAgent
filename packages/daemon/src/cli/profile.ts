import type { Command } from "commander";
import { fail } from "../output.js";
import { getClient } from "./context.js";

export function registerProfile(parent: Command) {
  parent
    .command("show")
    .description("Show a profile (omit target for self)")
    .argument("[target]", "Handle like @alice")
    .action(async (target?: string) => {
      const { ctx, client } = getClient();
      const path = target
        ? `/internal/agent/${encodeURIComponent(ctx.agentId)}/profile?target=${encodeURIComponent(target)}`
        : `/internal/agent/${encodeURIComponent(ctx.agentId)}/profile`;
      const res = await client.request("GET", path);
      if (!res.ok) fail("PROFILE_SHOW_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });

  parent
    .command("update")
    .description("Update your own profile")
    .option("--display-name <name>", "New display name")
    .option("--description <text>", "New description")
    .action(async (opts: { displayName?: string; description?: string }) => {
      if (!opts.displayName && !opts.description) fail("PROFILE_NO_CHANGES", "At least one field is required");
      const { ctx, client } = getClient();
      const body: Record<string, string> = {};
      if (opts.displayName) body.displayName = opts.displayName;
      if (opts.description) body.description = opts.description;
      const res = await client.request("POST", `/internal/agent/${encodeURIComponent(ctx.agentId)}/profile`, body);
      if (!res.ok) fail("PROFILE_UPDATE_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}
