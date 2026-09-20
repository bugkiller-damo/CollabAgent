import type { ICostTracker } from "./agent-cost-tracker.js";
import { createLazyAgentManager } from "./agent-manager-lazy.js";
import { createObservationBus, type ObservationBus } from "./agent-observation.js";
import { createCredentialsClient } from "./agent-runtime-credentials.js";
import { createDispatch, type ReminderFirePayload } from "./agent-runtime-dispatch.js";
import { AgentRuntimeRegistry, type AgentRuntimeSession } from "./agent-runtime-driver.js";
import { createExitChain } from "./agent-runtime-exit.js";
import { createRuntimeManifestLoader } from "./agent-runtime-manifest.js";
import {
  type AgentRegistrationInfo,
  type ResolvedAgentRuntimeProfile,
  resolveAgentRuntimeProfile,
} from "./agent-runtime-profile.js";
import { createSpawnPtyForAgent } from "./agent-runtime-spawn.js";
import { createAgentStateMachine } from "./agent-runtime-state.js";
import { BUSY_MARKER_RE, createTurnTracker, PROMPT_RE } from "./agent-runtime-turn-tracker.js";
import { createAgentStdinDispatcher } from "./agent-stdin-dispatcher.js";
import { resolveClaudeBinary } from "./command-resolver.js";
import { loadDaemonEnv } from "./config.js";
// Phase 0 组合根：Claude driver 只在此处（provider 组合点）被引入；下游
// dispatch/stream/observation/idle-reclaim 全部只认规范化契约。
import { createClaudeRuntimeDriver } from "./drivers/claude-runtime.js";
import { errMessage } from "./errors.js";
import { createIdleReclaimer, reclaimIdleAgent } from "./idle-reclaimer.js";
import { createPostStartInputWriter, type PostStartInputWriter } from "./post-start-input-writer.js";
import type {
  AgentStatus,
  IAgentManager,
  IAgentRunStore,
  IAgentStdinDispatcher,
  ILiveRunRegistry,
} from "./types/index.js";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// 重新导出，保持既有 import { BUSY_MARKER_RE, PROMPT_RE } from "./agent-runtime.js" 的调用方
// （包括 test/round-end-detection.test.ts）不需要跟着改路径
export { BUSY_MARKER_RE, PROMPT_RE };

// 四态状态机（uninit/idle/starting/working/stopped）已拆到 agent-runtime-state.ts
// 回合结束检测用到的 BUSY_MARKER_RE/PROMPT_RE + pending/busyObserved 状态已拆到
// agent-runtime-turn-tracker.ts

// biome-ignore lint/correctness/noUnusedVariables: frozen PTY leftover (Step 3); do not delete yet
const PTY_COMMAND = "claude"; // TODO: read from command-resolver

// ANSI CSI 序列（ESC [ 参数 结尾字母）匹配——stuck 检测里剥 raw tail 用。
// 不能写 /\x1b…/ 正则字面量：noControlCharactersInRegex 拒绝一切匹配控制字符的
// 正则字面量（\x1b / \u001b / \u{1b} 都会被拦），改为字符串构造 RegExp，
// 编译结果与 /\x1b\[[0-9;?]*[a-zA-Z]/g 完全一致（仅用于 replace，无 lastIndex 状态问题）。
const ESC = "\x1b";
const ANSI_CSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g");

// resolveClaudeBinary（A1.2 迁至 command-resolver.ts）：三处 spawn 共用的
// 跨平台 Claude 可执行文件解析（probe where/which + .cmd shim 解包 + 通用兜底）。

/**
 * Agent 运行时编排器。
 *
 * 负责：
 * - 消息分发（dispatchToAgent / runAgent / runAgentDm / runAgentReminder）
 * - Agent 注册表管理
 * - 常驻会话缓存（PTY 模式单进程常驻 / headless 常驻会话——经 runtime driver
 *   打开，Phase 0 起 provider 中立）
 * - 与 live-run-registry 集成（scoped token 吊销由 server 侧承担，H1）
 *
 * ### 启动路径（B2，2026-08-18 起 headless 为默认）
 * - 默认（headless）：runtime driver 的 persistent 会话（claude-stream driver
 *   → PersistentClaude，stream-json stdin/stdout 结构化通道）；
 *   `SLOCK_ONESHOT_CLAUDE=1` 退到一次性模式（claude → claudePrint）
 * - 降级（`SLOCK_USE_PTY=1`）：node-pty 启动 Claude CLI TUI，等 `❯` 提示符
 *   就绪后键盘模拟写入（真 TUI 调试用，workaround 群见各文件「何时可删（O13）」注释）
 */
