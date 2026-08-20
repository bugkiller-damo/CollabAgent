import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createAgentManager } from "./agent-manager.js";
import { createObservationBus, type ObservationBus } from "./agent-observation.js";
import { createCredentialsClient } from "./agent-runtime-credentials.js";
import { createDispatch, type ReminderFirePayload } from "./agent-runtime-dispatch.js";
import { createExitChain } from "./agent-runtime-exit.js";
import { createSpawnPtyForAgent } from "./agent-runtime-spawn.js";
import { createAgentStateMachine } from "./agent-runtime-state.js";
import { BUSY_MARKER_RE, createTurnTracker, PROMPT_RE } from "./agent-runtime-turn-tracker.js";
import { createAgentStdinDispatcher } from "./agent-stdin-dispatcher.js";
import { resolveCommand } from "./command-resolver.js";
import type { PersistentClaude } from "./drivers/persistent-claude.js";
import { resolveCommandOnPath } from "./drivers/probe.js";
import { createIdleReclaimer } from "./idle-reclaimer.js";
import { createPostStartInputWriter, type PostStartInputWriter } from "./post-start-input-writer.js";
import type {
  AgentStatus,
  IAgentManager,
  IAgentRunStore,
  IAgentStdinDispatcher,
  IAgentTokenRegistry,
  ILiveRunRegistry,
} from "./types/index.js";

// 重新导出，保持既有 import { BUSY_MARKER_RE, PROMPT_RE } from "./agent-runtime.js" 的调用方
// （包括 test/round-end-detection.test.ts）不需要跟着改路径
export { BUSY_MARKER_RE, PROMPT_RE };

// 四态状态机（uninit/idle/starting/working/stopped）已拆到 agent-runtime-state.ts
// 回合结束检测用到的 BUSY_MARKER_RE/PROMPT_RE + pending/busyObserved 状态已拆到
// agent-runtime-turn-tracker.ts

const PTY_COMMAND = "claude"; // TODO: read from command-resolver

// ANSI CSI 序列（ESC [ 参数 结尾字母）匹配——stuck 检测里剥 raw tail 用。
// 不能写 /\x1b…/ 正则字面量：noControlCharactersInRegex 拒绝一切匹配控制字符的
// 正则字面量（\x1b / \u001b / \u{1b} 都会被拦），改为字符串构造 RegExp，
// 编译结果与 /\x1b\[[0-9;?]*[a-zA-Z]/g 完全一致（仅用于 replace，无 lastIndex 状态问题）。
const ESC = "\x1b";
const ANSI_CSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g");

/**
 * 解析 Claude CLI 的可执行文件路径。
 *
 * Windows 上的 npm 全局安装会创建 `claude.cmd` shim（实质是 batch 包装器），
 * node-pty 的 ConPTY 后端在调用 CreateProcessW 时不会沿 PATH 查找 .cmd，
 * 会直接报 ERROR_FILE_NOT_FOUND (code 2)。
 *
 * 解法：先用 `where` / 已知的 npm 路径找到 .cmd/.exe 的真实绝对路径。
 * 若找到的是 .cmd shim，进一步解析其内容，定位它真正 exec 的 .exe，
 * 避免 ConPTY 多走一层 cmd.exe 解释（也避免奇怪的路径传递问题）。
 */
