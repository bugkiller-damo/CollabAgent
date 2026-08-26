import { afterEach, describe, expect, it } from "vitest";
import {
  DAEMON_ENV_DEFAULTS,
  DEFAULT_AGENT_ALLOWED_TOOLS,
  loadDaemonEnv,
  parseCostBudgetUsd,
  parseNonNegativeInt,
  parsePositiveInt,
} from "../src/config.js";

const KEYS = [
  "SLOCK_USE_PTY",
  "SLOCK_ONESHOT_CLAUDE",
  "SLOCK_REPLY_GUARD",
  "SLOCK_CHANNEL_PROGRESS",
  "SLOCK_CONTEXT_BUILDER",
  "SLOCK_SESSION_RESUME",
  "SLOCK_ENV_INHERIT",
  "SLOCK_VERBOSE_PTY",
  "SLOCK_IDLE_RECLAIM_MS",
  "SLOCK_STUCK_WARN_MS",
  "SLOCK_QUIESCE_MS",
  "SLOCK_DISPATCH_INFLIGHT_MS",
  "SLOCK_DISPATCH_MAX_RETRIES",
  "SLOCK_PERSISTENT_TURN_MS",
  "SLOCK_RESUME_GRACE_MS",
  "SLOCK_SESSION_CAPTURE_DELAY_MS",
  "SLOCK_CONTEXT_MAX_MESSAGES",
  "SLOCK_CONTEXT_MAX_CHARS",
  "SLOCK_PROGRESS_THROTTLE_MS",
  "SLOCK_COST_BUDGET_USD",
  "SLOCK_AGENT_ALLOWED_TOOLS",
  "SLOCK_AGENT_EFFORT",
] as const;

const snapshot: Record<string, string | undefined> = {};

const capture = (): void => {
  for (const k of KEYS) snapshot[k] = process.env[k];
};

