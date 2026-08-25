import type { Command } from "commander";
import { fail } from "../output.js";
import { getClient } from "./context.js";

export function registerAgent(parent: Command) {
  parent
    .command("duty")
    .description("Set agent duty (on = eligible to wake, off = off duty)")
    .argument("<state>", "on | off")
    .argument("[name]", "Agent name (default: current agent context)")
    .action(async (state: string, name?: string) => {
      if (state !== "on" && state !== "off") fail("DUTY_INVALID", "state must be on or off");
      const { ctx, client } = getClient();
      let agentId = ctx.agentId;
      if (name) {
        const listed = await client.request<{ agents?: { id: string; name: string }[] }>("GET", "/api/agents?mine=1");
        if (!listed.ok) fail("DUTY_LIST_FAILED", listed.error ?? `HTTP ${listed.status}`);
        const hit = (listed.data?.agents || []).find((a) => a.name === name.replace(/^@/, ""));
        if (!hit) fail("DUTY_NOT_FOUND", `agent @${name} not found`);
        agentId = hit.id;
      }
      const res = await client.request("POST", `/api/agents/${encodeURIComponent(agentId)}/duty`, { duty: state });
      if (!res.ok) fail("DUTY_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });

  parent
    .command("ls")
    .description("List agents visible to this token (includes DUTY / PRESENCE)")
    .option("--mine", "Only agents owned by this account")
    .action(async (opts: { mine?: boolean }) => {
      const { client } = getClient();
      const q = opts.mine ? "?mine=1" : "";
      const res = await client.request("GET", `/api/agents${q}`);
      if (!res.ok) fail("AGENT_LS_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}
