import { writeMcpConfig } from "./agent-mcp-config.js";
import type { ProgressTurn } from "./agent-progress.js";
import type { IWorkerCrashGuard } from "./agent-runtime-crash-guard.js";
import type { ICredentialsClient } from "./agent-runtime-credentials.js";
import { abortTurnGuards, armTurnGuard, type TurnGuard } from "./agent-runtime-dispatch-stream.js";
import type { AgentRuntimeDriver, AgentRuntimeSession, AgentTurnRequest } from "./agent-runtime-driver.js";
import type { AgentRuntimeEvent } from "./agent-runtime-events.js";
import type { IRuntimeInterruptStore } from "./agent-runtime-interrupt-store.js";
import type { AgentRegistrationInfo, ResolvedAgentRuntimeProfile } from "./agent-runtime-profile.js";
import type { IAgentStateMachine } from "./agent-runtime-state.js";
import type { IAgentSessionStore } from "./agent-session-store.js";
import {
  agentWorkspacePath,
  buildRoleContextLine,
  createWorkspaceDir,
  type DispatchContext,
  fetchDispatchContext,
  writeSystemPromptFile,
} from "./agent-startup.js";
import type { IThreadSessionStore } from "./agent-thread-sessions.js";
import { writeAgentTokenFile } from "./agent-token-file.js";
import { loadDaemonEnv } from "./config.js";
import { DispatchError, errMessage } from "./errors.js";
import type { IIdleReclaimer } from "./idle-reclaimer.js";
import { bundleSlockMcpServer } from "./mcp-bundle.js";
import { generateBridgeSystemPrompt } from "./system-prompt.js";

export interface DispatchHeadlessTurnOpts {
  agentName: string;
  agentId: string;
  channelName: string;
  userMsg: string;
  threadId?: string;
  /** A4：队列 item 的 kind——透传到 armTurnGuard 判 isNudge（triage/nudge 不触发回复守卫） */
  kind?: import("./agent-dispatch-queue.js").DispatchKind;
  /**
   * Phase 2（§8.4/§11）：回合元数据——turnId 随队列 item（retry 复用）、
   * conversationId（§11.1）、attempt；resume 是同 conversation pending
   * interrupt 的恢复载荷。claude driver 只用 prompt。
   */
  turn: {
    turnId: string;
    conversationId: string;
    attempt: number;
    /** §8.4：人类发送者名 → turn.start source.sender（bridge 专属，claude 忽略） */
    sender?: string;
    resume?: { interruptId: string; resumeToken: string; value: string };
  };
  /** Phase 2：interrupt 簿记——success 消费 / interrupted 覆写（§11.4） */
  interruptStore?: IRuntimeInterruptStore;
  /**
   * Phase 5（§15）：跨消息 crash-loop 熔断器。spawn/生命周期类失败累计到
   * 阈值后，冷却期内不再烧 spawn，直接 fail-closed（worker-crash-loop
   * 死信）。可选——测试不传则跳过熔断。
   */
  crashGuard?: IWorkerCrashGuard;
  haltGen: number;
  serverUrl: string;
  /** A1.3：机器级凭证，fetchDispatchContext 查频道经理/worker 名单用 */
  apiKey: string;
  /** A1.3：测试可注入；缺省走真实 /internal/agent/:id/channel-members 查询 */
  fetchDispatchContext?: (
    serverUrl: string,
    apiKey: string,
    agentId: string,
    channelName: string,
  ) => Promise<DispatchContext | null>;
  stateMachine: IAgentStateMachine;
  idleReclaimer: IIdleReclaimer;
  mintAgentCredential: ICredentialsClient["mintAgentCredential"];
  agentInfo: Map<string, AgentRegistrationInfo>;
  /** Phase 0：runtime driver（doDispatch 按 resolved profile.runtime 从 registry 取出后注入） */
  runtimeDriver: AgentRuntimeDriver;
  /** Phase 1：本回合的 resolved profile——model/identity 以它为准（agentInfo 只做工作区/提示词素材） */
  runtimeProfile: ResolvedAgentRuntimeProfile;
  /** Phase 1：agent → 会话身份；与 runtimeProfile.identity 不符的复用一律丢弃 */
  sessionIdentities: Map<string, string>;
  persistentSessions: Map<string, AgentRuntimeSession>;
  /**
   * P1.12：per-agent 会话创建单飞。A4 前队列 in-flight 超时会让重投与仍在跑的
   * deliver 重叠（A4 起超时不再重投，但停止/复活的竞态仍在）——两个
   * dispatchHeadlessTurn 都可能看到空 map 并各 open 一个常驻会话，
   * 后写覆盖前写，旧实例永不 stop。
   */
  sessionCreates: Map<string, Promise<AgentRuntimeSession>>;
  agentSessions: Map<string, string>;
  /** A2：agent→sessionId 持久化（daemon-agent-sessions.json）；spawn 时 --resume 数据源 */
  agentSessionStore?: IAgentSessionStore;
  threadSessions?: IThreadSessionStore;
  turnGuards: Map<string, TurnGuard>;
  progressTurns: Map<string, ProgressTurn>;
  handleStreamEvent: (agentName: string, ev: AgentRuntimeEvent) => void;
  createProgressPoster?: (agentName: string) => import("./agent-progress.js").ProgressPoster;
  onProgress?: (agentName: string, channelName: string, headline: string, phase: "start" | "update" | "end") => void;
  enterWorking: (agentName: string, expectedGen?: number) => boolean;
  releaseToIdle: (agentName: string) => void;
  assertLive: () => void;
  /** P0.5 / P1.12：丢掉常驻会话后清成本基线，避免新进程少记 */
  forgetSessionCost?: (agentName: string) => void;
  /**
   * A5：agentName → scoped token 签发时间戳（ms）。spawn 时写入；常驻会话
   * 复用且 token 余量 <1h（服务端 TTL 24h）时重 mint + 覆写 token 文件。
   * 会话被丢/回收/停止时由调用方清对应条目。
   */
  credentialIssuedAt: Map<string, number>;
}