export interface AgentRuntimeOptions {
  serverUrl: string;
  apiKey: string;
  /** 门控投递反馈：消息被排队时回调（daemon-core 注入，经 WS 通知前端"已缓冲"） */
  onDeliveryQueued?: (agentName: string, channelName: string) => void;
  /** 死信上报：A1 派发队列重试耗尽/不可投递时回调（daemon-core 注入，经 WS 通知 server） */
  onDeliveryDeadLetter?: (agentName: string, channelName: string, err: unknown) => void;
  /** C1：agent 工具调用生命周期上报（仅 headless 路径，daemon-core 注入，经 WS 进审计流） */
  onToolCall?: (
    agentName: string,
    info: { toolName?: string; toolUseId?: string; status: "pending" | "completed"; text?: string },
  ) => void;
  /** 回复守卫代发（headless）：回合结束但未 send_message 时，daemon 以 agent 身份代发最终正文 */
  onReplyMissing?: (agentName: string, channel: string, content: string) => void;
  /** D3：成本记账（daemon-core 注入；测试可不传，缺省则不落库不熔断） */
  costTracker?: ICostTracker;
  /** D3：预算熔断时往频道发可见消息（零 LLM，走与 reply-guard 相同的 POST send） */
  onCircuitBreak?: (agentName: string, channel: string, content: string) => void;
  /** D2：threadId → sessionId（独立 JSON；测试可不传） */
  threadSessions?: import("./agent-thread-sessions.js").IThreadSessionStore;
  /**
   * A2：agent → sessionId 持久化（daemon-agent-sessions.json）——headless
   * persistent 路径 spawn 的 --resume 数据源。注销 / 显式停 / resume 失败
   * 会 forget；空闲回收与 daemon 关闭保留（下次温启动续接）。测试可不传。
   */
  agentSessionStore?: import("./agent-session-store.js").IAgentSessionStore;
  /** D4：按 agent 绑定进度条发/改/删（测试可不传 = 不写频道进度） */
  createProgressPoster?: (agentName: string) => import("./agent-progress.js").ProgressPoster;
  /** T4：顶栏「正在做什么」（不落库） */
  onProgress?: (agentName: string, channelName: string, headline: string, phase: "start" | "update" | "end") => void;
}

export interface IAgentRuntime {
  // 消息分发
  dispatchToAgent(agentName: string, channelName: string, userMsg: string, threadId?: string): Promise<void>;
  runAgent(
    agentName: string,
    channelName: string,
    replyTarget: string,
    senderName: string,
    content: string,
    threadId?: string,
    messageId?: string,
  ): Promise<void>;
  runAgentDm(agentName: string, replyTarget: string, senderName: string, content: string): Promise<void>;
  runAgentReminder(agentName: string, reminder: ReminderFirePayload): Promise<void>;
  runAgentTriage(
    agentName: string,
    channelName: string,
    replyTarget: string,
    senderName: string,
    content: string,
    threadId?: string,
    messageId?: string,
  ): Promise<void>;
  // 注：原 autostartAgent（崩溃恢复主动拉起 + 注入"安静等待"恢复消息）已于
  // 2026-07-29 移除——那条恢复消息是一整个 agent 回合且 99% 空转（实测 55k 输出），
  // 改为 lazy spawn + session resume（见 daemon-core.autostartCrashedAgents）。

  // 注册表
  registerAgent(id: string, name: string, info: AgentRegistrationInfo): void;
  unregisterAgent(name: string): void;
  loadExistingAgents(): Promise<void>;
  resolveAgentId(agentName: string): string | null;
  /** 反查:agentId(UUID) → 注册名(reminder.fire 等只带 id 的入信用) */
  resolveAgentName(agentId: string): string | null;
  findMentionedAgent(content: string): string | null;
  mentionedAgentNames(content: string): string[];
  /** 全部已注册 agent 的名字列表（G7 状态栏轮询用） */
  listAgentNames(): string[];

  // 生命周期
  /** 停进程/清队列，状态 → idle（保留注册，下次消息可冷启动） */
  stopAgent(agentName: string): void;
  /** daemon 关闭：全部 agent → stopped，dispose 派发队列 */
  stopAll(): void;
  /** 记录该 agent 的首选终端尺寸（面板尺寸协商用）——下次 spawn 直接按此尺寸启动 */
  setPreferredTermSize(agentName: string, size: { cols: number; rows: number }): void;

