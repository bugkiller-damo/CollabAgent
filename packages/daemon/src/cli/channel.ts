import type { Command } from "commander";
import { fail } from "../output.js";
import { getClient } from "./context.js";

export function registerChannel(parent: Command) {
  parent
    .command("members")
    .description("List agents and humans who are members of a channel, DM, or thread")
    .argument("<target>", "Channel / DM / thread target")
    .action(async (target: string) => {
      const { ctx, client } = getClient();
      const res = await client.request(
        "GET",
        `/internal/agent/${encodeURIComponent(ctx.agentId)}/channel-members?channel=${encodeURIComponent(target)}`,
      );
      if (!res.ok) fail("MEMBERS_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });

  parent
    .command("join")
    .description("Join a visible public channel")
    .requiredOption("--target <target>", "Channel to join")
    .action(async (opts: { target: string }) => {
      const { ctx, client } = getClient();
      const res = await client.request(
        "POST",
        `/internal/agent/${encodeURIComponent(ctx.agentId)}/channels/${encodeURIComponent(opts.target.replace(/^#/, ""))}/join`,
        {},
      );
      if (!res.ok) fail("JOIN_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(`Joined ${opts.target}\n`);
    });

  parent
    .command("leave")
    .description("Leave a regular channel you have joined")
    .requiredOption("--target <target>", "Channel to leave")
    .action(async (opts: { target: string }) => {
      const { ctx, client } = getClient();
      const res = await client.request(
        "POST",
        `/internal/agent/${encodeURIComponent(ctx.agentId)}/channels/${encodeURIComponent(opts.target.replace(/^#/, ""))}/leave`,
        {},
      );
      if (!res.ok) fail("LEAVE_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(`Left ${opts.target}\n`);
    });
}
