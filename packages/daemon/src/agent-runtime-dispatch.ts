import { buildThreadContextEnvelope } from "./agent-context-builder.js";
import {
  type CostGateDecision,
  createSessionCostDelta,
  evaluateCostGate,
  type ICostTracker,
} from "./agent-cost-tracker.js";
import { createAgentDispatchQueue } from "./agent-dispatch-queue.js";
import { createSeqAllocator, type ObservationBus } from "./agent-observation.js";
import type { ProgressTurn } from "./agent-progress.js";
import type { AgentRuntimeOptions } from "./agent-runtime.js";
import type { ICredentialsClient } from "./agent-runtime-credentials.js";
import { dispatchHeadlessTurn } from "./agent-runtime-dispatch-headless.js";
import { dispatchPtyTurn } from "./agent-runtime-dispatch-pty.js";
import { createStreamTurnHandler, type TurnGuard } from "./agent-runtime-dispatch-stream.js";
import type { IExitChain } from "./agent-runtime-exit.js";
import type { SpawnPtyForAgent } from "./agent-runtime-spawn.js";
import type { IAgentStateMachine } from "./agent-runtime-state.js";
import type { ITurnTracker } from "./agent-runtime-turn-tracker.js";
import type { IThreadSessionStore } from "./agent-thread-sessions.js";
import { loadDaemonEnv } from "./config.js";
import type { PersistentClaude } from "./drivers/persistent-claude.js";
import type { IIdleReclaimer } from "./idle-reclaimer.js";
import type { PostStartInputWriter } from "./post-start-input-writer.js";

/** reminder.fire 负载（T2：kind='patrol' 时带 instructions 走巡检 prompt 模板） */
export interface ReminderFirePayload {
  title?: string;
  channel?: string;
  kind?: string;
  instructions?: string;
}

/**
 * T2 巡检 prompt 模板（纯函数，便于单测）。
 * 设计:docs/2026-08-19/02-t2-agent-patrol-design.md §T2.3：
 * 任务指令 + 产出约定 + 沉默协议（沉默是正常产出，防止 cron 每次触发都刷屏）；
 * 明示「不要自我续期」——调度由系统负责，防循环放大（D4 prompt 侧保险）。
 */
export function buildPatrolPrompt(reminder: ReminderFirePayload): string {
  const reportWhere = reminder.channel
    ? `用 \`send_message\` 工具发到 ${reminder.channel}（target 严格用该值），没有该工具时退回` +
      ` \`echo "内容" | slock message send --target "${reminder.channel}"\``
    : `按你 MEMORY.md 里的约定选择频道，用 \`send_message\` 工具发出`;
  return [
    `【定时巡检】${reminder.title || "(未命名任务)"}`,
    ``,
    `任务指令：${reminder.instructions || reminder.title || "(无指令)"}`,
    ``,
    `产出约定：`,
    `- 有值得报告的发现 → ${reportWhere}。`,
    `- 没有值得报告的发现 → 直接结束回合，不发任何消息（沉默是正常产出）。`,
    `- 也不要发「无事可报」「已保持沉默」之类的确认消息——零输出就是沉默。`,
    `- 之前轮次已经报告过的内容不要重复报告。`,
    `- 不要为延续本任务给自己创建新提醒；调度由系统负责。`,
  ].join("\n");
}

/**
 * T8 分诊 prompt 模板（纯函数，便于单测）。
 * 设计:docs/2026-08-19/03-t8-manager-triage-design.md §T8.4：
 * 自己回 / dispatch_task 派单 / 沉默三选一；沉默是正常产出（与 T2 共享模式）。
 */
