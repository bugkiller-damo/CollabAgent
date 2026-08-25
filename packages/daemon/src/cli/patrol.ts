import type { Command } from "commander";
import { fail } from "../output.js";
import { getClient } from "./context.js";

export function registerPatrol(parent: Command) {
  parent
    .command("create")
    .description("Create a patrol job (recurring proactive check)")
    .requiredOption("--title <t>", "Short patrol title")
    .requiredOption("--instructions <text>", "What to check / when to report / when to stay silent")
    .option("--every <duration>", "Repeat interval sugar (e.g. 30m, 2h, 1d; min 5m)")
    .option("--cadence <rule>", "Raw recurrence rule (e.g. every:2h, daily@09:00)")
    .option("--channel <ch>", "Report channel (e.g. #security)")
    .option("--max-silent <n>", "Auto-pause after N consecutive silent runs (default 5)")
    .action(
      async (opts: {
        title: string;
        instructions: string;
        every?: string;
        cadence?: string;
        channel?: string;
        maxSilent?: string;
      }) => {
        const { ctx, client } = getClient();
        const repeat = opts.cadence || (opts.every ? `every:${opts.every}` : undefined);
        const body: Record<string, unknown> = {
          title: opts.title,
          instructions: opts.instructions,
          kind: "patrol",
        };
        if (repeat) body.repeat = repeat;
        if (opts.channel) body.channel = opts.channel;
        if (opts.maxSilent) body.maxConsecutiveSilent = Number(opts.maxSilent);
        const res = await client.request("POST", `/internal/agent/${encodeURIComponent(ctx.agentId)}/reminders`, body);
        if (!res.ok) fail("PATROL_CREATE_FAILED", res.error ?? `HTTP ${res.status}`);
        process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
      },
    );

  parent
    .command("list")
    .description("List your patrol jobs")
    .option("--all", "Include cancelled patrols")
    .action(async (opts: { all?: boolean }) => {
      const { ctx, client } = getClient();
      const path =
        `/internal/agent/${encodeURIComponent(ctx.agentId)}/reminders?kind=patrol` + (opts.all ? "&status=all" : "");
      const res = await client.request("GET", path);
      if (!res.ok) fail("PATROL_LIST_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });

  parent
    .command("pause")
    .description("Pause a patrol job (stays in place, not scheduled)")
    .requiredOption("--id <id>", "Patrol ID")
    .action(async (opts: { id: string }) => {
      const { ctx, client } = getClient();
      const res = await client.request(
        "POST",
        `/internal/agent/${encodeURIComponent(ctx.agentId)}/reminders/${opts.id}/pause`,
      );
      if (!res.ok) fail("PATROL_PAUSE_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });

  parent
    .command("resume")
    .description("Resume a paused patrol job (fresh schedule, silent counter reset)")
    .requiredOption("--id <id>", "Patrol ID")
    .action(async (opts: { id: string }) => {
      const { ctx, client } = getClient();
      const res = await client.request(
        "POST",
        `/internal/agent/${encodeURIComponent(ctx.agentId)}/reminders/${opts.id}/resume`,
      );
      if (!res.ok) fail("PATROL_RESUME_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });

  parent
    .command("cancel")
    .description("Cancel a patrol job permanently")
    .requiredOption("--id <id>", "Patrol ID")
    .action(async (opts: { id: string }) => {
      const { ctx, client } = getClient();
      const res = await client.request(
        "DELETE",
        `/internal/agent/${encodeURIComponent(ctx.agentId)}/reminders/${opts.id}`,
      );
      if (!res.ok) fail("PATROL_CANCEL_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write("Patrol cancelled\n");
    });

  parent
    .command("update")
    .description("Update a patrol job")
    .requiredOption("--id <id>", "Patrol ID")
    .option("--title <text>", "New title")
    .option("--instructions <text>", "New instructions")
    .option("--cadence <rule>", "New recurrence rule (validated, min 5m)")
    .option("--max-silent <n>", "New auto-pause threshold")
    .action(
      async (opts: { id: string; title?: string; instructions?: string; cadence?: string; maxSilent?: string }) => {
        const { ctx, client } = getClient();
        const body: Record<string, unknown> = {};
        if (opts.title) body.title = opts.title;
        if (opts.instructions) body.instructions = opts.instructions;
        if (opts.cadence) body.repeat = opts.cadence;
        if (opts.maxSilent) body.maxConsecutiveSilent = Number(opts.maxSilent);
        const res = await client.request(
          "PATCH",
          `/internal/agent/${encodeURIComponent(ctx.agentId)}/reminders/${opts.id}`,
          body,
        );
        if (!res.ok) fail("PATROL_UPDATE_FAILED", res.error ?? `HTTP ${res.status}`);
        process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
      },
    );

  parent
    .command("log")
    .description("Show lifecycle events for a patrol job (fired/outcome/paused/resumed/auto_paused)")
    .requiredOption("--id <id>", "Patrol ID")
    .action(async (opts: { id: string }) => {
      const { ctx, client } = getClient();
      const res = await client.request(
        "GET",
        `/internal/agent/${encodeURIComponent(ctx.agentId)}/reminders/${opts.id}/log`,
      );
      if (!res.ok) fail("PATROL_LOG_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}