const restore = (): void => {
  for (const k of KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
};

const clearAll = (): void => {
  for (const k of KEYS) delete process.env[k];
};

describe("config / loadDaemonEnv", () => {
  capture();
  afterEach(restore);

  it("empty env yields documented defaults", () => {
    expect(loadDaemonEnv({})).toEqual({ ...DAEMON_ENV_DEFAULTS });
  });

  it('opt-in flags only flip on exact "1"', () => {
    expect(loadDaemonEnv({ SLOCK_USE_PTY: "1" }).usePty).toBe(true);
    expect(loadDaemonEnv({ SLOCK_USE_PTY: "true" }).usePty).toBe(false);
    expect(loadDaemonEnv({ SLOCK_ONESHOT_CLAUDE: "1" }).oneshotClaude).toBe(true);
    expect(loadDaemonEnv({ SLOCK_ENV_INHERIT: "1" }).envInherit).toBe(true);
    expect(loadDaemonEnv({ SLOCK_VERBOSE_PTY: "1" }).verbosePty).toBe(true);
    expect(loadDaemonEnv({ SLOCK_VERBOSE_PTY: "1" }).logPtyBus).toBe(true);
  });

  it('opt-out flags stay on unless exactly "0"', () => {
    expect(loadDaemonEnv({ SLOCK_REPLY_GUARD: "0" }).replyGuard).toBe(false);
    expect(loadDaemonEnv({ SLOCK_CHANNEL_PROGRESS: "0" }).channelProgress).toBe(false);
    expect(loadDaemonEnv({ SLOCK_CONTEXT_BUILDER: "0" }).contextBuilder).toBe(false);
    expect(loadDaemonEnv({ SLOCK_SESSION_RESUME: "0" }).sessionResume).toBe(false);
    expect(loadDaemonEnv({ SLOCK_VERBOSE_PTY: "0" }).logPtyBus).toBe(false);
    expect(loadDaemonEnv({ SLOCK_VERBOSE_PTY: "0" }).verbosePty).toBe(false);
  });

  it("invalid / non-positive numbers fall back (no NaN leak)", () => {
    const env = {
      SLOCK_IDLE_RECLAIM_MS: "nope",
      SLOCK_STUCK_WARN_MS: "0",
      SLOCK_QUIESCE_MS: "-5",
      SLOCK_DISPATCH_INFLIGHT_MS: "",
      SLOCK_DISPATCH_MAX_RETRIES: "NaN",
      SLOCK_PERSISTENT_TURN_MS: "Infinity",
    };
    const cfg = loadDaemonEnv(env);
    expect(cfg.idleReclaimMs).toBe(DAEMON_ENV_DEFAULTS.idleReclaimMs);
    expect(cfg.stuckWarnMs).toBe(DAEMON_ENV_DEFAULTS.stuckWarnMs);
    expect(cfg.quiesceMs).toBe(DAEMON_ENV_DEFAULTS.quiesceMs);
    expect(cfg.dispatchInflightMs).toBe(DAEMON_ENV_DEFAULTS.dispatchInflightMs);
    expect(cfg.dispatchMaxRetries).toBe(DAEMON_ENV_DEFAULTS.dispatchMaxRetries);
    expect(cfg.persistentTurnMs).toBe(DAEMON_ENV_DEFAULTS.persistentTurnMs);
    expect(Number.isFinite(cfg.stuckWarnMs)).toBe(true);
  });

  it("valid numbers are floored positives", () => {
    const cfg = loadDaemonEnv({
      SLOCK_IDLE_RECLAIM_MS: "1500.9",
      SLOCK_CONTEXT_MAX_MESSAGES: "10",
      SLOCK_CONTEXT_MAX_CHARS: "100",
      SLOCK_DISPATCH_MAX_RETRIES: "1",
      SLOCK_PROGRESS_THROTTLE_MS: "0",
    });
    expect(cfg.idleReclaimMs).toBe(1500);
    expect(cfg.contextMaxMessages).toBe(10);
    expect(cfg.contextMaxChars).toBe(100);
    expect(cfg.dispatchMaxRetries).toBe(1);
    expect(cfg.progressThrottleMs).toBe(0);
  });

  it("cost budget is opt-in: unset / non-positive → null", () => {
    expect(loadDaemonEnv({}).costBudgetUsd).toBeNull();
    expect(loadDaemonEnv({ SLOCK_COST_BUDGET_USD: "0" }).costBudgetUsd).toBeNull();
    expect(loadDaemonEnv({ SLOCK_COST_BUDGET_USD: "-1" }).costBudgetUsd).toBeNull();
    expect(loadDaemonEnv({ SLOCK_COST_BUDGET_USD: "1.5" }).costBudgetUsd).toBe(1.5);
    expect(parseCostBudgetUsd(undefined)).toBeNull();
    expect(parseCostBudgetUsd("1.5")).toBe(1.5);
  });

  it("agentEffort accepts low/medium/high and falls back otherwise", () => {
    expect(loadDaemonEnv({ SLOCK_AGENT_EFFORT: "HIGH" }).agentEffort).toBe("high");
    expect(loadDaemonEnv({ SLOCK_AGENT_EFFORT: "low" }).agentEffort).toBe("low");
    expect(loadDaemonEnv({ SLOCK_AGENT_EFFORT: "max" }).agentEffort).toBe("medium");
    expect(loadDaemonEnv({}).agentEffort).toBe("medium");
  });

  it("agentAllowedTools overrides default; blank falls back", () => {
    expect(loadDaemonEnv({}).agentAllowedTools).toBe(DEFAULT_AGENT_ALLOWED_TOOLS);
    expect(loadDaemonEnv({ SLOCK_AGENT_ALLOWED_TOOLS: "Bash,Read" }).agentAllowedTools).toBe("Bash,Read");
    expect(loadDaemonEnv({ SLOCK_AGENT_ALLOWED_TOOLS: "   " }).agentAllowedTools).toBe(DEFAULT_AGENT_ALLOWED_TOOLS);
  });

  it("re-reads process.env on each call (no module-level freeze)", () => {
    clearAll();
    expect(loadDaemonEnv().usePty).toBe(false);
    process.env.SLOCK_USE_PTY = "1";
    expect(loadDaemonEnv().usePty).toBe(true);
    delete process.env.SLOCK_USE_PTY;
    expect(loadDaemonEnv().usePty).toBe(false);
  });
});

describe("parsePositiveInt / parseNonNegativeInt", () => {
  it("parsePositiveInt rejects 0 / NaN / negative", () => {
    expect(parsePositiveInt(undefined, 7)).toBe(7);
    expect(parsePositiveInt("0", 7)).toBe(7);
    expect(parsePositiveInt("x", 7)).toBe(7);
    expect(parsePositiveInt("8.9", 7)).toBe(8);
  });

  it("parseNonNegativeInt accepts 0", () => {
    expect(parseNonNegativeInt("0", 7)).toBe(0);
    expect(parseNonNegativeInt("-1", 7)).toBe(7);
    expect(parseNonNegativeInt("2.2", 7)).toBe(2);
  });
});