export function buildTriagePrompt(input: {
  channelName: string;
  replyTarget: string;
  senderName: string;
  content: string;
}): string {
  return [
    `【频道分诊】#${input.channelName} 来了一条新消息，没有人 @ 任何 agent。`,
    `来自 @${input.senderName}：${input.content}`,
    ``,
    `你是本频道的经理 agent，请判断：`,
    `- 该你处理 → 用 \`send_message\`（target="${input.replyTarget}"）直接回复`,
    `- 该别的 agent 处理 → 用 \`dispatch_task\` 派给合适的成员 agent（对方会自动收到通知开工）`,
    `- 无需 agent 介入（人类闲聊/纯围观/与职责无关）→ 直接结束回合，不发任何消息`,
    `拿不准先读上下文再定。沉默是正常产出，不要因为"来了消息"就硬回复。`,
  ].join("\n");
}

/** T8：triageAgents 里挑本机托管的经理；没有则不分诊（多 daemon 拓扑下由托管方接）。 */
export function pickLocalTriageAgent(triageAgents: unknown, hasAgent: (name: string) => boolean): string | undefined {
  if (!Array.isArray(triageAgents)) return undefined;
  return triageAgents.find((n): n is string => typeof n === "string" && hasAgent(n));
}

export interface IDispatch {
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
  /** P0.3：丢弃某 agent 的 pending（stop/unregister）；返回丢弃条数 */
  clearAgentQueue(agentName: string): number;
  /** P0.3：daemon 关闭时清掉全部队列与退避定时器 */
  disposeQueue(): void;
  /** P0.5：常驻进程被停/回收后清会话累计基线，避免新进程少记成本 */
  forgetSessionCost(agentName: string): void;
}

export interface DispatchDeps {
  options: AgentRuntimeOptions;
  stateMachine: IAgentStateMachine;
  turnTracker: ITurnTracker;
  exitChain: IExitChain;
  idleReclaimer: IIdleReclaimer;
  credentialsClient: ICredentialsClient;
  postStartWriter: PostStartInputWriter;
  spawnPtyForAgent: SpawnPtyForAgent;
  usePty: boolean;
  resolveAgentId(agentName: string): string | null;
  /** P0.3：stop/unregister/stopAll 递增；doDispatch 跨 await 后对照，防止复活已停 agent */
  getStopGeneration?(agentName: string): number;
  /** P0.3：spawn 完成后才发现已被 stop 时，拆掉刚拉起的进程 */
  abortAgentProcess?(agentName: string): void;
  /** agentName -> displayName/description（PTY 环境准备用） */
  agentInfo: Map<string, { displayName?: string; description?: string }>;
  /** agentName -> runId 缓存（常驻 PTY） */
  runIdByAgent: Map<string, string>;
  /** 旧 PersistentClaude 路径（兜底）常驻会话 */
  persistentSessions: Map<string, PersistentClaude>;
  /** claudePrint 一次性模式的 session 缓存 */
  agentSessions: Map<string, string>;
  /** 按 agentName 串行化 dispatch（门控投递队列的链尾） */
  dispatchPromises: Map<string, Promise<void>>;
  /**
   * 门控投递反馈：消息因 agent 忙碌被排队时回调一次（daemon-core 经 WS 上报
   * server → 浏览器 toast"已缓冲，空闲后投递"）。可选，测试注入时可以不传。
   */
  onDeliveryQueued?: (agentName: string, channelName: string) => void;
  /**
   * 死信上报（A1 派发队列）：消息重试耗尽或入队即判不可投递（agent stopped/无 id）
   * 时回调。daemon-core 经 WS 上报 server，由 server 决定如何呈现——不再静默丢消息。
   * 旧门控链模式（SLOCK_DISPATCH_QUEUE=0）下不会触发。
   */
  onDeliveryDeadLetter?: (agentName: string, channelName: string, err: unknown) => void;
  /** B1：headless 观察帧总线（agent-runtime 创建，persistent 路径发布帧） */
  observationBus?: ObservationBus;
  /**
   * C1：agent 工具调用生命周期上报（stream-json tool_use/tool_result 事件源）。
   * daemon-core 经 WS 上报 server 审计流。仅 headless 路径有结构化事件源，
   * PTY 路径不会触发（已知窗口，见 03 方案 §3.C1）。
   */
  onToolCall?: (
    agentName: string,
    info: { toolName?: string; toolUseId?: string; status: "pending" | "completed"; text?: string },
  ) => void;
  /**
   * 回复守卫代发（headless）：回合结束但 agent 没调 send_message 时，由 daemon
   * 以 agent 身份把最终正文发到频道（daemon-core 实现：mint scoped token + POST
   * /internal/agent/:id/send）。比追问省一整轮 LLM 且确定性送达。
   */
  onReplyMissing?: (agentName: string, channel: string, content: string) => void;
  /** D3：成本落库（缺省则只观察不记账） */
  costTracker?: ICostTracker;
  /** D3：超预算时往频道发熔断消息 */
  onCircuitBreak?: (agentName: string, channel: string, content: string) => void;
  /** D2：threadId → sessionId（独立 JSON；测试可不传） */
  threadSessions?: IThreadSessionStore;
  /** D4：按 agent 绑定进度条发/改/删 */
  createProgressPoster?: (agentName: string) => import("./agent-progress.js").ProgressPoster;
  /** T4：顶栏 headline（不落库） */
  onProgress?: (agentName: string, channelName: string, headline: string, phase: "start" | "update" | "end") => void;
}