  // 查询
  getAgentInfo(name: string): AgentRegistrationInfo | undefined;
  hasAgent(name: string): boolean;
  getAgentState(name: string): AgentStatus | undefined;

  // PTY 接入（供外部注入 / 测试用）
  __getAgentManager(): IAgentManager;
  __getDispatcher(): IAgentStdinDispatcher;
  __getRunId(agentName: string): string | null;
  /** B1：headless 观察帧总线（daemon-core 的 terminal:watch 用它渲染 headless 围观画面） */
  __getObservationBus(): ObservationBus;
}

export const createAgentRuntime = (
  options: AgentRuntimeOptions,
  liveRunRegistry: ILiveRunRegistry,
  runStore?: IAgentRunStore,
  /** 仅供测试注入假的 IAgentManager（见 test/fakes/fake-agent-manager.ts）；
   *  生产环境不传，走懒加载的真实 node-pty 实现（首次 PTY spawn 才加载）。 */
  agentManagerOverride?: IAgentManager,
): IAgentRuntime => {
  // ---- 注册表 ----
  const agentDrivers = new Map<string, boolean>();
  const agentSessions = new Map<string, string>();
  const agentNameToId = new Map<string, string>();
  const agentInfo = new Map<string, AgentRegistrationInfo>();
  // Phase 1：agent → 已开会话/续接引用所对应的 runtime profile identity。
  // profile 变化（runtime/entrypoint/model/manifest 修订）即失效旧状态。
  const sessionIdentities = new Map<string, string>();

  // ---- PTY 模式基础设施 ----
  // P0.7：懒加载——headless 默认路径不再静态引入 agent-manager.js（其顶层
  // import node-pty 原生模块）。真实 manager 推迟到第一次 PTY spawn 才加载；
  // headless 全程拿到的是 no-op 包装（无 run 可调，同步方法安全空转）。
  const agentManager: IAgentManager = agentManagerOverride ?? createLazyAgentManager();
  // agentName -> runId 缓存（常驻 PTY）
  const runIdByAgent = new Map<string, string>();
  // agentName -> 首选终端尺寸（面板协商；下次 spawn 应用）
  const preferredTermSize = new Map<string, { cols: number; rows: number }>();
  // runId -> unsubscribe 函数
  const unsubByRunId = new Map<string, () => void>();
  // headless 常驻会话（provider 中立；Phase 0 的 claude driver 返回 PersistentClaude 实例）
  const persistentSessions = new Map<string, AgentRuntimeSession>();
  // A5：agentName → scoped token 签发时间戳（常驻会话临期刷新用，见 dispatch-headless）
  const credentialIssuedAt = new Map<string, number>();

  // ---- B1：结构化观察帧总线（headless 路径的围观数据源，见 agent-observation.ts）----
  const observationBus = createObservationBus();

  // B2（2026-08-18 切换）：headless（PersistentClaude + stream-json）为默认路径，
  // PTY 降级为 fallback（SLOCK_USE_PTY=1，真 TUI 调试/排障用）。
  // 门控与切换依据见 docs/2026-08-18/03-slock-modification-plan.md §2.B2——
  // B1 观察帧 + A1 队列经七轮真机回归后执行本切换。
  // SLOCK_PERSISTENT_CLAUDE=1 是旧开关，效果与默认一致（保留兼容，不再读取）。
  // P1.10：所有 SLOCK_* 经 config.ts；工厂创建时读一次（驱动模式是启动决策）。
  const cfg = loadDaemonEnv();
  const usePty = cfg.usePty;
  if (usePty) {
    // ❄️ LEGACY（2026-08-20 Step 3）：PTY 代码已冻结保留（headless 未过长期验证，
    // 留作回退），启用者必须明确知情。删除评估：2026-09 底，见 tracker Step 3。
    console.warn(
      "[Runtime] ⚠️ SLOCK_USE_PTY=1：PTY legacy fallback 已启用（冻结保留，仅调试/回退用）；" +
        "受支持路径是 headless（默认）。删除评估见 docs/2026-08-20/02 Step 3。",
    );
  }

  // ---- Per-agent-run scoped token（见 agent-runtime-credentials.ts）----
  const credentialsClient = createCredentialsClient(options.serverUrl, options.apiKey);

  // ---- 四态模型（见 agent-runtime-state.ts）----
  const stateMachine = createAgentStateMachine();

  // ---- 回合消息计数 + "是否已经观察到忙碌过"（见 agent-runtime-turn-tracker.ts）----
  const turnTracker = createTurnTracker();
  const { hasPending, hasBeenBusy } = turnTracker;

  // ---- stdin 调度器（为每个 agent 复用同一个 writer，因为 runId 是动态的） ----
  const resolvedClaudePath = resolveClaudeBinary();
  if (resolvedClaudePath !== "claude") {
    console.log(`[Runtime] Resolved claude binary: ${resolvedClaudePath}`);
  }
  const postStartWriter: PostStartInputWriter = createPostStartInputWriter(agentManager, resolvedClaudePath);
  const dispatcher: IAgentStdinDispatcher = createAgentStdinDispatcher(
    agentManager,
    (agentName: string) => runIdByAgent.get(agentName) ?? null,
    postStartWriter,
  );

  const { transitionState, clearStartupTimer } = stateMachine;
  // P0.3：每次显式停进程递增。doDispatch 跨 await 后对照，避免 mint/spawn
  // 完成后把已停 agent 再推进 working。
  const stopGeneration = new Map<string, number>();
  const bumpStopGeneration = (name: string): void => {
    stopGeneration.set(name, (stopGeneration.get(name) ?? 0) + 1);
  };

  // P0.5：createDispatch 返回 forgetSessionCost 前，idleReclaimer / tearDown
  // 已闭包引用它——先占位，createDispatch 之后覆写。
  let forgetSessionCost = (_name: string): void => {};

  // ---- 空闲回收（对应 ADR-005："工作中的 agent 队列空 + 无活动 -> 优雅关闭"）----
  // touch() 在每次回合结束（working -> idle）时调用；untrack() 在开始新一轮 working 或
  // 显式停止时调用，避免正在处理消息的 agent 被计入空闲时间。
  // 默认 60s 对连续聊天太激进——用户隔一两分钟追问一次就会吃到完整冷启动（2026-07-17
  // 实测：78s 被回收，第二个问题重新 spawn）。300s 仍然太短：冷启动 = 全量 bootstrap +
  // 上下文重建（读 MEMORY/查历史/查派发），是 token 消耗大头（2026-07-29 实测：317s 被
  // 回收，下条消息又付一次全量冷启动）。默认放宽到 1800s，可用 SLOCK_IDLE_RECLAIM_MS 调整。
  const idleReclaimer = createIdleReclaimer({
    timeoutMs: cfg.idleReclaimMs,
    onReclaim: (name) =>
      // P0.2：headless 不写 runIdByAgent，只把 PersistentClaude 放在
      // persistentSessions。原先只 stopRun(PTY)，空闲超时后 claude 子进程永不回收。
      // 返回 false（仍 working/starting）时 reclaimer 保留跟踪，下次扫描再试。
      reclaimIdleAgent({
        name,
        runIdByAgent,
        agentManager,
        persistentSessions,
        stateMachine,
        onSessionEnded: (ended) => {
          forgetSessionCost(ended);
          credentialIssuedAt.delete(ended);
        },
      }),
  });
  idleReclaimer.start();

  /** 停掉该 agent 的进程/会话/订阅（不改状态机）。 */
  const tearDownAgentProcess = (name: string): void => {
    const runId = runIdByAgent.get(name);
    if (runId) {
      agentManager.stopRun(runId);
      const unsub = unsubByRunId.get(runId);
      if (unsub) {
        unsub();
        unsubByRunId.delete(runId);
      }
      runIdByAgent.delete(name);
    }
    persistentSessions.get(name)?.stop();
    persistentSessions.delete(name);
    sessionIdentities.delete(name);
    credentialIssuedAt.delete(name);
    forgetSessionCost(name);
    idleReclaimer.untrack(name);
    turnTracker.decPending(name);
    turnTracker.clearBusyObserved(name);
  };

  // ---- 退出清理链（见 agent-runtime-exit.ts）----
  const exitChain = createExitChain({
    runStore,
    liveRunRegistry,
    agentManager,
    idleReclaimer,
    turnTracker,
    stateMachine,
    credentialsClient,
    unsubByRunId,
    runIdByAgent,
  });

  // ---- 内部方法 ----

  const resolveAgentId = (agentName: string): string | null => {
    if (agentNameToId.has(agentName)) return agentNameToId.get(agentName)!;
    if (/^[0-9a-f-]{36}$/i.test(agentName)) return agentName;
    return null;
  };

  // reminder.fire 等链路只带 agentId(UUID)——注册表以 name 为键,反查注册名;
  // 查不到返回 null(调用方按 unknown agent 处理,不 spawn)。
  const resolveAgentName = (agentId: string): string | null => {
    if (agentDrivers.has(agentId)) return agentId; // 已经是 name
    for (const [name, id] of agentNameToId.entries()) {
      if (String(id) === String(agentId)) return name;
    }
    return null;
  };

  const mentionedAgentNames = (content: string): string[] => {
    const found: string[] = [];
    const names = Array.from(agentDrivers.keys()).sort((a, b) => b.length - a.length);
    for (const name of names) {
      if (content.includes("@" + name) && !found.includes(name)) found.push(name);
    }
    return found;
  };

  const findMentionedAgent = (content: string): string | null => {
    return mentionedAgentNames(content)[0] || null;
  };

  // ---- 卡住检测器（诊断用） + 静默兜底回合结束 ----

  /** agentName -> 最近一次 PTY 输出事件的时间（spawn 的输出订阅更新） */
  const lastOutputAtByAgent = new Map<string, number>();

  /**
   * 每 5s 扫描一次 working 状态的 agent：
   * 1) 静默兜底回合结束：有 pending 但 20s 无任何输出且当前屏有提示符 → 判回合结束。
   *    Claude 真在思考时屏幕持续有 spinner 输出，不会静默 20s，所以不会误判；
   *    这专门兜住「安静完成、从没出现过 esc to interrupt 忙碌帧」的回合——
   *    比如 autostart 注入的「安静等待」消息（2026-07-18 实测：busyObserved 永远
   *    false，round-end 按 busy→idle 不变量永不触发，STUCK 到被回收为止）。
   * 2) STUCK 警告：超过阈值还没回到 idle 就打印警告 + output 尾部/当前屏，便于排查。
   */
  const STUCK_WARN_MS = cfg.stuckWarnMs;
  const QUIESCE_MS = cfg.quiesceMs;
  let _stuckDetectorInstalled = false;
  const installStuckDetector = (): void => {
    if (_stuckDetectorInstalled) return;
    _stuckDetectorInstalled = true;
    const lastWarnedAt = new Map<string, number>();
    setInterval(() => {
      const now = Date.now();
      for (const { name: agentName, lastTransitionAt } of stateMachine.getWorkingAgents()) {
        const runId = runIdByAgent.get(agentName);
        const run = runId ? agentManager.getRun(runId) : undefined;

        // 静默兜底（先于 STUCK 警告）
        const lastOut = lastOutputAtByAgent.get(agentName) ?? 0;
        if (
          turnTracker.hasPending(agentName) &&
          run &&
          lastOut > 0 &&
          now - lastOut > QUIESCE_MS &&
          PROMPT_RE.test(run.screenText)
        ) {
          turnTracker.decPending(agentName);
          turnTracker.clearBusyObserved(agentName);
          stateMachine.transitionState(agentName, "idle");
          idleReclaimer.touch(agentName);
          console.log(
            `[Runtime] @${agentName} round-end (quiescence fallback: no output for ${((now - lastOut) / 1000).toFixed(0)}s, ` +
              `busyObserved was ${turnTracker.hasBeenBusy(agentName)})`,
          );
          continue;
        }

        const elapsed = now - lastTransitionAt;
        if (elapsed > STUCK_WARN_MS) {
          // 同一 agent 至少间隔一个阈值周期才再警告一次
          const lastWarn = lastWarnedAt.get(agentName) ?? 0;
          if (now - lastWarn < STUCK_WARN_MS) continue;

          // headless（persistent）路径：PTY output/screen 恒为空，「outputLen=0
          // 的 STUCK 警告」毫无信息量（2026-08-18 真机：133s 的正常多工具回合
          // 被误报）。改用观察帧活动时间判活：stream-json 事件持续到达 = 正常干活；
          // 真正无事件才警告，诊断文本取 transcript 尾部。
          if (!run && persistentSessions.has(agentName)) {
            const frames = observationBus.replay(agentName);
            const lastFrameAt = frames.length > 0 ? frames[frames.length - 1].timestamp : 0;
            if (lastFrameAt > 0 && now - lastFrameAt < STUCK_WARN_MS) continue;
            lastWarnedAt.set(agentName, now);
            const obsTail = observationBus.transcript(agentName, 600).replace(/\s+/g, " ").trim().slice(-300);
            console.warn(
              `[Runtime] @${agentName} STUCK in 'working' (headless: no stream events for ` +
                `${lastFrameAt > 0 ? ((now - lastFrameAt) / 1000).toFixed(0) + "s" : "entire turn"}); transcript tail=...${obsTail}`,
            );
            continue;
          }

          lastWarnedAt.set(agentName, now);

          const tail = (run?.output ?? "").slice(-200).replace(ANSI_CSI_RE, "");
          const screen = (run?.screenText ?? "").replace(/\s+/g, " ").trim().slice(-300);
          console.warn(
            `[Runtime] @${agentName} STUCK in 'working' for ${(elapsed / 1000).toFixed(1)}s ` +
              `(outputLen=${run?.output.length ?? 0}, pending=${hasPending(agentName)}, ` +
              `busyObserved=${hasBeenBusy(agentName)}); raw tail=...${tail} || screen=...${screen}`,
          );
        }
      }
    }, 5000).unref?.();
  };
  installStuckDetector();

  // ---- PTY 启动（见 agent-runtime-spawn.ts）----
  const spawnPtyForAgent = createSpawnPtyForAgent({
    agentManager,
    resolvedClaudePath,
    runStore,
    exitChain,
    stateMachine,
    turnTracker,
    idleReclaimer,
    postStartWriter,
    runIdByAgent,
    unsubByRunId,
    getAgentModel: (name) => agentInfo.get(name)?.model,
    lastOutputAtByAgent,
    getPreferredTermSize: (name) => preferredTermSize.get(name),
  });

  // ---- Phase 0/1：runtime driver registry + profile 解析 ----
  // provider runtimeId → driver 的解析点。重复 runtimeId 在构造时即抛错
  // （启动失败而非运行期）。
  // manifest 用 mtime 缓存：内容一变即重解析，条目 revision 进 identity →
  // 旧会话自然失效（design §Phase 1 验收：manifest 变更不复用旧 Worker）。
  const manifestLoader = createRuntimeManifestLoader();
  const runtimeRegistry = new AgentRuntimeRegistry([createClaudeRuntimeDriver()]);
  const resolveRuntimeProfile = (name: string): ResolvedAgentRuntimeProfile =>
    resolveAgentRuntimeProfile(agentInfo.get(name) ?? {}, manifestLoader());
  /**
   * Phase 1：profile identity 变化 → 旧会话与续接 id 全部作废。
   * registerAgent 重推（PATCH 编辑 runtime/model/entrypoint）与 manifest 修订
   * 都会命中；displayName/description 等不改变 identity 的编辑不打断在跑会话。
   */
  const invalidateOnIdentityChange = (name: string): void => {
    const recorded = sessionIdentities.get(name);
    if (recorded === undefined || recorded === resolveRuntimeProfile(name).identity) return;
    tearDownAgentProcess(name); // 内含 sessionIdentities.delete
    agentSessions.delete(name);
    try {
      options.agentSessionStore?.forget(name);
    } catch {
      /* store 清理是旁路 */
    }
  };

  // ---- 消息分发核心（见 agent-runtime-dispatch.ts）----
  const {
    dispatchToAgent,
    runAgent,
    runAgentDm,
    runAgentReminder,
    runAgentTriage,
    clearAgentQueue,
    disposeQueue,
    forgetSessionCost: forgetSessionCostFromDispatch,
  } = createDispatch({
    options,
    stateMachine,
    turnTracker,
    exitChain,
    idleReclaimer,
    credentialsClient,
    postStartWriter,
    spawnPtyForAgent,
    usePty,
    resolveAgentId,
    agentInfo,
    runIdByAgent,
    runtimeRegistry,
    resolveRuntimeProfile,
    sessionIdentities,
    persistentSessions,
    agentSessions,
    credentialIssuedAt,
    agentSessionStore: options.agentSessionStore,
    onDeliveryQueued: options.onDeliveryQueued,
    onDeliveryDeadLetter: options.onDeliveryDeadLetter,
    observationBus,
    onToolCall: options.onToolCall,
    onReplyMissing: options.onReplyMissing,
    costTracker: options.costTracker,
    onCircuitBreak: options.onCircuitBreak,
    threadSessions: options.threadSessions,
    createProgressPoster: options.createProgressPoster,
    onProgress: options.onProgress,
    getStopGeneration: (name) => stopGeneration.get(name) ?? 0,
    abortAgentProcess: (name) => tearDownAgentProcess(name),
  });
  forgetSessionCost = forgetSessionCostFromDispatch;

  /**
   * P0.3：统一 stop 路径。先 bump 代次 + 切状态（挡住 in-flight 复活），
   * 再清队列与进程。stopAgent 保留注册（→ idle，下次消息可冷启动）；
   * unregister / stopAll 切 stopped（isDeliverable 挡新入队）。
   */
  const haltAgent = (name: string, to: "idle" | "stopped"): void => {
    bumpStopGeneration(name);
    clearStartupTimer(name);
    const current = stateMachine.getState(name);
    if (to === "stopped") {
      transitionState(name, "stopped"); // uninit → stopped 合法；同态 no-op
    } else if (current && current !== "stopped") {
      transitionState(name, "idle");
    }
    clearAgentQueue(name);
    tearDownAgentProcess(name);
  };

  // ---- 公开接口 ----

  const runtimeApi: IAgentRuntime = {
    dispatchToAgent,
    runAgent,
    runAgentDm,
    runAgentReminder,
    runAgentTriage,

    registerAgent(id: string, name: string, info: AgentRegistrationInfo): void {
      // A4：已注册的 agent 收到 agent:start 重推（PATCH 编辑/值班重复开）只做
      // 元数据合并——不 bump 代次（会让在途回合的 assertLive/haltGen 误判
      // stopped 而杀掉正常回合）、不清队列（积压消息不该因编辑丢失）、不杀
      // 进程（改 description 不该打断在跑的会话）。注意：description
      // 变更对本进程不即时生效，下次 spawn（空闲回收/显式 stop 后）自然应用。
      const alreadyRegistered = agentDrivers.has(name);
      agentDrivers.set(name, true);
      if (id) agentNameToId.set(name, id);
      // 合并而非覆盖：编辑 agent（PATCH → agent:start 重推）时某些字段可能缺省，
      // 整体覆盖会把之前已捕获的 model 抹掉（2026-07-17 实测：改成 haiku 后
      // spawn 无 --model，因为重推消息没解出 model，覆盖了启动时捕获的 sonnet）。
      // Phase 1：runtime/entrypoint 同理合并；但当次推送显式带了 profile 字段
      // （runtimeProfileError !== undefined，含 null=无冲突）时 profile 视为
      // 权威整体——避免「改 runtime 不带 entrypoint」残留旧 entrypoint 造成
      // langgraph→claude 切换后 entrypoint-not-allowed 假阳性。
      const prev = agentInfo.get(name);
      const profileAuthoritative = info.runtimeProfileError !== undefined;
      agentInfo.set(name, {
        displayName: info.displayName ?? prev?.displayName,
        description: info.description ?? prev?.description,
        model: info.model ?? prev?.model,
        runtime: profileAuthoritative ? info.runtime : (info.runtime ?? prev?.runtime),
        entrypoint: profileAuthoritative ? info.entrypoint : (info.entrypoint ?? prev?.entrypoint),
        runtimeProfileError: profileAuthoritative ? info.runtimeProfileError : prev?.runtimeProfileError,
      });
      // Phase 1：runtime/entrypoint/model/manifest 修订变化 → 旧会话/续接 id 失效
      invalidateOnIdentityChange(name);
      if (alreadyRegistered) {
        // 元数据路径只兜底状态：stopped/无状态 → idle；working/starting 原样保留
        const cur = stateMachine.getState(name);
        if (!cur || cur === "stopped") transitionState(name, "idle");
        return;
      }
      // 首次注册 / unregister 后重注册：视为一次显式停——bump 代次挡住
      // in-flight spawn 复活旧进程，再清队列/进程，最后落到 idle（值班开）。
      bumpStopGeneration(name);
      clearAgentQueue(name);
      tearDownAgentProcess(name);
      transitionState(name, "idle");
    },

    unregisterAgent(name: string): void {
      agentNameToId.delete(name);
      agentDrivers.delete(name);
      agentInfo.delete(name);
      agentSessions.delete(name);
      // A2：注销（含 duty off / agent:stop）= 显式丢弃——清除续接 id，
      // 下次注册是全新会话。回收 / daemon 关闭不在此列（见 agentSessionStore 注释）。
      try {
        options.agentSessionStore?.forget(name);
      } catch {
        /* store 清理是旁路 */
      }
      haltAgent(name, "stopped");
    },

    async loadExistingAgents(): Promise<void> {
      try {
        // mine=1：只拉本账号名下的 agent。/api/agents 默认返回所属组织里所有人的
        // agent（给人看的列表需要这个视角），daemon 全注册进来会导致 hasAgent()
        // 谎报、真 spawn 时换不到凭证 403（见 agents-public.ts 的 mine 注释）。
        const res = await fetch(options.serverUrl + "/api/agents?mine=1", {
          headers: { Authorization: `Bearer ${options.apiKey}` },
        });
        // 非 2xx 必须显式失败：此前 500 时 data.agents 为 undefined，会静默注册 0 个
        // agent，之后所有 @mention 都被 hasAgent() 挡掉且无任何日志（2026-08-24 实锤）。
        if (!res.ok) throw new Error(`HTTP ${res.status} from /api/agents?mine=1`);
        const data: unknown = await res.json();
        const agents = isRecord(data) && Array.isArray(data.agents) ? data.agents : null;
        if (!agents) throw new Error("unexpected /api/agents response shape");
        const onDutyNames = new Set<string>();
        for (const row of agents) {
          if (!isRecord(row)) continue;
          const name = typeof row.name === "string" ? row.name : "";
          if (!name) continue;
          if (row.duty === "off") continue;
          onDutyNames.add(name);
          if (typeof row.id === "string" && row.id) agentNameToId.set(name, row.id);
          // Phase 1：/api/agents 行内 runtime_profile 已解析（server 侧 jsonb），
          // runtime/entrypoint 一并进 agentInfo，重启后 profile 不失忆。
          const rowProfile = isRecord(row.runtime_profile) ? row.runtime_profile : undefined;
          const rowRuntime =
            typeof row.runtime === "string"
              ? row.runtime
              : typeof rowProfile?.runtime === "string"
                ? rowProfile.runtime
                : undefined;
          const rowEntrypoint =
            typeof row.entrypoint === "string"
              ? row.entrypoint
              : typeof rowProfile?.entrypoint === "string"
                ? rowProfile.entrypoint
                : undefined;
          agentInfo.set(name, {
            displayName: typeof row.display_name === "string" ? row.display_name : undefined,
            description: typeof row.description === "string" ? row.description : undefined,
            model: typeof row.model === "string" ? row.model : undefined,
            ...(rowRuntime ? { runtime: rowRuntime } : {}),
            ...(rowEntrypoint ? { entrypoint: rowEntrypoint } : {}),
          });
          if (!agentDrivers.has(name)) {
            console.log(
              "[Daemon] Registered (lazy): @" + name + " -> " + (typeof row.id === "string" ? row.id : "?").slice(0, 8),
            );
            agentDrivers.set(name, true);
            transitionState(name, "idle");
          }
        }
        for (const name of [...agentDrivers.keys()]) {
          if (!onDutyNames.has(name)) {
            console.log("[Daemon] Dropping off-duty / missing agent @" + name);
            runtimeApi.unregisterAgent(name);
          }
        }
      } catch (err) {
        console.error("[Daemon] Could not load agents:", errMessage(err));
      }
    },

    resolveAgentId,
    findMentionedAgent,
    mentionedAgentNames,
    resolveAgentName,
    listAgentNames: () => Array.from(agentDrivers.keys()),
    setPreferredTermSize: (agentName, size) => {
      preferredTermSize.set(agentName, size);
    },

    stopAgent(agentName: string): void {
      // A2：显式 stop = 用户主动停 = 丢弃会话记忆（下次冷启动全新会话）。
      try {
        options.agentSessionStore?.forget(agentName);
      } catch {
        /* store 清理是旁路 */
      }
      haltAgent(agentName, "idle");
    },

    stopAll(): void {
      idleReclaimer.stop();
      const names = new Set<string>([
        ...agentDrivers.keys(),
        ...stateMachine.listKnown(),
        ...runIdByAgent.keys(),
        ...persistentSessions.keys(),
      ]);
      for (const name of names) haltAgent(name, "stopped");
      disposeQueue();
    },

    getAgentInfo(name: string) {
      return agentInfo.get(name);
    },

    hasAgent(name: string): boolean {
      return agentDrivers.has(name);
    },

    getAgentState(name: string): AgentStatus | undefined {
      return stateMachine.getState(name);
    },

    // ---- 内部接入（供测试 / 外部模块使用） ----

    __getAgentManager() {
      return agentManager;
    },

    __getDispatcher() {
      return dispatcher;
    },

    __getRunId(agentName: string): string | null {
      return runIdByAgent.get(agentName) ?? null;
    },

    __getObservationBus(): ObservationBus {
      return observationBus;
    },
  };
  return runtimeApi;
};
