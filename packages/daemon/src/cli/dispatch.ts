import type { Command } from "commander";
import { fail } from "../output.js";
import { getClient } from "./context.js";

export function registerDispatch(parent: Command) {
  parent
    .command("create")
    .description("Dispatch a task to a worker agent (channel manager only)")
    .requiredOption("--channel <target>", "Channel target")
    .requiredOption("--to <agent>", "Worker agent handle")
    .argument("<text>", "Task text")
    .action(async (text: string, opts: { channel: string; to: string }) => {
      const { ctx, client } = getClient();
      const res = await client.request("POST", `/internal/agent/${encodeURIComponent(ctx.agentId)}/dispatch`, {
        channel: opts.channel,
        toAgent: opts.to,
        text,
      });
      if (!res.ok) fail("DISPATCH_CREATE_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });

  parent
    .command("list")
    .description("List dispatches relevant to this agent in a channel")
    .requiredOption("--channel <target>", "Channel target")
    .option("--status <s>", "Filter by status: open | reported | cancelled")
    .action(async (opts: { channel: string; status?: string }) => {
      const { ctx, client } = getClient();
      const params = new URLSearchParams();
      params.set("channel", opts.channel);
      if (opts.status) params.set("status", opts.status);
      const res = await client.request(
        "GET",
        `/internal/agent/${encodeURIComponent(ctx.agentId)}/dispatches?${params.toString()}`,
      );
      if (!res.ok) fail("DISPATCH_LIST_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });

  parent
    .command("report")
    .description("Report on a dispatch assigned to this agent")
    .requiredOption("--id <dispatchId>", "Dispatch ID")
    .argument("<reportText>", "Report text")
    .action(async (reportText: string, opts: { id: string }) => {
      const { ctx, client } = getClient();
      const res = await client.request(
        "POST",
        `/internal/agent/${encodeURIComponent(ctx.agentId)}/dispatch/${encodeURIComponent(opts.id)}/report`,
        {
          reportText,
        },
      );
      if (!res.ok) fail("DISPATCH_REPORT_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write("Dispatch reported\n");
    });

  parent
    .command("cancel")
    .description("Cancel a dispatch this agent created (channel manager only)")
    .requiredOption("--id <dispatchId>", "Dispatch ID")
    .option("--reason <reason>", "Cancellation reason")
    .action(async (opts: { id: string; reason?: string }) => {
      const { ctx, client } = getClient();
      const res = await client.request(
        "POST",
        `/internal/agent/${encodeURIComponent(ctx.agentId)}/dispatch/${encodeURIComponent(opts.id)}/cancel`,
        {
          reason: opts.reason,
        },
      );
      if (!res.ok) fail("DISPATCH_CANCEL_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write("Dispatch cancelled\n");
    });
}
