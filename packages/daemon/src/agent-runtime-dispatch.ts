import { createAgentDispatchQueue } from "./agent-dispatch-queue.js";
import { createSeqAllocator, type ObservationBus, streamEventToFrames } from "./agent-observation.js";
import type { AgentRuntimeOptions } from "./agent-runtime.js";
import type { ICredentialsClient } from "./agent-runtime-credentials.js";
import type { IExitChain } from "./agent-runtime-exit.js";
import type { SpawnPtyForAgent } from "./agent-runtime-spawn.js";
import { writeMcpConfig } from "./agent-runtime-spawn.js";
import type { IAgentStateMachine } from "./agent-runtime-state.js";
import type { ITurnTracker } from "./agent-runtime-turn-tracker.js";
import { createWorkspaceDir, fetchDispatchContext, writeSystemPromptFile } from "./agent-startup.js";
import { writeAgentTokenFile } from "./agent-token-file.js";
import { claudePrint } from "./claude-print.js";
import { PersistentClaude } from "./drivers/persistent-claude.js";
import type { IIdleReclaimer } from "./idle-reclaimer.js";
import { bundleSlockMcpServer } from "./mcp-bundle.js";
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

export interface IDispatch {
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
  const { mintAgentCredential } = credentialsClient;
  // B1：观察帧序号分配器（保证帧全局单调，便于排序/去重）
  const obsSeq = createSeqAllocator();

  // ---- 回复守卫（reply guard，headless 路径）----
  // 弱模型实证问题（2026-08-18 真机三次）：回合查到了答案但全程没调
  // send_message，最后纯文本输出答案甚至幻觉「已发送 ✅」——频道永远收不到。
  // headless 下观察帧能看到全部 tool_use，回合结束（result 事件）时检查本回合
  // 是否有发送动作，没有就自动追问一次补发。isNudge 防止追问本身再触发追问
  // （追问也没发 = 模型真的没救，不无限循环）。
  // SLOCK_REPLY_GUARD=0 可关闭（默认开启）。
  const REPLY_GUARD_PREFIX = "[slock-reply-guard]";
  interface TurnGuard {
    channel: string;
    hadSend: boolean;
    isNudge: boolean;
    /** 本回合最后一段正文（text 帧）——回合结束未发送时由 daemon 直接代发 */
    lastText?: string;
  }
  const turnGuards = new Map<string, TurnGuard>();
  const isSendToolFrame = (frame: { payload: { toolName?: string; text?: string } }): boolean => {
    const name = frame.payload.toolName ?? "";
    if (name.includes("send_message")) return true; // mcp__slock__send_message
    // CLI 兜底路径：Bash 里跑 slock message send
    if (name === "Bash" && (frame.payload.text ?? "").includes("slock message send")) return true;
    return false;
  };

  /** B1/C1：persistent 路径的 stream-json 事件处理——发布观察帧 + 工具审计 + 精确回合边界 */
  const handleStreamEvent = (agentName: string, ev: any): void => {
    const bus = deps.observationBus;
    if (bus) {
      for (const frame of streamEventToFrames(agentName, ev, obsSeq)) {
        bus.publish(frame);
        // 回复守卫：记录本回合出现过发送动作
        if (frame.kind === "tool_use") {
          const guard = turnGuards.get(agentName);
          if (guard && isSendToolFrame(frame)) guard.hadSend = true;
        }
        // 回复守卫：记下最后一段正文（代发的内容来源）
        if (frame.kind === "text") {
          const guard = turnGuards.get(agentName);
          if (guard && frame.payload.text?.trim()) guard.lastText = frame.payload.text;
        }
        // C1：工具调用生命周期（pending = tool_use 出现，completed = tool_result 回灌）
        if (frame.kind === "tool_use" || frame.kind === "tool_result") {
          try {
            deps.onToolCall?.(agentName, {
              toolName: frame.payload.toolName,
              toolUseId: frame.payload.toolUseId,
              status: frame.kind === "tool_use" ? "pending" : "completed",
              text: frame.payload.text,
            });
          } catch {
            /* 审计旁路不阻塞主链路 */
          }
        }
      }
    }
    // stream-json 的 result 事件即精确回合边界（替代 PTY 路径的 ❯ 启发式）：
    // 回合结束立刻回 idle，终端面板的状态列/空闲回收都靠这个状态。
    if (ev?.type === "result" && stateMachine.getState(agentName) === "working") {
      transitionState(agentName, "idle");
      idleReclaimer.touch(agentName);
      console.log(`[Daemon] @${agentName} round-end (stream-json result)`);

      // 回复守卫判定：整回合没有发送动作且不是追问本身 → 优先代发，其次追问
      const guard = turnGuards.get(agentName);
      turnGuards.delete(agentName);
      if (guard && !guard.hadSend && !guard.isNudge && process.env.SLOCK_REPLY_GUARD !== "0") {
        const answer = guard.lastText?.trim();
        if (answer && deps.onReplyMissing) {
          // 代发（2026-08-18 真机修正）：弱模型把答案当纯文本打完就结束回合是
          // 高频行为，追问要烧一整轮 LLM（实测 $0.5+/次）且追问回合本身可能被
          // 不活跃超时杀掉——二次失败。result 事件里已有最终正文，daemon 直接
          // 以 agent 身份 POST 到频道：零额外回合、确定性送达。
          console.warn(
            `[Daemon] @${agentName} reply-guard: turn ended without send_message, auto-posting final text (${answer.length} chars)`,
          );
          try {
            deps.onReplyMissing(agentName, guard.channel, answer);
          } catch {
            /* 代发失败走 console，不再追问 */
          }
        } else {
          // 没有任何正文可代发（纯工具回合）→ 保留追问兜底
          console.warn(`[Daemon] @${agentName} reply-guard: turn ended without send_message and no text, nudging once`);
          const nudge =
            `${REPLY_GUARD_PREFIX} 系统检测到你上一个回合没有调用 send_message（或 slock message send）——` +
            `你直接打的字不会送到频道，对方还在等回复。请现在把上一条问题的答案用 ` +
            `\`mcp__slock__send_message\`（target="${guard.channel}"）补发出去。` +
            `（触发于 ${new Date().toISOString()}）`; // 时间戳防 dedup 吞掉连续追问
          // fire-and-forget：走正常队列，不和当前回合处理抢顺序
          void dispatchToAgent(agentName, guard.channel, nudge).catch(() => {});
        }
      }
    }
  };