/**
 * P1.12：同一 agent 的常驻会话创建单飞。
 * 先在同步路径占坑 `sessionCreates`，再 `then` 里 create——两个从 await mint
 * 回来的调用会共用同一个 Promise，不会各 open 一个实例。create 抛错不占
 * persistentSessions，锁在 finally 清掉，调用方可重试。
 */
export const ensurePersistentSession = (
  agentName: string,
  persistentSessions: Map<string, AgentRuntimeSession>,
  sessionCreates: Map<string, Promise<AgentRuntimeSession>>,
  create: () => AgentRuntimeSession,
): Promise<AgentRuntimeSession> => {
  const hit = persistentSessions.get(agentName);
  if (hit) return Promise.resolve(hit);
  const pending = sessionCreates.get(agentName);
  if (pending) return pending;

  const created = Promise.resolve().then(() => {
    const raced = persistentSessions.get(agentName);
    if (raced) return raced;
    const session = create();
    persistentSessions.set(agentName, session);
    return session;
  });
  sessionCreates.set(agentName, created);
  // catch 吞掉这条旁路链上的拒绝，避免 create 抛错时变成 unhandled rejection
  // （调用方仍通过返回的 created 自己处理）。
  void created
    .finally(() => {
      if (sessionCreates.get(agentName) === created) sessionCreates.delete(agentName);
    })
    .catch(() => {});
  return created;
};

/**
 * A5：scoped token 服务端 TTL 24h（见 agent-runtime-credentials.ts）。常驻会话
 * 可能跨天存活——剩余 TTL 低于该余量时重新 mint 并覆写 token 文件
 * （slock-mcp-server 每次请求重读文件，覆写即生效，不需要 respawn）。
 */
export const AGENT_CREDENTIAL_TTL_MS = 24 * 60 * 60 * 1000;
export const AGENT_CREDENTIAL_REFRESH_MARGIN_MS = 60 * 60 * 1000;

/** P1.12：只踢掉「本回合持有」的实例，避免误杀并发赢家刚换上的新会话。 */
export const dropStalePersistentSession = (
  agentName: string,
  persistentSessions: Map<string, AgentRuntimeSession>,
  session: AgentRuntimeSession | undefined,
  forgetSessionCost?: (agentName: string) => void,
  sessionIdentities?: Map<string, string>,
): void => {
  if (!session) return;
  if (persistentSessions.get(agentName) !== session) return;
  try {
    session.stop();
  } catch {
    /* stop 失败仍要从 map 摘掉，避免下次 send 打到死实例 */
  }
  persistentSessions.delete(agentName);
  sessionIdentities?.delete(agentName);
  try {
    forgetSessionCost?.(agentName);
  } catch {
    /* 基线清理是旁路 */
  }
};

