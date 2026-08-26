/**
 * P1.10 统一配置层：daemon 进程级 `SLOCK_*` 的读取 / 校验 / 默认值。
 *
 * 评估报告（docs/2026-08-24/01-daemon-evaluation-report.md）P1.10：
 * 环境变量原先散落在 15+ 文件，缺默认值、类型与校验的集中来源。
 *
 * 纪律：
 * - **不在模块顶层冻成常量**。每次 `loadDaemonEnv()` 读一次传入的 env
 *   （默认 `process.env`），测试 `beforeEach` 改 `process.env` 即生效，
 *   不需要 `vi.resetModules()`。
 * - 非法 / 非正数回落到默认值（`Number.isFinite`），避免 `NaN` 静默关掉超时。
 * - 子进程注入键（`SLOCK_AGENT_ID` / `TOKEN` / `SERVER_URL` 等）不在此列：
 *   它们由 spawn 路径显式写入，MCP server / slock CLI 作为独立进程各自读取。
 *
 * 不读的历史别名：`SLOCK_PERSISTENT_CLAUDE=1`（2026-08-18 起与默认 headless
 * 等价，保留兼容但不消费）；`SLOCK_ENV_WHITELIST=1`（P0.4 后与默认同为
 * whitelist，no-op）。
 */

export type AgentEffort = "low" | "medium" | "high";

/** claude `--allowedTools` 默认集合（O12）。`SLOCK_AGENT_ALLOWED_TOOLS` 可覆盖。 */
export const DEFAULT_AGENT_ALLOWED_TOOLS = "Bash,Read,Write,Edit,MultiEdit,Glob,Grep,LS,TodoWrite,mcp__slock";

export const DAEMON_ENV_DEFAULTS = {
  usePty: false,
  oneshotClaude: false,
  dispatchQueue: true,
  replyGuard: true,
  channelProgress: true,
  contextBuilder: true,
  sessionResume: true,
  envInherit: false,
  verbosePty: false,
  logPtyBus: true,
  idleReclaimMs: 1_800_000,
  stuckWarnMs: 90_000,
  quiesceMs: 20_000,
  dispatchInflightMs: 360_000,
  dispatchMaxRetries: 3,
  persistentTurnMs: 300_000,
  resumeGraceMs: 3_000,
  sessionCaptureDelayMs: 5_000,
  contextMaxMessages: 40,
  contextMaxChars: 8_000,
  progressThrottleMs: 2_000,
  costBudgetUsd: null as number | null,
  agentAllowedTools: DEFAULT_AGENT_ALLOWED_TOOLS,
  agentEffort: "medium" as AgentEffort,
} as const;

export type DaemonEnv = {
  /** `SLOCK_USE_PTY=1`：启用冻结的 PTY fallback（默认 headless） */
  usePty: boolean;
  /** `SLOCK_ONESHOT_CLAUDE=1`：headless 退到 claudePrint 一次性模式 */
  oneshotClaude: boolean;
  /** `SLOCK_DISPATCH_QUEUE=0` 关闭 A1 队列，回退旧门控链（P1.16 将删除） */
  dispatchQueue: boolean;
  /** `SLOCK_REPLY_GUARD=0` 关闭「回合结束未发消息则代发」 */
  replyGuard: boolean;
  /** `SLOCK_CHANNEL_PROGRESS=0` 关频道内 ⏳ 进度（顶栏仍在） */
  channelProgress: boolean;
  /** `SLOCK_CONTEXT_BUILDER=0` 关闭线程追问历史注入 */
  contextBuilder: boolean;
  /** `SLOCK_SESSION_RESUME=0` 关闭 PTY `--resume`（捕获仍开） */
  sessionResume: boolean;
  /** `SLOCK_ENV_INHERIT=1`：子进程全量继承 daemon env（排障回退） */
  envInherit: boolean;
  /** `SLOCK_VERBOSE_PTY=1`：把 PTY 字节镜像到 stdout */
  verbosePty: boolean;
  /** `SLOCK_VERBOSE_PTY=0` 关闭 daemon-core 的 PTY bus 就绪日志；默认开 */
  logPtyBus: boolean;
  /** `SLOCK_IDLE_RECLAIM_MS`：空闲回收超时 */
  idleReclaimMs: number;
  /** `SLOCK_STUCK_WARN_MS`：PTY working 过久警告 */
  stuckWarnMs: number;
  /** `SLOCK_QUIESCE_MS`：PTY 静默兜底回合结束窗口 */
  quiesceMs: number;
  /** `SLOCK_DISPATCH_INFLIGHT_MS`：A1 队列 in-flight 截止（默认 6min） */
  dispatchInflightMs: number;
  /** `SLOCK_DISPATCH_MAX_RETRIES`：A1 队列最大尝试次数 */
  dispatchMaxRetries: number;
  /** `SLOCK_PERSISTENT_TURN_MS`：PersistentClaude 沉默超时 */
  persistentTurnMs: number;
  /** `SLOCK_RESUME_GRACE_MS`：PTY resume 快速失败窗口（测试向） */
  resumeGraceMs: number;
  /** `SLOCK_SESSION_CAPTURE_DELAY_MS`：捕获 sessionId 前等待（测试向） */
  sessionCaptureDelayMs: number;
  /** `SLOCK_CONTEXT_MAX_MESSAGES`：D1 线程历史条数上限 */
  contextMaxMessages: number;
  /** `SLOCK_CONTEXT_MAX_CHARS`：D1 线程历史字符上限 */
  contextMaxChars: number;
  /** `SLOCK_PROGRESS_THROTTLE_MS`：频道进度条刷新节流 */
  progressThrottleMs: number;
  /** `SLOCK_COST_BUDGET_USD`：每 agent 每 UTC 日预算；未设 / 非正数 → 不熔断 */
  costBudgetUsd: number | null;
  /** `SLOCK_AGENT_ALLOWED_TOOLS`：覆盖默认 `--allowedTools` */
  agentAllowedTools: string;
  /** `SLOCK_AGENT_EFFORT`：`low` / `medium` / `high`，非法回落 medium */
  agentEffort: AgentEffort;
};

