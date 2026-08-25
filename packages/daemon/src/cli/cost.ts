import type { Command } from "commander";
import { createJsonCostTracker, defaultCostStorePath, parseCostBudgetUsd } from "../agent-cost-tracker.js";

export function registerCost(parent: Command) {
  parent
    .command("show", { isDefault: true })
    .description("Show local daemon spend totals (UTC days, default last 7)")
    .option("--days <n>", "Lookback days including today (UTC)", "7")
    .option("--agent <name>", "Filter to one agent name")
    .action((opts: { days: string; agent?: string }) => {
      const days = Math.max(1, Math.floor(Number(opts.days) || 7));
      const tracker = createJsonCostTracker(defaultCostStorePath());
      let rows = tracker.spendByAgent(days);
      if (opts.agent) rows = rows.filter((r) => r.agentName === opts.agent);
      process.stdout.write(
        JSON.stringify(
          {
            ok: true,
            days,
            budgetUsd: parseCostBudgetUsd(),
            store: defaultCostStorePath(),
            rows,
          },
          null,
          2,
        ) + "\n",
      );
    });
}