/**
 * 消息分发核心（对应 Hive `team-operations.ts` 的角色）。
 * 见 doc `docs/2026-07-16/14-agent-runtime-split-plan.md` Step 6。
 */
export const createDispatch = (deps: DispatchDeps): IDispatch => {
  const {
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
    persistentSessions,
    agentSessions,
    dispatchPromises,
  } = deps;
  const { transitionState, clearStartupTimer } = stateMachine;
  // P0.5：result.total_cost_usd 是会话累计；按 agent 记上次值，落库只写差值。
  const sessionCostDelta = createSessionCostDelta();
  // P0.3：stopAll/unregister 会先切到 stopped。in-flight 的 spawn 失败 / 超时 /
  // send reject / 成功进入 working 都不能再改状态，否则「已停止」被复活。
  const isStopped = (agentName: string): boolean => stateMachine.getState(agentName) === "stopped";
  const releaseToIdle = (agentName: string): void => {
    clearStartupTimer(agentName);
    if (isStopped(agentName)) return;
    transitionState(agentName, "idle");
  };
  const enterWorking = (agentName: string, expectedGen?: number): boolean => {
    if (isStopped(agentName)) {
      clearStartupTimer(agentName);
      deps.abortAgentProcess?.(agentName);
      return false;
    }
    if (expectedGen !== undefined && (deps.getStopGeneration?.(agentName) ?? 0) !== expectedGen) {
      clearStartupTimer(agentName);
      deps.abortAgentProcess?.(agentName);
      return false;
    }
    clearStartupTimer(agentName);
    transitionState(agentName, "working");
    return true;
  };
  const { mintAgentCredential } = credentialsClient;
  // B1：观察帧序号分配器（保证帧全局单调，便于排序/去重）
  const obsSeq = createSeqAllocator();
  /** D3：每个 agent 每个 UTC 日最多往频道发一条熔断消息，避免 @ 刷屏 */
  const circuitNotified = new Set<string>();
  /** D3/P0.6：熔断通知收口——入队门、drain 门、doDispatch 门共用一套去重与旁路 */
  const notifyCircuitBreak = (agentName: string, channelName: string, gate: CostGateDecision): void => {
    const key = `${agentName}\0${gate.day}`;
    if (circuitNotified.has(key) || !gate.message) return;
    circuitNotified.add(key);
    console.warn(`[Daemon] @${agentName} cost circuit-break — refusing dispatch (${gate.message})`);
    try {
      (deps.onCircuitBreak ?? deps.onReplyMissing)?.(agentName, channelName, gate.message);
    } catch {
      /* 熔断旁路不阻塞主链路 */
    }
  };

  // ---- 回复守卫（reply guard，headless 路径）----
  // 弱模型实证问题（2026-08-18 真机三次）：回合查到了答案但全程没调
  // send_message，最后纯文本输出答案甚至幻觉「已发送 ✅」——频道永远收不到。
  // headless 下观察帧能看到全部 tool_use，回合结束（result 事件）时检查本回合
  // 是否有发送动作，没有就自动追问一次补发。isNudge 防止追问本身再触发追问
  // （追问也没发 = 模型真的没救，不无限循环）。
  // SLOCK_REPLY_GUARD=0 可关闭（默认开启）。
  // 实现见 agent-runtime-dispatch-stream.ts（P1.9 抽出）。
  const turnGuards = new Map<string, TurnGuard>();
  const progressTurns = new Map<string, ProgressTurn>();
  // dispatchToAgent 在下方定义；stream handler 通过 nudge 晚绑定，避免循环引用。
  let dispatchToAgentRef: (
    agentName: string,
    channelName: string,
    userMsg: string,
    threadId?: string,
  ) => Promise<void> = async () => {};
  const handleStreamEvent = createStreamTurnHandler({
    observationBus: deps.observationBus,
    onToolCall: deps.onToolCall,
    onReplyMissing: deps.onReplyMissing,
    onProgress: deps.onProgress,
    costTracker: deps.costTracker,
    threadSessions: deps.threadSessions,
    sessionCostDelta,
    obsSeq,
    turnGuards,
    progressTurns,
    stateMachine,
    idleReclaimer,
    resolveAgentId,
    nudge: (agentName, channel, msg) => {
      void dispatchToAgentRef(agentName, channel, msg).catch(() => {});
    },
  });

  const doDispatch = async (
    agentName: string,
    channelName: string,
    userMsg: string,
    threadId?: string,
  ): Promise<void> => {
    // P0.6：执行前成本门。队列模式 drain 已拦过一次，这里是兜底——覆盖
    // SLOCK_DISPATCH_QUEUE=0 旧链路径与「drain 检查后才耗尽预算」的竞态窗口。
    // 熔断是有意丢弃（已通知频道），不是投递错误，所以 return 而非 throw。
    const costGate = evaluateCostGate(deps.costTracker, agentName);
    if (costGate.blocked) {
      notifyCircuitBreak(agentName, channelName, costGate);
      return;
    }

    const agentId = resolveAgentId(agentName);
    if (!agentId) {
      // A1：抛错而非静默 return——队列模式靠 reject 触发死信；旧链模式由
      // 链上 .catch(() => {}) 吞掉，行为与旧实现等价
      throw new Error(`[Daemon] No agent id for @${agentName}, skip dispatch`);
    }

    if (isStopped(agentName)) {
      throw new Error(`[Daemon] @${agentName} is stopped, cannot dispatch`);
    }
    const haltGen = deps.getStopGeneration?.(agentName) ?? 0;
    const assertLive = (): void => {
      if (isStopped(agentName) || (deps.getStopGeneration?.(agentName) ?? 0) !== haltGen) {
        throw new Error(`[Daemon] @${agentName} is stopped, cannot dispatch`);
      }
    };

    if (usePty) {
      // ---- PTY 模式 ----
      // ❄️ LEGACY / FROZEN（2026-08-20 Step 3）：本分支整体冻结保留，仅
      // SLOCK_USE_PTY=1 时进入。实现已原样迁到 agent-runtime-dispatch-pty.ts。
      await dispatchPtyTurn({
        agentName,
        agentId,
        channelName,
        userMsg,
        haltGen,
        serverUrl: options.serverUrl,
        apiKey: options.apiKey,
        stateMachine,
        turnTracker,
        exitChain,
        idleReclaimer,
        mintAgentCredential,
        postStartWriter,
        spawnPtyForAgent,
        agentInfo,
        runIdByAgent,
        enterWorking,
        releaseToIdle,
        assertLive,
      });
      return;
    }

    await dispatchHeadlessTurn({
      agentName,
      agentId,
      channelName,
      userMsg,
      threadId,
      haltGen,
      serverUrl: options.serverUrl,
      stateMachine,
      idleReclaimer,
      mintAgentCredential,
      agentInfo,
      persistentSessions,
      agentSessions,
      threadSessions: deps.threadSessions,
      turnGuards,
      progressTurns,
      handleStreamEvent,
      createProgressPoster: deps.createProgressPoster,
      onProgress: deps.onProgress,
      enterWorking,
      releaseToIdle,
      assertLive,
    });
  };

  // 防失忆 reminder tail（仿照 hive `hive-team-guidance.ts` 验证过的模式）：
  // 每条流向 agent 的消息尾部附一段精简 XML 提醒。静态系统提示只在新 spawn 的
  // bootstrap 里出现一次，长会话中 Claude Code 的 /compact/auto-summarize 会把它
  // 压掉——agent 一旦忘记"必须用 send_message 回复、直接打字不会发出"，表现就是
  // "思考了但没消息发出来"。reminder 挂在尾部（recency 位置）对抗压缩，且在
  // dispatchToAgent 收口处统一追加，覆盖首次 spawn 和 PTY 复用两条写入路径。
  const REMINDER_TAIL = (agentName: string): string =>
    `\n\n<slock-reminder>你是 @${agentName}（CollabAgent 平台的 AI Agent）。对外回复只能用 \`send_message\` 工具（或 \`slock\` CLI），直接打字不会被发送；回合开始先读工作区里的 MEMORY.md。</slock-reminder>`;

  // A1 派发队列（默认）：doDispatch 作为投递执行器，重试/死信/dedup/合并由
  // 队列负责。isDeliverable 把「agent stopped / 无 agentId」这类永久失败挡在
  // 入队时直接死信，不浪费重试。SLOCK_DISPATCH_QUEUE=0 回退旧门控链。
  const envCfg = loadDaemonEnv();
  const useDispatchQueue = envCfg.dispatchQueue;
  const dispatchQueue = useDispatchQueue
    ? createAgentDispatchQueue({
        // in-flight 截止放宽到 6 分钟：persistent 路径的 deliver 是回合级的
        // （2026-08-18 起 await 到 result 事件），正常回合轻松超过默认 60s。
        // 真正的看门狗是 PersistentClaude 的不活跃超时（300s 沉默必杀 → reject），
        // 这里的截止只是「deliver Promise 泄漏」的兜底，不参与卡死检测。
        inflightMs: envCfg.dispatchInflightMs,
        maxRetries: envCfg.dispatchMaxRetries,
        deliver: async (agentName, items) => {
          // 合并重提示：多条积压拼成一条复合 prompt，reminder tail 只追加一次
          const merged = items.map((i) => i.content).join("\n\n");
          if (items.length > 1) {
            console.log(`[Daemon] @${agentName} merged ${items.length} queued messages into one dispatch`);
          }
          await doDispatch(agentName, items[0].channelName, merged + REMINDER_TAIL(agentName), items[0].threadId);
        },
        isDeliverable: (agentName) =>
          stateMachine.getState(agentName) !== "stopped" && resolveAgentId(agentName) !== null,
        // P0.6：drain 出队前再过一次成本门——入队时放行、排空时已熔断的积压/
        // 退避消息在此被拦下，熔断真正止血（不只拦截新入队）。
        deliveryGate: (agentName) => {
          const g = evaluateCostGate(deps.costTracker, agentName);
          return { blocked: g.blocked, reason: g.message ?? undefined };
        },
        onDeliveryBlocked: (agentName, items) => {
          const g = evaluateCostGate(deps.costTracker, agentName);
          if (g.blocked) notifyCircuitBreak(agentName, items[0]?.channelName ?? "", g);
        },
        onRetry: (agentName, item, err, nextDelayMs) => {
          console.warn(
            `[Daemon] @${agentName} dispatch attempt ${item.attempts} failed, retry in ${nextDelayMs}ms:`,
            (err as any)?.message ?? err,
          );
        },
        onDeadLetter: (agentName, item, err) => {
          try {
            deps.onDeliveryDeadLetter?.(agentName, item.channelName, err);
          } catch {
            /* 回调失败不阻塞队列 */
          }
        },
      })
    : null;

  // 门控投递队列（替代旧的"in-flight 就丢弃"）：同一 agent 的消息挂到 promise
  // 链尾串行执行——agent 忙时新消息在链上缓冲，上一条 dispatch 完成后按序投递，
  // 不再丢消息。投递时机仍由 postStartWriter 的提示符就绪门控保证（写入会等到
  // Claude 出现输入提示符，思考/工具执行期间的输入由 Claude Code 自己排队处理）。
  const dispatchToAgent = (
    agentName: string,
    channelName: string,
    userMsg: string,
    threadId?: string,
  ): Promise<void> => {
    const gate = evaluateCostGate(deps.costTracker, agentName);
    if (gate.blocked) {
      notifyCircuitBreak(agentName, channelName, gate);
      return Promise.resolve();
    }

    if (dispatchQueue) {
      // 「已缓冲」toast 保持旧语义：只有 agent 确实在忙（在途/积压/退避中）才提示，
      // 空闲时队列会立即排空，不打扰用户
      const wasBusy = dispatchQueue.isBusy(agentName);
      const res = dispatchQueue.enqueue({ agentName, channelName, content: userMsg, kind: "message", threadId });
      if (wasBusy) {
        console.log(`[Daemon] @${agentName} busy — message queued (dispatch queue)`);
        try {
          deps.onDeliveryQueued?.(agentName, channelName);
        } catch {
          /* 回调失败不阻塞排队 */
        }
      }
      // await 语义与旧门控链一致：resolve = 投递完成（delivered 或死信完结），
      // 不 reject——错误经 onDeliveryDeadLetter 上报
      return res.status === "queued" ? res.done : Promise.resolve();
    }

    const msgWithReminder = userMsg + REMINDER_TAIL(agentName);
    const inFlight = dispatchPromises.get(agentName);
    if (inFlight) {
      console.log(`[Daemon] @${agentName} busy — message queued (gated delivery)`);
      try {
        deps.onDeliveryQueued?.(agentName, channelName);
      } catch {
        /* 回调失败不阻塞排队 */
      }
    }
    const next = (inFlight ?? Promise.resolve())
      .catch(() => {}) // 上一条失败不阻断队列后续消息
      .then(() => doDispatch(agentName, channelName, msgWithReminder, threadId));
    dispatchPromises.set(agentName, next);
    // 链尾清理：map 里还是这条链才删（期间有新消息入队则保留链尾）
    const cleanup = () => {
      if (dispatchPromises.get(agentName) === next) dispatchPromises.delete(agentName);
    };
    next.then(cleanup, cleanup);
    return next;
  };
  dispatchToAgentRef = dispatchToAgent;

  const attachThreadContext = async (
    agentName: string,
    channelName: string,
    taskPrompt: string,
    threadId: string | undefined,
    content: string,
    messageId?: string,
  ): Promise<{ userMsg: string; threadId?: string }> => {
    const agentId = resolveAgentId(agentName);
    if (!agentId || !threadId) return { userMsg: taskPrompt, threadId };
    const built = await buildThreadContextEnvelope({
      serverUrl: options.serverUrl,
      apiKey: options.apiKey,
      agentId,
      channelName,
      threadId,
      triggerId: messageId,
      triggerContent: content,
    });
    if (!built) return { userMsg: taskPrompt, threadId };
    try {
      deps.costTracker?.recordContext?.(agentName, agentId, channelName, {
        chars: built.chars,
        messages: built.kept,
        dropped: built.dropped,
      });
    } catch (err: any) {
      console.warn(`[Daemon] @${agentName} context cost record failed:`, err?.message ?? err);
    }
    console.log(
      `[Daemon] @${agentName} context packed thread ${threadId.slice(0, 8)} kept=${built.kept} dropped=${built.dropped} chars=${built.chars}`,
    );
    return { userMsg: `${built.envelope}\n\n${taskPrompt}`, threadId: built.threadId };
  };

  const runAgent = async (
    agentName: string,
    channelName: string,
    replyTarget: string,
    senderName: string,
    content: string,
    threadId?: string,
    messageId?: string,
  ): Promise<void> => {
    const inThread = Boolean(threadId) || replyTarget.includes(":");
    const where = inThread ? `#${channelName} 的一个线程里` : `#${channelName} 频道`;
    const taskPrompt = [
      `你在 ${where}被 @ 了。来自 @${senderName} 的消息：${content}`,
      ``,
      `请用 \`send_message\` 工具（target="${replyTarget}"）回复；没有该工具时退回` +
        `\`slock message send --target "${replyTarget}"\`（内容从 stdin 传入）`,
      inThread ? "在该线程内" : "在该频道",
      `回复。注意 target 必须严格用 "${replyTarget}"。`,
    ].join("\n");
    const packed = await attachThreadContext(agentName, channelName, taskPrompt, threadId, content, messageId);
    await dispatchToAgent(agentName, channelName, packed.userMsg, packed.threadId);
  };

  const runAgentDm = async (
    agentName: string,
    replyTarget: string,
    senderName: string,
    content: string,
  ): Promise<void> => {
    const userMsg = [
      `你收到了一条来自 @${senderName} 的私信（DM）：${content}`,
      ``,
      `请用 \`send_message\` 工具（target="${replyTarget}"）直接回复；没有该工具时退回` +
        `\`slock message send --target "${replyTarget}"\`（内容从 stdin 传入）。`,
      `注意 target 必须严格用 "${replyTarget}"。`,
      `私信是一对一的，无需被 @ 也应当回应。`,
    ].join("\n");
    await dispatchToAgent(agentName, replyTarget, userMsg);
  };

  const runAgentReminder = async (agentName: string, reminder: ReminderFirePayload): Promise<void> => {
    const channelName = (reminder.channel || "").replace(/^#/, "").split(":")[0] || "general";
    if (reminder.kind === "patrol") {
      await dispatchToAgent(agentName, channelName, buildPatrolPrompt(reminder));
      return;
    }
    const where = reminder.channel
      ? `相关频道：${reminder.channel}。如需发消息，用 \`send_message\` 工具（target="${reminder.channel}"），没有该工具时退回` +
        `\`echo "内容" | slock message send --target "${reminder.channel}"\`。`
      : `没有指定频道；如需发消息，先用 \`slock server info\` 找到合适频道，或按你 MEMORY.md 里的约定。`;
    const userMsg = [
      `⏰ 你之前设置的提醒触发了：「${reminder.title || "(无标题)"}」。`,
      where,
      `请据此完成相应跟进；处理完即结束本回合。`,
    ].join("\n");
    await dispatchToAgent(agentName, channelName, userMsg);
  };

  const runAgentTriage = async (
    agentName: string,
    channelName: string,
    replyTarget: string,
    senderName: string,
    content: string,
    threadId?: string,
    messageId?: string,
  ): Promise<void> => {
    const taskPrompt = buildTriagePrompt({ channelName, replyTarget, senderName, content });
    const packed = await attachThreadContext(agentName, channelName, taskPrompt, threadId, content, messageId);
    await dispatchToAgent(agentName, channelName, packed.userMsg, packed.threadId);
  };

  return {
    dispatchToAgent,
    runAgent,
    runAgentDm,
    runAgentReminder,
    runAgentTriage,
    clearAgentQueue: (agentName) => {
      dispatchPromises.delete(agentName);
      return dispatchQueue?.clear(agentName) ?? 0;
    },
    disposeQueue: () => {
      dispatchPromises.clear();
      dispatchQueue?.dispose();
    },
    forgetSessionCost: (agentName) => {
      sessionCostDelta.forget(agentName);
    },
  };
};