const resolveCmdShimTarget = (cmdPath: string): string | null => {
  try {
    const content = readFileSync(cmdPath, "utf-8");
    // .cmd shim 通常长这样：
    //   @"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
    // 提取引号内的 .exe 路径
    const m = content.match(/^[^"]*?"([^"]+\.exe)"/m);
    if (m) {
      const raw = m[1];
      // 把 %dp0% 替换为 .cmd 所在目录
      const resolved = raw.replace(/%~dp0%|%dp0%/gi, dirname(cmdPath));
      if (existsSync(resolved)) return resolved;
      // 也有可能 %dp0% 已展开（绝对路径）
      if (existsSync(raw)) return raw;
    }
  } catch {
    /* 解析失败，回退 */
  }
  return null;
};

const resolveClaudeBinary = (): string => {
  const fromProbe = resolveCommandOnPath("claude");
  if (fromProbe) {
    if (/\.(cmd|bat)$/i.test(fromProbe)) {
      const realExe = resolveCmdShimTarget(fromProbe);
      if (realExe) return realExe;
      // 同目录替换（极少数情况 shim 与 exe 同目录）
      const sameDirExe = fromProbe.replace(/\.(cmd|bat)$/i, ".exe");
      if (existsSync(sameDirExe)) return sameDirExe;
    }
    return fromProbe;
  }
  // 最后兜底：用 command-resolver 的通用搜索
  const fallback = resolveCommand("claude");
  if (existsSync(fallback)) return fallback;
  return "claude";
};

/**
 * Agent 运行时编排器。
 *
 * 负责：
 * - 消息分发（dispatchToAgent / runAgent / runAgentDm / runAgentReminder）
 * - Agent 注册表管理
 * - 常驻会话缓存（PTY 模式单进程常驻 / PersistentClaude 模式类常驻）
 * - 与 agent-tokens / live-run-registry 集成
 *
 * ### 启动路径（B2，2026-08-18 起 headless 为默认）
 * - 默认（headless）：PersistentClaude 持久会话，stream-json stdin/stdout
 *   结构化通道；`SLOCK_ONESHOT_CLAUDE=1` 退到 claudePrint 一次性模式
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
}

export interface IAgentRuntime {
  // 消息分发
  dispatchToAgent(agentName: string, channelName: string, userMsg: string): Promise<void>;
  runAgent(
    agentName: string,
    channelName: string,
    replyTarget: string,
    senderName: string,
    content: string,
  ): Promise<void>;
  runAgentDm(agentName: string, replyTarget: string, senderName: string, content: string): Promise<void>;
  runAgentReminder(agentName: string, reminder: ReminderFirePayload): Promise<void>;
  // 注：原 autostartAgent（崩溃恢复主动拉起 + 注入"安静等待"恢复消息）已于
  // 2026-07-29 移除——那条恢复消息是一整个 agent 回合且 99% 空转（实测 55k 输出），
  // 改为 lazy spawn + session resume（见 daemon-core.autostartCrashedAgents）。

  // 注册表
  registerAgent(id: string, name: string, info: { displayName?: string; description?: string; model?: string }): void;
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
  stopAgent(agentName: string): void;
  stopAll(): void;
  /** 记录该 agent 的首选终端尺寸（面板尺寸协商用）——下次 spawn 直接按此尺寸启动 */
  setPreferredTermSize(agentName: string, size: { cols: number; rows: number }): void;

  // 查询
  getAgentInfo(name: string): { displayName?: string; description?: string; model?: string } | undefined;
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
  tokenRegistry: IAgentTokenRegistry,
  liveRunRegistry: ILiveRunRegistry,
  runStore?: IAgentRunStore,
  /** 仅供测试注入假的 IAgentManager（见 test/fakes/fake-agent-manager.ts）；
   *  生产环境不传，默认走真实的 node-pty 实现。 */
  agentManagerOverride?: IAgentManager,
): IAgentRuntime => {
  // ---- 注册表 ----
  const agentDrivers = new Map<string, boolean>();
  const agentSessions = new Map<string, string>();
  const agentNameToId = new Map<string, string>();
  const agentInfo = new Map<string, { displayName?: string; description?: string; model?: string }>();

  // ---- PTY 模式基础设施 ----
  const agentManager: IAgentManager = agentManagerOverride ?? createAgentManager();
  // agentName -> runId 缓存（常驻 PTY）
  const runIdByAgent = new Map<string, string>();
  // agentName -> 首选终端尺寸（面板协商；下次 spawn 应用）
  const preferredTermSize = new Map<string, { cols: number; rows: number }>();
  // runId -> unsubscribe 函数
  const unsubByRunId = new Map<string, () => void>();
  // 旧 PersistentClaude 路径（兜底）
  const persistentSessions = new Map<string, PersistentClaude>();

  // ---- B1：结构化观察帧总线（headless 路径的围观数据源，见 agent-observation.ts）----
  const observationBus = createObservationBus();

  // B2（2026-08-18 切换）：headless（PersistentClaude + stream-json）为默认路径，
  // PTY 降级为 fallback（SLOCK_USE_PTY=1，真 TUI 调试/排障用）。
  // 门控与切换依据见 docs/2026-08-18/03-slock-modification-plan.md §2.B2——
  // B1 观察帧 + A1 队列经七轮真机回归后执行本切换。
  // SLOCK_PERSISTENT_CLAUDE=1 是旧开关，效果与默认一致（保留兼容，不再读取）。
  const usePty = process.env.SLOCK_USE_PTY === "1";
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

  // ---- 并发保护 ----
  const dispatchPromises = new Map<string, Promise<void>>();

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

  // ---- 空闲回收（对应 ADR-005："工作中的 agent 队列空 + 无活动 -> 优雅关闭"）----
  // touch() 在每次回合结束（working -> idle）时调用；untrack() 在开始新一轮 working 或
  // 显式停止时调用，避免正在处理消息的 agent 被计入空闲时间。
  // 默认 60s 对连续聊天太激进——用户隔一两分钟追问一次就会吃到完整冷启动（2026-07-17
  // 实测：78s 被回收，第二个问题重新 spawn）。300s 仍然太短：冷启动 = 全量 bootstrap +
  // 上下文重建（读 MEMORY/查历史/查派发），是 token 消耗大头（2026-07-29 实测：317s 被
  // 回收，下条消息又付一次全量冷启动）。默认放宽到 1800s，可用 SLOCK_IDLE_RECLAIM_MS 调整。
  const idleReclaimer = createIdleReclaimer({
    timeoutMs: Number(process.env.SLOCK_IDLE_RECLAIM_MS) || 1_800_000,
    onReclaim: (name) => {
      const runId = runIdByAgent.get(name);
      if (runId) agentManager.stopRun(runId); // 真正的清理交给下面的退出清理链回调
    },
  });
  idleReclaimer.start();

  // ---- 退出清理链（见 agent-runtime-exit.ts）----
  const exitChain = createExitChain({
    tokenRegistry,
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
  const STUCK_WARN_MS = Number(process.env.SLOCK_STUCK_WARN_MS) || 90_000;
  const QUIESCE_MS = Number(process.env.SLOCK_QUIESCE_MS) || 20_000;
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

  // ---- 消息分发核心（见 agent-runtime-dispatch.ts）----
  const { dispatchToAgent, runAgent, runAgentDm, runAgentReminder } = createDispatch({
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
    onDeliveryQueued: options.onDeliveryQueued,
    onDeliveryDeadLetter: options.onDeliveryDeadLetter,
    observationBus,
    onToolCall: options.onToolCall,
    onReplyMissing: options.onReplyMissing,
  });

  // ---- 公开接口 ----

  return {
    dispatchToAgent,
    runAgent,
    runAgentDm,
    runAgentReminder,

    registerAgent(
      id: string,
      name: string,
      info: { displayName?: string; description?: string; model?: string },
    ): void {
      agentDrivers.set(name, true);
      if (id) agentNameToId.set(name, id);
      // 合并而非覆盖：编辑 agent（PATCH → agent:start 重推）时某些字段可能缺省，
      // 整体覆盖会把之前已捕获的 model 抹掉（2026-07-17 实测：改成 haiku 后
      // spawn 无 --model，因为重推消息没解出 model，覆盖了启动时捕获的 sonnet）。
      const prev = agentInfo.get(name);
      agentInfo.set(name, {
        displayName: info.displayName ?? prev?.displayName,
        description: info.description ?? prev?.description,
        model: info.model ?? prev?.model,
      });
      // 清理旧 PTY / 旧 session
      const oldRunId = runIdByAgent.get(name);
      if (oldRunId) {
        agentManager.stopRun(oldRunId);
        const unsub = unsubByRunId.get(oldRunId);
        if (unsub) {
          unsub();
          unsubByRunId.delete(oldRunId);
        }
        runIdByAgent.delete(name);
      }
      persistentSessions.get(name)?.stop();
      persistentSessions.delete(name);
      idleReclaimer.untrack(name);
      transitionState(name, "idle");
    },

    unregisterAgent(name: string): void {
      agentNameToId.delete(name);
      agentDrivers.delete(name);
      agentInfo.delete(name);
      agentSessions.delete(name);
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
      clearStartupTimer(name);
      idleReclaimer.untrack(name);
      transitionState(name, "stopped");
    },

    async loadExistingAgents(): Promise<void> {
      try {
        // mine=1：只拉本账号名下的 agent。/api/agents 默认返回所属组织里所有人的
        // agent（给人看的列表需要这个视角），daemon 全注册进来会导致 hasAgent()
        // 谎报、真 spawn 时换不到凭证 403（见 agents-public.ts 的 mine 注释）。
        const res = await fetch(options.serverUrl + "/api/agents?mine=1", {
          headers: { Authorization: `Bearer ${options.apiKey}` },
        });
        const data = (await res.json()) as any;
        for (const agent of data.agents || []) {
          const name = agent.name as string;
          if (agent.id) agentNameToId.set(name, agent.id as string);
          agentInfo.set(name, { displayName: agent.display_name, description: agent.description, model: agent.model });
          if (!agentDrivers.has(name)) {
            console.log("[Daemon] Registered (lazy): @" + name + " -> " + (agent.id || "?").slice(0, 8));
            agentDrivers.set(name, true);
            transitionState(name, "idle");
          }
        }
      } catch (err: any) {
        console.error("[Daemon] Could not load agents:", err?.message || String(err));
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
      const runId = runIdByAgent.get(agentName);
      if (runId) {
        agentManager.stopRun(runId);
        const unsub = unsubByRunId.get(runId);
        if (unsub) {
          unsub();
          unsubByRunId.delete(runId);
        }
        runIdByAgent.delete(agentName);
      }
      persistentSessions.get(agentName)?.stop();
      persistentSessions.delete(agentName);
      idleReclaimer.untrack(agentName);
    },

    stopAll(): void {
      idleReclaimer.stop();
      for (const unsub of unsubByRunId.values()) unsub();
      unsubByRunId.clear();
      for (const runId of runIdByAgent.values()) agentManager.stopRun(runId);
      runIdByAgent.clear();
      for (const s of persistentSessions.values()) s.stop();
      persistentSessions.clear();
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
};