  const doDispatch = async (agentName: string, channelName: string, userMsg: string): Promise<void> => {
    const agentId = resolveAgentId(agentName);
    if (!agentId) {
      // A1：抛错而非静默 return——队列模式靠 reject 触发死信；旧链模式由
      // 链上 .catch(() => {}) 吞掉，行为与旧实现等价
      throw new Error(`[Daemon] No agent id for @${agentName}, skip dispatch`);
    }

    if (stateMachine.getState(agentName) === "stopped") {
      throw new Error(`[Daemon] @${agentName} is stopped, cannot dispatch`);
    }

    if (usePty) {
      // ---- PTY 模式 ----
      try {
        // 首次发送：启动 PTY（bootstrap 系统提示 + 本条用户消息合并成一次写入，
        // 见 spawnPtyForAgent 注释——避免两次独立写产生竞态）；后续发送：复用现有 PTY。
        // 系统提示文件只在这里（新 spawn）生成才有意义——已运行的 PTY 不会重读它。
        if (!runIdByAgent.has(agentName)) {
          transitionState(agentName, "starting");
          // 启动超时 15s
          const timer = setTimeout(() => {
            clearStartupTimer(agentName);
            transitionState(agentName, "idle");
            console.warn(`[Daemon] @${agentName} PTY startup timed out (15s)`);
          }, 15000);
          stateMachine.setStartupTimer(agentName, timer);

          try {
            const info = agentInfo.get(agentName) || {};
            const workspace = createWorkspaceDir(agentName, info);
            // 换一个 scoped runtime token（只在启动新 PTY 时才需要——写入已运行
            // PTY 的消息不重新 spawn，不需要新 env）。换取失败就直接让本次
            // 启动失败：如果连服务端都换不到 token，agent 起来了也调不了
            // slock message send，不如现在就失败得明确，而不是悄悄退回共享
            // apiKey（那正是这套机制想关掉的安全洞）。
            const runtimeToken = await mintAgentCredential(agentId);
            // O11：token 落盘（workspace/.slock/agent-token, 0600），子进程 env 只带
            // 文件路径不带明文。env 对象里保留 SLOCK_AGENT_TOKEN 是给 daemon 内部用的
            // （spawn 侧 registerRunContext → 退出时 tokenRegistry.revokeIfMatches），
            // 真正传给 PTY 子进程前由 buildPtyEnv 剥离。
            const tokenFile = writeAgentTokenFile(workspace, runtimeToken);
            // 查一下自己是不是这个频道的经理、频道里还有哪些别的 agent——写进
            // 系统提示里当确定事实，而不是让 agent 自己猜（见 agent-startup.ts
            // fetchDispatchContext 注释）。查询失败时退回通用提示文案，不阻塞启动。
            const dispatchContext = await fetchDispatchContext(options.serverUrl, options.apiKey, agentId, channelName);
            const promptFile = writeSystemPromptFile(agentName, channelName, true, info, dispatchContext);
            const env = {
              SLOCK_AGENT_ID: agentId,
              SLOCK_AGENT_TOKEN: runtimeToken,
              SLOCK_AGENT_TOKEN_FILE: tokenFile,
              SLOCK_SERVER_URL: options.serverUrl,
            };
            const runId = await spawnPtyForAgent(agentName, agentId, workspace, promptFile, env, userMsg);
            clearStartupTimer(agentName);
            transitionState(agentName, "working");
            idleReclaimer.untrack(agentName);
            exitChain.incrementMessagesProcessed(runId);
            console.log(`[Daemon] @${agentName} message dispatched (pty, bootstrap+first msg)`);
          } catch (err: any) {
            clearStartupTimer(agentName);
            transitionState(agentName, "idle");
            console.error(`[Daemon] @${agentName} PTY start failed:`, err?.message ?? err);
            // A1：抛出让派发队列重试（token 换取失败、spawn 失败都可能是瞬时的）
            throw err;
          }
        } else {
          transitionState(agentName, "working");
          idleReclaimer.untrack(agentName);

          // 写入用户消息（内部已用 postStartWriter 等提示符）
          const runId = runIdByAgent.get(agentName)!;
          // 只有当前没有"还在等回复"的消息时才清掉"观察到过忙碌"这个标记——
          // 如果是重叠写入（上一条还没处理完这条又来了），Claude 可能已经在忙，
          // 不能把这个证据清掉，否则会重新要求"再忙碌一次"才能判定结束。
          if (!turnTracker.hasPending(agentName)) turnTracker.clearBusyObserved(agentName);
          turnTracker.incPending(agentName);
          postStartWriter(runId, userMsg);
          exitChain.incrementMessagesProcessed(runId);
          console.log(`[Daemon] @${agentName} message dispatched (pty)`);
        }
      } catch (err: any) {
        clearStartupTimer(agentName);
        transitionState(agentName, "idle");
        console.error("[Daemon] dispatchToAgent (pty) failed:", err?.message ?? err);
        throw err;
      }
      return;
    }

    // ---- 兜底：PersistentClaude / claudePrint 路径 ----
    const needsSpawn = !persistentSessions.has(agentName);
    if (needsSpawn) {
      transitionState(agentName, "starting");
      const timer = setTimeout(() => {
        clearStartupTimer(agentName);
        transitionState(agentName, "idle");
        console.warn(`[Daemon] @${agentName} startup timed out (15s)`);
      }, 15000);
      stateMachine.setStartupTimer(agentName, timer);
    }

    try {
      const info = agentInfo.get(agentName) || {};
      const promptFile = writeSystemPromptFile(agentName, channelName, true, info);
      const workspace = createWorkspaceDir(agentName, info);

      // 见上面 PTY 分支的注释：服务端不认账号级 apiKey 之外的凭证要走 scoped
      // runtime token；这条兜底路径较少用，直接每次都换一个（幂等 upsert，
      // 覆盖上一条也无妨）
      const runtimeToken = await mintAgentCredential(agentId);
      // O11：这条路径的 env 直接进子进程（PersistentClaude / claudePrint），
      // 只放 token 文件路径，不放明文 token。
      const env = {
        SLOCK_AGENT_ID: agentId,
        SLOCK_AGENT_TOKEN_FILE: writeAgentTokenFile(workspace, runtimeToken),
        SLOCK_SERVER_URL: options.serverUrl,
      };

      // MCP 工具接入（与 PTY 路径对齐，见 agent-runtime-spawn.ts）：headless
      // 路径此前漏写 .mcp.json——agent 没有 send_message MCP 工具，只能靠记住
      // `slock` CLI 命令回复；弱模型在受挫回合里会忘（2026-08-18 真机：天气
      // 查到了但纯文本作答结束回合，频道永远收不到）。失败不阻塞：CLI 兜底仍在。
      try {
        const mcpBundlePath = await bundleSlockMcpServer();
        if (mcpBundlePath) {
          writeMcpConfig(
            workspace,
            agentId,
            env.SLOCK_AGENT_TOKEN_FILE ?? "",
            env.SLOCK_SERVER_URL ?? "",
            mcpBundlePath,
          );
        }
      } catch (err: any) {
        console.warn(
          `[Daemon] @${agentName} MCP config setup failed (headless), CLI-only fallback: ${err?.message ?? err}`,
        );
      }

      const usePersistent = process.env.SLOCK_ONESHOT_CLAUDE !== "1";
      if (usePersistent) {
        let session = persistentSessions.get(agentName);
        if (!session) {
          session = new PersistentClaude({
            cwd: workspace,
            systemPromptFile: promptFile,
            env,
            label: "@" + agentName,
            onStreamEvent: (ev) => handleStreamEvent(agentName, ev),
            // 进程退出（含 turn timeout 误杀/崩溃）：headless 下不会再有 result
            // 事件，状态机靠这个回调从 working 解封，否则永久卡住（STUCK 刷屏）
            onExit: () => {
              if (stateMachine.getState(agentName) === "working") {
                transitionState(agentName, "idle");
                idleReclaimer.touch(agentName);
                console.log(`[Daemon] @${agentName} persistent process exited mid-turn, state -> idle`);
              }
            },
          });
          persistentSessions.set(agentName, session);
        }
        clearStartupTimer(agentName);
        transitionState(agentName, "working");
        // 回复守卫登记（headless）：本回合结束时会检查是否有 send_message 动作
        turnGuards.set(agentName, {
          channel: channelName,
          hadSend: false,
          isNudge: userMsg.startsWith(REPLY_GUARD_PREFIX),
        });
        // 回合级交付：await 到 result 事件（进程 mid-turn 退出则 reject → A1 队列
        // 退避重试，换 fresh 会话重投这条消息）。状态机回 idle 由 handleStreamEvent
        // 的 result 分支负责（早于这里的 resolve，顺序无害）。
        await session.send(userMsg);
        console.log(`[Daemon] @${agentName} turn finished (persistent)`);
      } else {
        clearStartupTimer(agentName);
        transitionState(agentName, "working");
        const sid = agentSessions.get(agentName);
        const claude = await claudePrint(userMsg, sid, promptFile, env, workspace);
        if (claude.sessionId) agentSessions.set(agentName, claude.sessionId);
        console.log(`[Daemon] @${agentName} turn finished (one-shot)`);
        transitionState(agentName, "idle");
      }
    } catch (err: any) {
      clearStartupTimer(agentName);
      transitionState(agentName, "idle");
      console.error("[Daemon] dispatchToAgent failed:", err?.message);
      throw err;
    }
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
  const useDispatchQueue = process.env.SLOCK_DISPATCH_QUEUE !== "0";
  const dispatchQueue = useDispatchQueue
    ? createAgentDispatchQueue({
        // in-flight 截止放宽到 6 分钟：persistent 路径的 deliver 是回合级的
        // （2026-08-18 起 await 到 result 事件），正常回合轻松超过默认 60s。
        // 真正的看门狗是 PersistentClaude 的不活跃超时（300s 沉默必杀 → reject），
        // 这里的截止只是「deliver Promise 泄漏」的兜底，不参与卡死检测。
        inflightMs: Number(process.env.SLOCK_DISPATCH_INFLIGHT_MS) || 360_000,
        deliver: async (agentName, items) => {
          // 合并重提示：多条积压拼成一条复合 prompt，reminder tail 只追加一次
          const merged = items.map((i) => i.content).join("\n\n");
          if (items.length > 1) {
            console.log(`[Daemon] @${agentName} merged ${items.length} queued messages into one dispatch`);
          }
          await doDispatch(agentName, items[0].channelName, merged + REMINDER_TAIL(agentName));
        },
        isDeliverable: (agentName) =>
          stateMachine.getState(agentName) !== "stopped" && resolveAgentId(agentName) !== null,
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
  const dispatchToAgent = (agentName: string, channelName: string, userMsg: string): Promise<void> => {
    if (dispatchQueue) {
      // 「已缓冲」toast 保持旧语义：只有 agent 确实在忙（在途/积压/退避中）才提示，
      // 空闲时队列会立即排空，不打扰用户
      const wasBusy = dispatchQueue.isBusy(agentName);
      const res = dispatchQueue.enqueue({ agentName, channelName, content: userMsg, kind: "message" });
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
      .then(() => doDispatch(agentName, channelName, msgWithReminder));
    dispatchPromises.set(agentName, next);
    // 链尾清理：map 里还是这条链才删（期间有新消息入队则保留链尾）
    const cleanup = () => {
      if (dispatchPromises.get(agentName) === next) dispatchPromises.delete(agentName);
    };
    next.then(cleanup, cleanup);
    return next;
  };

  const runAgent = async (
    agentName: string,
    channelName: string,
    replyTarget: string,
    senderName: string,
    content: string,
  ): Promise<void> => {
    const inThread = replyTarget.includes(":");
    const where = inThread ? `#${channelName} 的一个线程里` : `#${channelName} 频道`;
    const userMsg = [
      `你在 ${where}被 @ 了。来自 @${senderName} 的消息：${content}`,
      ``,
      `请用 \`send_message\` 工具（target="${replyTarget}"）回复；没有该工具时退回` +
        `\`slock message send --target "${replyTarget}"\`（内容从 stdin 传入）`,
      inThread ? "在该线程内" : "在该频道",
      `回复。注意 target 必须严格用 "${replyTarget}"。`,
    ].join("\n");
    await dispatchToAgent(agentName, channelName, userMsg);
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

  return { dispatchToAgent, runAgent, runAgentDm, runAgentReminder };
};
