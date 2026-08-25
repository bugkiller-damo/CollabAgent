import type { Command } from "commander";
import { fail } from "../output.js";
import { getClient } from "./context.js";

export function registerTask(parent: Command) {
  parent
    .command("list")
    .description("List tasks in a channel")
    .requiredOption("--channel <target>", "Channel target")
    .option("--status <s>", "Filter by status")
    .action(async (opts: { channel: string; status?: string }) => {
      const { ctx, client } = getClient();
      const params = new URLSearchParams();
      params.set("channel", opts.channel);
      if (opts.status) params.set("status", opts.status);
      const res = await client.request(
        "GET",
        `/internal/agent/${encodeURIComponent(ctx.agentId)}/tasks?${params.toString()}`,
      );
      if (!res.ok) fail("TASK_LIST_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });

  parent
    .command("create")
    .description("Create one or more tasks in a channel")
    .requiredOption("--channel <target>", "Channel target")
    .argument("[titles...]", "Task titles")
    .action(async (titles: string[], opts: { channel: string }) => {
      if (!titles.length) fail("TASK_NO_TITLES", "At least one task title is required");
      const { ctx, client } = getClient();
      const res = await client.request("POST", `/internal/agent/${encodeURIComponent(ctx.agentId)}/tasks`, {
        channel: opts.channel,
        tasks: titles.map((t) => ({ title: t })),
      });
      if (!res.ok) fail("TASK_CREATE_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });

  parent
    .command("claim")
    .description("Claim tasks by number or message ID")
    .requiredOption("--channel <target>", "Channel target")
    .option("--number <n>", "Task number to claim")
    .option("--message-id <id>", "Message ID to claim")
    .action(async (opts: { channel: string; number?: string; messageId?: string }) => {
      const { ctx, client } = getClient();
      const body: Record<string, unknown> = { channel: opts.channel };
      if (opts.number) body.task_numbers = [Number(opts.number)];
      if (opts.messageId) body.message_ids = [opts.messageId];
      const res = await client.request("POST", `/internal/agent/${encodeURIComponent(ctx.agentId)}/tasks/claim`, body);
      if (!res.ok) fail("TASK_CLAIM_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });

  parent
    .command("unclaim")
    .description("Release a previously claimed task")
    .requiredOption("--channel <target>", "Channel target")
    .requiredOption("--number <n>", "Task number to unclaim")
    .action(async (opts: { channel: string; number: string }) => {
      const { ctx, client } = getClient();
      const res = await client.request("POST", `/internal/agent/${encodeURIComponent(ctx.agentId)}/tasks/unclaim`, {
        channel: opts.channel,
        task_number: Number(opts.number),
      });
      if (!res.ok) fail("TASK_UNCLAIM_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write("Task unclaimed\n");
    });

  parent
    .command("update")
    .description("Update task status")
    .requiredOption("--channel <target>", "Channel target")
    .requiredOption("--number <n>", "Task number")
    .requiredOption("--status <status>", "New status: todo | in_progress | in_review | done")
    .action(async (opts: { channel: string; number: string; status: string }) => {
      const { ctx, client } = getClient();
      const res = await client.request(
        "POST",
        `/internal/agent/${encodeURIComponent(ctx.agentId)}/tasks/update-status`,
        {
          channel: opts.channel,
          number: Number(opts.number),
          status: opts.status,
        },
      );
      if (!res.ok) fail("TASK_UPDATE_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}