/** 正整数（含「必须 >0」的毫秒/条数）。非法 / ≤0 → fallback。 */
export const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/** 非负整数（0 合法，如节流关到 0）。非法 / <0 → fallback。 */
export const parseNonNegativeInt = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

/** 未设置 / 非正数 → 不熔断（opt-in）。 */
export const parseCostBudgetUsd = (raw: string | undefined = process.env.SLOCK_COST_BUDGET_USD): number | null => {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const parseAgentEffort = (raw: string | undefined): AgentEffort => {
  const v = (raw || DAEMON_ENV_DEFAULTS.agentEffort).toLowerCase();
  return v === "low" || v === "medium" || v === "high" ? v : DAEMON_ENV_DEFAULTS.agentEffort;
};

/**
 * 从 env 解析完整 daemon 配置。调用方可传入伪造 env（测试）；
 * 缺省读 `process.env`。
 */
export const loadDaemonEnv = (env: NodeJS.ProcessEnv = process.env): DaemonEnv => {
  const tools = (env.SLOCK_AGENT_ALLOWED_TOOLS || DEFAULT_AGENT_ALLOWED_TOOLS).trim();
  return {
    usePty: env.SLOCK_USE_PTY === "1",
    oneshotClaude: env.SLOCK_ONESHOT_CLAUDE === "1",
    dispatchQueue: env.SLOCK_DISPATCH_QUEUE !== "0",
    replyGuard: env.SLOCK_REPLY_GUARD !== "0",
    channelProgress: env.SLOCK_CHANNEL_PROGRESS !== "0",
    contextBuilder: env.SLOCK_CONTEXT_BUILDER !== "0",
    sessionResume: env.SLOCK_SESSION_RESUME !== "0",
    envInherit: env.SLOCK_ENV_INHERIT === "1",
    verbosePty: env.SLOCK_VERBOSE_PTY === "1",
    logPtyBus: env.SLOCK_VERBOSE_PTY !== "0",
    idleReclaimMs: parsePositiveInt(env.SLOCK_IDLE_RECLAIM_MS, DAEMON_ENV_DEFAULTS.idleReclaimMs),
    stuckWarnMs: parsePositiveInt(env.SLOCK_STUCK_WARN_MS, DAEMON_ENV_DEFAULTS.stuckWarnMs),
    quiesceMs: parsePositiveInt(env.SLOCK_QUIESCE_MS, DAEMON_ENV_DEFAULTS.quiesceMs),
    dispatchInflightMs: parsePositiveInt(env.SLOCK_DISPATCH_INFLIGHT_MS, DAEMON_ENV_DEFAULTS.dispatchInflightMs),
    dispatchMaxRetries: parsePositiveInt(env.SLOCK_DISPATCH_MAX_RETRIES, DAEMON_ENV_DEFAULTS.dispatchMaxRetries),
    persistentTurnMs: parsePositiveInt(env.SLOCK_PERSISTENT_TURN_MS, DAEMON_ENV_DEFAULTS.persistentTurnMs),
    resumeGraceMs: parsePositiveInt(env.SLOCK_RESUME_GRACE_MS, DAEMON_ENV_DEFAULTS.resumeGraceMs),
    sessionCaptureDelayMs: parsePositiveInt(
      env.SLOCK_SESSION_CAPTURE_DELAY_MS,
      DAEMON_ENV_DEFAULTS.sessionCaptureDelayMs,
    ),
    contextMaxMessages: parsePositiveInt(env.SLOCK_CONTEXT_MAX_MESSAGES, DAEMON_ENV_DEFAULTS.contextMaxMessages),
    contextMaxChars: parsePositiveInt(env.SLOCK_CONTEXT_MAX_CHARS, DAEMON_ENV_DEFAULTS.contextMaxChars),
    progressThrottleMs: parseNonNegativeInt(env.SLOCK_PROGRESS_THROTTLE_MS, DAEMON_ENV_DEFAULTS.progressThrottleMs),
    costBudgetUsd: parseCostBudgetUsd(env.SLOCK_COST_BUDGET_USD),
    agentAllowedTools: tools.length > 0 ? tools : DEFAULT_AGENT_ALLOWED_TOOLS,
    agentEffort: parseAgentEffort(env.SLOCK_AGENT_EFFORT),
  };
};