export const dispatchHeadlessTurn = async (opts: DispatchHeadlessTurnOpts): Promise<void> => {
  const {
    agentName,
    agentId,
    channelName,
    userMsg,
    threadId,
    haltGen,
    stateMachine,
    idleReclaimer,
    mintAgentCredential,
    agentInfo,
    runtimeDriver,
    persistentSessions,
    sessionCreates,
    agentSessions,
    agentSessionStore,
    threadSessions,
    turnGuards,
    progressTurns,
    handleStreamEvent,
    enterWorking,
    releaseToIdle,
    assertLive,
    forgetSessionCost,
    credentialIssuedAt,
    runtimeProfile,
    sessionIdentities,
  } = opts;
  const { transitionState } = stateMachine;

  // 整段 dispatch（含 await mint）期间不计入空闲，避免复用路径上
  // mint 等待时扫描把即将 send 的常驻进程杀掉（P0.2）。
  idleReclaimer.untrack(agentName);
  // Phase 1：profile identity 变化（runtime/entrypoint/model/manifest 修订）→
  // 旧常驻会话不复用，丢掉后按新身份冷启动。
  const recordedIdentity = sessionIdentities.get(agentName);
  if (recordedIdentity !== undefined && recordedIdentity !== runtimeProfile.identity) {
    // Phase 5：identity 变化后旧 pending interrupt 的 resumeToken 指向的
    // checkpoint thread 已不可达——主动清，不等 take() 惰性发现。
    try {
      opts.interruptStore?.clearIncompatible(
        agentId,
        runtimeProfile.runtime,
        runtimeProfile.entrypoint,
        runtimeProfile.manifestRevision,
      );
    } catch {
      /* store 清理是旁路 */
    }
  }
  if (recordedIdentity !== runtimeProfile.identity && persistentSessions.has(agentName)) {
    dropStalePersistentSession(
      agentName,
      persistentSessions,
      persistentSessions.get(agentName),
      forgetSessionCost,
      sessionIdentities,
    );
    credentialIssuedAt.delete(agentName);
  }
  const envCfg = loadDaemonEnv();
  // Phase 2：bridge runtime（SARP/1）是常驻进程协议——oneshot 不适用，
  // SLOCK_ONESHOT_CLAUDE 只对 claude 生效。
  const isBridge = runtimeProfile.runtime !== "claude";
  const usePersistent = isBridge ? true : !envCfg.oneshotClaude;
  // A5：one-shot 每回合都是新进程（spawn-only 开销对它不是开销而是必需）；
  // persistent 复用已有会话时跳过 mint/sysprompt/workspace/mcp 全套准备。
  const needsSpawn = !usePersistent || !persistentSessions.has(agentName);
  if (needsSpawn) {
    transitionState(agentName, "starting");
    const timer = setTimeout(() => {
      releaseToIdle(agentName);
      console.warn(`[Daemon] @${agentName} startup timed out (15s)`);
    }, 15000);
    stateMachine.setStartupTimer(agentName, timer);
  }

  try {
    const info = agentInfo.get(agentName) || {};
    // A1.3：先查「我是不是本频道经理 / 频道里还有哪些 agent」——写进系统提示
    // （与 PTY 分支对齐）+ 追加进本回合语境行（8.5：系统提示只在 spawn 时读，
    // 首频道语境会漂，角色事实必须随回合走）。DM 无频道成员关系，跳过查询；
    // 查询失败（null）退回通用文案，不阻塞派发。
    const fetchCtx = opts.fetchDispatchContext ?? fetchDispatchContext;
    const dispatchContext = channelName.startsWith("dm:")
      ? null
      : await fetchCtx(opts.serverUrl, opts.apiKey, agentId, channelName);
    assertLive();
    // A1.3：回合级角色事实（当前频道）。发进 stream-json 的消息用它而非原始
    // userMsg；armTurnGuard 仍看原始文本（isNudge 探测不受影响）。
    const turnMsg = dispatchContext ? `${userMsg}\n\n${buildRoleContextLine(channelName, dispatchContext)}` : userMsg;

    // A5：mint / token 文件 / sysprompt / mcp 配置仅 spawn（新进程）时做——
    // 此前每个回合都跑一遍：一趟 mint server 往返 + sysprompt/token/mcp 三次
    // 文件写，全部浪费在复用路径上。常驻会话唯一的续期需求是 scoped token：
    // 服务端 TTL 24h，存活到余量 <1h 时重 mint 并覆写 token 文件即可——
    // slock-mcp-server 每次请求重读文件（readAgentToken），覆写即生效。
    const issuedAt = credentialIssuedAt.get(agentName);
    const tokenExpiringSoon =
      issuedAt === undefined || Date.now() - issuedAt > AGENT_CREDENTIAL_TTL_MS - AGENT_CREDENTIAL_REFRESH_MARGIN_MS;
    let promptFile: string | undefined;
    let workspace: string | undefined;
    let env: { SLOCK_AGENT_ID: string; SLOCK_AGENT_TOKEN_FILE: string; SLOCK_SERVER_URL: string } | undefined;
    // Phase 2：bridge initialize 载荷素材（claude 路径恒 undefined）
    let platformPrompt: string | undefined;
    let mcpDescriptor: import("./agent-runtime-driver.js").AgentRuntimeOpenOptions["mcp"];
    if (needsSpawn || tokenExpiringSoon) {
      // 见 PTY 分支的注释：服务端不认账号级 apiKey 之外的凭证要走 scoped
      // runtime token（幂等 upsert，覆盖上一条也无妨）。
      const runtimeToken = await mintAgentCredential(agentId);
      assertLive();
      // 复用路径下 workspace 已在 spawn 时建好——agentWorkspacePath 只拼路径不建目录
      const ws = needsSpawn ? createWorkspaceDir(agentName, info) : agentWorkspacePath(agentName);
      const tokenFile = writeAgentTokenFile(ws, runtimeToken);
      credentialIssuedAt.set(agentName, Date.now());
      if (needsSpawn) {
        workspace = ws;
        // O11：这条路径的 env 直接进子进程（runtime driver 的 spawn），
        // 只放 token 文件路径，不放明文 token。
        env = {
          SLOCK_AGENT_ID: agentId,
          SLOCK_AGENT_TOKEN_FILE: tokenFile,
          SLOCK_SERVER_URL: opts.serverUrl,
        };
        if (isBridge) {
          // Phase 2：bridge worker 走 SARP initialize——平台提示走文本字段
          // （runtime-neutral），MCP 走 initialize.platform.mcp 描述符由
          // worker 自己挂 client，不写 .mcp.json/.claude settings。
          platformPrompt = generateBridgeSystemPrompt(
            { name: agentName, displayName: info.displayName, description: info.description },
            dispatchContext,
          );
          try {
            const mcpBundlePath = await bundleSlockMcpServer();
            if (mcpBundlePath) {
              mcpDescriptor = {
                transport: "stdio",
                command: "node",
                args: [mcpBundlePath],
                env: {
                  SLOCK_AGENT_ID: agentId,
                  SLOCK_AGENT_TOKEN_FILE: tokenFile,
                  SLOCK_SERVER_URL: opts.serverUrl,
                },
              };
            }
          } catch (err) {
            console.warn(
              `[Daemon] @${agentName} MCP bundle resolve failed (bridge), worker runs without MCP: ${errMessage(err)}`,
            );
          }
        } else {
          // A3 起系统提示去频道化（不再有 channelName 参数）：频道/角色事实走
          // 回合消息尾的 buildRoleContextLine，避免 spawn 首频道语境漂移（§8.5）。
          promptFile = writeSystemPromptFile(agentName, true, info, dispatchContext);
          // MCP 工具接入（与 PTY 路径对齐，见 agent-runtime-spawn.ts）：headless
          // 路径此前漏写 .mcp.json——agent 没有 send_message MCP 工具，只能靠记住
          // `slock` CLI 命令回复；弱模型在受挫回合里会忘（2026-08-18 真机：天气
          // 查到了但纯文本作答结束回合，频道永远收不到）。失败不阻塞：CLI 兜底仍在。
          try {
            const mcpBundlePath = await bundleSlockMcpServer();
            if (mcpBundlePath) {
              writeMcpConfig(ws, agentId, env.SLOCK_AGENT_TOKEN_FILE ?? "", env.SLOCK_SERVER_URL ?? "", mcpBundlePath);
            }
          } catch (err) {
            console.warn(
              `[Daemon] @${agentName} MCP config setup failed (headless), CLI-only fallback: ${errMessage(err)}`,
            );
          }
        }
        assertLive();
      } else {
        console.log(`[Daemon] @${agentName} scoped agent token refreshed (TTL margin <1h)`);
      }
    }

    if (usePersistent) {
      // Phase 5：真要 spawn（而非复用存活会话）前过熔断器——worker 连续
      // 启动/生命周期失败达阈值后，冷却期内不再烧 spawn，直接 fail-closed。
      if (!persistentSessions.has(agentName) && !sessionCreates.has(agentName)) {
        const gate = opts.crashGuard?.check(agentName, runtimeProfile.identity);
        if (gate?.blocked) {
          throw new DispatchError(
            "worker-crash-loop",
            `[Daemon] @${agentName} worker crash-loop breaker open` +
              ` (${gate.consecutiveFailures} consecutive failures, retry in ~${Math.ceil((gate.retryAfterMs ?? 0) / 1000)}s)`,
            { retryAfterMs: gate.retryAfterMs },
          );
        }
      }
      // P1.12：创建加锁。mint/MCP 之后再 ensure，避免两个重叠的 deliver
      // 各 open 一个常驻会话，后写覆盖前写、旧实例永不 stop。
      let session: AgentRuntimeSession;
      try {
        session = await ensurePersistentSession(agentName, persistentSessions, sessionCreates, () =>
          // create 只在 map 无会话时执行（= needsSpawn），spawn-only 变量此时必已赋值
          runtimeDriver.openSession({
            agentName,
            mode: "persistent",
            cwd: workspace!,
            systemPromptFile: promptFile!,
            env: env!,
            label: "@" + agentName,
            // A1.1/Phase 1：模型以 resolved profile 为准（claude=档案所选；
            // bridge=manifest 校验后的 fixed/allowlist 值）。
            model: runtimeProfile.model,
            entrypoint: runtimeProfile.entrypoint,
            // Phase 2：bridge initialize 载荷（claude driver 忽略）
            agent: isBridge
              ? { id: agentId, name: agentName, displayName: info.displayName, description: info.description }
              : undefined,
            platformPrompt,
            mcp: mcpDescriptor,
            // A2：温启动——空闲回收 / daemon 重启后接回上次会话（sessionRef 由
            // stream handler 在 session init 事件时落 daemon-agent-sessions.json）。
            // SLOCK_SESSION_RESUME=0 关闭（与 PTY 同语义）；查不到 id = 全新会话。
            resumeSessionRef: envCfg.sessionResume ? agentSessionStore?.lookup(agentName)?.sessionId : undefined,
            // resume 宽限期早退 / 首事件 error = id 已失效——清掉避免
            // 每次 spawn 都再撞一次（驱动内部已换全新会话继续）。只清
            // 「还是这个 id」的记录：期间若已有更新的 sessionRef 落盘，
            // 无条件 forget 会误删新会话。
            onResumeFailed: (failedId) => {
              try {
                if (agentSessionStore?.lookup(agentName)?.sessionId === failedId) {
                  agentSessionStore.forget(agentName);
                }
              } catch {
                /* store 清理是旁路 */
              }
              console.warn(`[Daemon] @${agentName} dropped saved session ${failedId.slice(0, 8)} (resume failed)`);
            },
            onEvent: (ev) => handleStreamEvent(agentName, ev),
            // 当前进程崩溃 / 外部 kill：headless 下不会再有 turn.end 事件，状态机
            // 靠这个回调从 working 解封。沉默超时由 session.send reject → 下方
            // catch 解封，不走本回调（P0.1：迟到 onExit 会拆掉新回合的进度条）。
            onExit: () => {
              if (stateMachine.getState(agentName) === "working") {
                transitionState(agentName, "idle");
                idleReclaimer.touch(agentName);
                console.log(`[Daemon] @${agentName} persistent process exited mid-turn, state -> idle`);
              }
              abortTurnGuards(agentName, turnGuards, progressTurns, opts.onProgress);
            },
          }),
        );
      } catch (err) {
        // Phase 5：spawn/handshake 期失败（openSession 同步抛 / ready 拒绝）
        // 记熔断账——command-not-found / runtime-start-timeout / worker-exited 等。
        opts.crashGuard?.recordFailure(
          agentName,
          runtimeProfile.identity,
          err instanceof DispatchError ? err.code : undefined,
        );
        throw err;
      }
      // Phase 1：记录本次会话对应的 profile identity——下次复用/重推时判失效
      sessionIdentities.set(agentName, runtimeProfile.identity);
      if (!enterWorking(agentName, haltGen)) {
        dropStalePersistentSession(agentName, persistentSessions, session, forgetSessionCost, sessionIdentities);
        credentialIssuedAt.delete(agentName);
        throw new DispatchError("agent-stopped", `[Daemon] @${agentName} is stopped, cannot dispatch`);
      }
      if (persistentSessions.get(agentName) !== session) {
        releaseToIdle(agentName);
        throw new DispatchError("session-lost", `[Daemon] @${agentName} session was stopped during spawn`);
      }
      // 与 PTY 复用分支对齐：进入 working 后从空闲计时器摘掉，
      // 否则上一回合 touch 的倒计时会在本回合中途把常驻进程杀掉（P0.2）。
      idleReclaimer.untrack(agentName);
      armTurnGuard({
        agentName,
        channelName,
        userMsg,
        threadId,
        kind: opts.kind,
        turnGuards,
        progressTurns,
        createProgressPoster: opts.createProgressPoster,
        onProgress: opts.onProgress,
      });
      try {
        // 回合级交付：await 到 turn.end 事件（进程 mid-turn 退出则 reject → A1 队列
        // 退避重试，换 fresh 会话重投这条消息）。状态机回 idle 由 handleStreamEvent
        // 的 turn.end 分支负责（早于这里的 resolve，顺序无害）。
        const request: AgentTurnRequest = {
          turnId: opts.turn.turnId,
          conversationId: opts.turn.conversationId,
          attempt: opts.turn.attempt,
          prompt: turnMsg,
          source: {
            kind: opts.kind ?? "message",
            channel: channelName,
            threadId,
            ...(opts.turn.sender !== undefined ? { sender: opts.turn.sender } : {}),
          },
          resume: opts.turn.resume,
        };
        const turnResult = await session.send(request);
        // Phase 5：回合到达终态 = worker 健康——复位熔断计数（含 interrupted/
        // error 终态：worker 活着，失败在 provider/图内部，不是 crash）。
        opts.crashGuard?.recordSuccess(agentName, runtimeProfile.identity);
        // Phase 2（§11.4）：interrupt 簿记——interrupted 写 pending（resumeToken
        // 一次性，同 conversation 下条消息带它恢复）；resume 回合到达任何非
        // interrupted 终态都清 pending：token 已被 worker 消费（used=1），
        // 只在 success 删会留下死 token，下条消息带着它无限撞
        // PROTOCOL_VIOLATION（resume token rejected）。interrupted 由上面
        // put 覆写新 token，不进此分支。
        if (turnResult?.status === "interrupted" && turnResult.interrupt) {
          try {
            opts.interruptStore?.put({
              agentId,
              runtime: runtimeProfile.runtime,
              entrypoint: runtimeProfile.entrypoint,
              revision: runtimeProfile.manifestRevision,
              conversationId: opts.turn.conversationId,
              interruptId: turnResult.interrupt.interruptId,
              resumeToken: turnResult.interrupt.resumeToken,
              prompt: turnResult.interrupt.prompt,
              createdAt: Date.now(),
              expiresAt: 0,
            });
          } catch (err) {
            console.warn(`[Daemon] @${agentName} interrupt persist failed:`, errMessage(err));
          }
        } else if (opts.turn.resume) {
          try {
            opts.interruptStore?.delete(agentId, opts.turn.conversationId);
          } catch {
            /* store 清理是旁路 */
          }
          if (turnResult?.status !== "success") {
            console.warn(
              `[Daemon] @${agentName} resume turn ended ${turnResult?.status ?? "?"} — ` +
                `cleared consumed pending interrupt for ${opts.turn.conversationId}`,
            );
          }
        }
      } catch (err) {
        // P1.12：send 失败后踢掉本实例。否则下一条以为无需 spawn，
        // 直接对死/停过的实例 send（Fake 不会自愈；真驱动虽能 respawn
        // 但 env/onExit 仍是失败那次的）。
        dropStalePersistentSession(agentName, persistentSessions, session, forgetSessionCost, sessionIdentities);
        credentialIssuedAt.delete(agentName);
        // resume 回合 send 抛错：turn.start 已送达 worker 即意味着 token
        // 可能被 consume（worker 死在 resume 中途 = token 烧掉没终态）。
        // 清掉 pending 防止死 token 循环；若 turn.start 其实没送达，
        // 代价只是放弃一次 resume，不会出错。
        if (opts.turn.resume) {
          try {
            opts.interruptStore?.delete(agentId, opts.turn.conversationId);
          } catch {
            /* store 清理是旁路 */
          }
        }
        // Phase 5：记熔断账——spawn/生命周期类失败码累计，provider 类不计。
        opts.crashGuard?.recordFailure(
          agentName,
          runtimeProfile.identity,
          err instanceof DispatchError ? err.code : undefined,
        );
        throw err;
      }
      console.log(`[Daemon] @${agentName} turn finished (persistent)`);
    } else {
      if (!enterWorking(agentName, haltGen)) {
        throw new DispatchError("agent-stopped", `[Daemon] @${agentName} is stopped, cannot dispatch`);
      }
      armTurnGuard({
        agentName,
        channelName,
        userMsg,
        threadId,
        kind: opts.kind,
        turnGuards,
        progressTurns,
        createProgressPoster: opts.createProgressPoster,
        onProgress: opts.onProgress,
      });
      // Phase 1：续接引用只在「与上次同 identity」时才用——profile/manifest
      // 变化后旧 sessionId 不应续接（语义已变）。
      const sid =
        sessionIdentities.get(agentName) === runtimeProfile.identity
          ? threadId
            ? (threadSessions?.lookup(agentName, threadId)?.sessionId ?? agentSessions.get(agentName))
            : agentSessions.get(agentName)
          : undefined;
      // one-shot 下 needsSpawn 恒真，spawn-only 变量必已赋值
      const session = runtimeDriver.openSession({
        agentName,
        mode: "oneshot",
        cwd: workspace!,
        systemPromptFile: promptFile!,
        env: env!,
        label: "@" + agentName,
        model: runtimeProfile.model,
        entrypoint: runtimeProfile.entrypoint,
        resumeSessionRef: sid,
        onEvent: (ev) => handleStreamEvent(agentName, ev),
      });
      const turnResult = await session.send({
        turnId: opts.turn.turnId,
        conversationId: opts.turn.conversationId,
        attempt: opts.turn.attempt,
        prompt: turnMsg,
        source: {
          kind: opts.kind ?? "message",
          channel: channelName,
          threadId,
          ...(opts.turn.sender !== undefined ? { sender: opts.turn.sender } : {}),
        },
        resume: opts.turn.resume,
      });
      if (turnResult?.sessionRef) {
        agentSessions.set(agentName, turnResult.sessionRef);
        sessionIdentities.set(agentName, runtimeProfile.identity);
        if (threadId) threadSessions?.remember(agentName, threadId, turnResult.sessionRef);
      }
      console.log(`[Daemon] @${agentName} turn finished (one-shot)`);
      releaseToIdle(agentName);
      // one-shot 不留常驻进程，无需 touch；显式 untrack 以免上一路径残留计时。
      idleReclaimer.untrack(agentName);
    }
  } catch (err) {
    releaseToIdle(agentName);
    idleReclaimer.touch(agentName);
    abortTurnGuards(agentName, turnGuards, progressTurns, opts.onProgress);
    console.error("[Daemon] dispatchToAgent failed:", errMessage(err));
    throw err;
  }
};
