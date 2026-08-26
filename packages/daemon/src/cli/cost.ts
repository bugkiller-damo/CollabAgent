import type { Command } from "commander";
import {
  type CostRecordFilter,
  createJsonCostTracker,
  defaultCostStorePath,
  type ICostTracker,
  parseCostBudgetUsd,
} from "../agent-cost-tracker.js";

export type CostShowGroup = "agent" | "channel" | "day";

export interface CostShowOpts {
  days: string;
  agent?: string;
  channel?: string;
  day?: string;
  thread?: string;
  group?: string;
}

const parseGroup = (raw: string | undefined): CostShowGroup => {
  if (raw === "channel" || raw === "day" || raw === "agent") return raw;
  return "agent";
};

/** 抽出便于单测：按 flags 查 tracker，不碰 stdout。 */
export const buildCostShowResult = (
  tracker: ICostTracker,
  opts: CostShowOpts,
  store: string = defaultCostStorePath(),
): Record<string, unknown> => {
  const group = parseGroup(opts.group);
  const filter: CostRecordFilter = {};
  if (opts.agent) filter.agentName = opts.agent;
  if (opts.channel) filter.channel = opts.channel;
  if (opts.thread) filter.threadId = opts.thread;

  const pinnedDay = opts.day?.trim() || undefined;
  const days = pinnedDay ? 1 : Math.max(1, Math.floor(Number(opts.days) || 7));
  if (pinnedDay) filter.day = pinnedDay;

  let rows: unknown[];
  if (group === "channel") rows = tracker.spendByChannel(days, undefined, filter);
  else if (group === "day") rows = tracker.spendByDay(days, undefined, filter);
  else rows = tracker.spendByAgent(days, undefined, filter);

  const out: Record<string, unknown> = {
    ok: true,
    days,
    group,
    budgetUsd: parseCostBudgetUsd(),
    store,
    rows,
  };
  if (opts.agent) out.agent = opts.agent;
  if (opts.channel) out.channel = opts.channel;
  if (pinnedDay) out.day = pinnedDay;
  if (opts.thread) out.thread = opts.thread;
  return out;
};

export function registerCost(parent: Command) {
  parent
    .command("show", { isDefault: true })
    .description("Show local daemon spend totals (UTC days, default last 7)")
    .option("--days <n>", "Lookback days including today (UTC)", "7")
    .option("--agent <name>", "Filter to one agent name")
    .option("--channel <name>", "Filter to one channel (e.g. general or #general)")
    .option("--day <YYYY-MM-DD>", "Restrict to one UTC calendar day")
    .option("--thread <id>", "Filter to one thread id")
    .option("--group <agent|channel|day>", "Aggregate dimension (default agent)", "agent")
    .action((opts: CostShowOpts) => {
      const tracker = createJsonCostTracker(defaultCostStorePath());
      process.stdout.write(JSON.stringify(buildCostShowResult(tracker, opts), null, 2) + "\n");
    });
}
