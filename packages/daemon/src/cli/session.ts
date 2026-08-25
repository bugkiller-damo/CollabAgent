import type { Command } from "commander";
import { createJsonThreadSessionStore, defaultThreadSessionStorePath } from "../agent-thread-sessions.js";

export function registerSession(parent: Command) {
  parent
    .command("show", { isDefault: true })
    .description("Show local threadId → sessionId map (D2 prompt-isolation store)")
    .option("--agent <name>", "Filter to one agent name")
    .action((opts: { agent?: string }) => {
      const store = createJsonThreadSessionStore(defaultThreadSessionStorePath());
      const rows = store.list(opts.agent ? { agentName: opts.agent } : undefined);
      process.stdout.write(JSON.stringify({ ok: true, store: defaultThreadSessionStorePath(), rows }, null, 2) + "\n");
    });
}
