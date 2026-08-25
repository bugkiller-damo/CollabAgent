import type { Command } from "commander";
import { fail } from "../output.js";
import { getClient } from "./context.js";
import { parseDuration } from "./duration.js";

export function registerReminder(parent: Command) {
  parent
    .command("schedule")
    .description("Schedule a reminder")
    .requiredOption("--title <t>", "Reminder title")
    .option("--fire-at <iso>", "Absolute fire time (ISO 8601)")
    .option("--in <duration>", "Relative fire time (e.g. 30m, 2h, 1d)")
    .option("--cadence <rule>", "Recurrence rule (e.g. every:15m, daily@09:00)")
    .option("--channel <ch>", "Anchor channel for the follow-up (e.g. #general)")
    .action(async (opts: { title: string; fireAt?: string; in?: string; cadence?: string; channel?: string }) => {
      const { ctx, client } = getClient();
      const body: Record<string, unknown> = { title: opts.title };
      if (opts.fireAt) body.fireAt = opts.fireAt;
      if (opts.in) body.delaySeconds = parseDuration(opts.in);
      if (opts.cadence) body.repeat = opts.cadence;
      if (opts.channel) body.channel = opts.channel;
      const res = await client.request("POST", `/internal/agent/${encodeURIComponent(ctx.agentId)}/reminders`, body);
      if (!res.ok) fail("REMINDER_SCHEDULE_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });

  parent
    .command("list")
    .description("List your reminders")
    .option("--all", "Include cancelled reminders")
    .action(async (opts: { all?: boolean }) => {
      const { ctx, client } = getClient();
      const path = opts.all
        ? `/internal/agent/${encodeURIComponent(ctx.agentId)}/reminders?status=all`
        : `/internal/agent/${encodeURIComponent(ctx.agentId)}/reminders`;
      const res = await client.request("GET", path);
      if (!res.ok) fail("REMINDER_LIST_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });

  parent
    .command("cancel")
    .description("Cancel a scheduled reminder")
    .requiredOption("--id <id>", "Reminder ID")
    .action(async (opts: { id: string }) => {
      const { ctx, client } = getClient();
      const res = await client.request(
        "DELETE",
        `/internal/agent/${encodeURIComponent(ctx.agentId)}/reminders/${opts.id}`,
      );
      if (!res.ok) fail("REMINDER_CANCEL_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write("Reminder cancelled\n");
    });

  parent
    .command("snooze")
    .description("Snooze a reminder")
    .requiredOption("--id <id>", "Reminder ID")
    .requiredOption("--by <duration>", "Snooze duration (e.g. 30m, 2h)")
    .action(async (opts: { id: string; by: string }) => {
      const { ctx, client } = getClient();
      const res = await client.request(
        "POST",
        `/internal/agent/${encodeURIComponent(ctx.agentId)}/reminders/${opts.id}/snooze`,
        { duration: opts.by },
      );
      if (!res.ok) fail("REMINDER_SNOOZE_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });

  parent
    .command("update")
    .description("Update a scheduled reminder")
    .requiredOption("--id <id>", "Reminder ID")
    .option("--fire-at <iso>", "New fire time")
    .option("--in <duration>", "New relative fire time")
    .option("--cadence <rule>", "New recurrence rule")
    .option("--title <text>", "New title")
    .action(async (opts: { id: string; fireAt?: string; in?: string; cadence?: string; title?: string }) => {
      const { ctx, client } = getClient();
      const body: Record<string, unknown> = {};
      if (opts.fireAt) body.fireAt = opts.fireAt;
      if (opts.in) body.delaySeconds = parseDuration(opts.in);
      if (opts.cadence) body.repeat = opts.cadence;
      if (opts.title) body.title = opts.title;
      const res = await client.request(
        "PATCH",
        `/internal/agent/${encodeURIComponent(ctx.agentId)}/reminders/${opts.id}`,
        body,
      );
      if (!res.ok) fail("REMINDER_UPDATE_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });

  parent
    .command("log")
    .description("Show lifecycle events for a reminder")
    .requiredOption("--id <id>", "Reminder ID")
    .action(async (opts: { id: string }) => {
      const { ctx, client } = getClient();
      const res = await client.request(
        "GET",
        `/internal/agent/${encodeURIComponent(ctx.agentId)}/reminders/${opts.id}/log`,
      );
      if (!res.ok) fail("REMINDER_LOG_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}
