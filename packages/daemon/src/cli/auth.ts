import type { Command } from "commander";
import { loadAgentContext } from "../auth.js";
import { emit } from "../output.js";

export function registerAuth(parent: Command) {
  parent
    .command("whoami")
    .description("Print the agent context resolved from env (token redacted)")
    .action(() => {
      const ctx = loadAgentContext();
      emit({
        ok: true,
        data: {
          agentId: ctx.agentId,
          serverUrl: ctx.serverUrl,
          serverId: ctx.serverId,
          clientMode: ctx.clientMode,
          secretSource: ctx.secretSource,
        },
      });
    });
}
