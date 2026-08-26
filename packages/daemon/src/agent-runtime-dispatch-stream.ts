import {
  type CostGateDecision,
  type createSessionCostDelta,
  extractResultMetrics,
  type ICostTracker,
} from "./agent-cost-tracker.js";
import { type createSeqAllocator, type ObservationBus, streamEventToFrames } from "./agent-observation.js";
import { createProgressTurn, type ProgressTurn } from "./agent-progress.js";
import type { IAgentStateMachine } from "./agent-runtime-state.js";
import type { IThreadSessionStore } from "./agent-thread-sessions.js";
import type { ClaudeStreamEvent } from "./claude-stream.js";
import { loadDaemonEnv } from "./config.js";
import { errMessage } from "./errors.js";
import type { IIdleReclaimer } from "./idle-reclaimer.js";

/** 回复守卫追问前缀：isNudge 防止追问本身再触发追问 */
export const REPLY_GUARD_PREFIX = "[slock-reply-guard]";

export interface TurnGuard {
  channel: string;
  hadSend: boolean;
  isNudge: boolean;
  /** 本回合最后一段正文（text 帧）——回合结束未发送时由 daemon 直接代发 */
  lastText?: string;
  /** D1/D2：本回合所属线程（无则顶层/DM/巡检） */
  threadId?: string;
  /** D4：本回合频道内进度条 */
  progress?: ProgressTurn;
}

export type SessionCostDelta = ReturnType<typeof createSessionCostDelta>;

export interface StreamTurnHandlerOpts {
  observationBus?: ObservationBus;
  onToolCall?: (
    agentName: string,
    info: { toolName?: string; toolUseId?: string; status: "pending" | "completed"; text?: string },
  ) => void;
  onReplyMissing?: (agentName: string, channel: string, content: string) => void;
  onProgress?: (agentName: string, channelName: string, headline: string, phase: "start" | "update" | "end") => void;
  costTracker?: ICostTracker;
  threadSessions?: IThreadSessionStore;
  sessionCostDelta: SessionCostDelta;
  obsSeq: ReturnType<typeof createSeqAllocator>;
  turnGuards: Map<string, TurnGuard>;
  progressTurns: Map<string, ProgressTurn>;
  stateMachine: IAgentStateMachine;
  idleReclaimer: IIdleReclaimer;
  resolveAgentId: (agentName: string) => string | null;
  /** 回复守卫追问：由 createDispatch 晚绑定到 dispatchToAgent，避免循环定义 */
  nudge: (agentName: string, channel: string, msg: string) => void;
}

export const isSendToolFrame = (frame: { payload: { toolName?: string; text?: string } }): boolean => {
  const name = frame.payload.toolName ?? "";
  if (name.includes("send_message")) return true; // mcp__slock__send_message
  // CLI 兜底路径：Bash 里跑 slock message send
  if (name === "Bash" && (frame.payload.text ?? "").includes("slock message send")) return true;
  return false;
};

/** onExit / doDispatch catch：拆掉本回合进度条与守卫，不走回复守卫代发 */
export const abortTurnGuards = (
  agentName: string,
  turnGuards: Map<string, TurnGuard>,
  progressTurns: Map<string, ProgressTurn>,
  onProgress?: (agentName: string, channelName: string, headline: string, phase: "start" | "update" | "end") => void,
): void => {
  const g = turnGuards.get(agentName);
  turnGuards.delete(agentName);
  progressTurns.delete(agentName);
  void g?.progress?.abort();
  if (g) {
    try {
      onProgress?.(agentName, g.channel, "", "end");
    } catch {
      /* ignore */
    }
  }
};

/** 回复守卫登记（headless persistent）：本回合结束时检查是否有 send_message */
export const armTurnGuard = (opts: {
  agentName: string;
  channelName: string;
  userMsg: string;
  threadId?: string;
  turnGuards: Map<string, TurnGuard>;
  progressTurns: Map<string, ProgressTurn>;
  createProgressPoster?: (agentName: string) => import("./agent-progress.js").ProgressPoster;
  onProgress?: (agentName: string, channelName: string, headline: string, phase: "start" | "update" | "end") => void;
}): void => {
  const { agentName, channelName, userMsg, threadId, turnGuards, progressTurns } = opts;
  const isNudge =
    userMsg.startsWith(REPLY_GUARD_PREFIX) ||
    userMsg.startsWith("【频道分诊】") ||
    userMsg.startsWith("【定时巡检】") ||
    userMsg.includes("【频道分诊】") ||
    userMsg.includes("【定时巡检】");
  const progress = createProgressTurn({
    agentName,
    channel: channelName,
    threadId,
    // 分诊/巡检不往频道写进度条（沉默是合法产出），仍推顶栏；
    // SLOCK_CHANNEL_PROGRESS=0 关频道进度（顶栏仍走 onHeadline）。
    enabled: !isNudge && loadDaemonEnv().channelProgress,
    poster: opts.createProgressPoster?.(agentName) ?? {
      async post() {
        return undefined;
      },
      async edit() {
        return false;
      },
      async remove() {
        return false;
      },
    },
    onHeadline: (headline) => {
      try {
        opts.onProgress?.(agentName, channelName, headline, "update");
      } catch {
        /* ignore */
      }
    },
  });
  try {
    opts.onProgress?.(agentName, channelName, "思考", "start");
  } catch {
    /* ignore */
  }
  const guard: TurnGuard = {
    channel: channelName,
    hadSend: false,
    threadId,
    isNudge,
    progress,
  };
  turnGuards.set(agentName, guard);
  progressTurns.set(agentName, progress);
};

/**
 * B1/C1：persistent 路径的 stream-json 事件处理——发布观察帧 + 工具审计 + 精确回合边界。
 * 含回复守卫判定（代发 / 追问一次）与 D3 成本差值落库。
 */
export const createStreamTurnHandler = (
  opts: StreamTurnHandlerOpts,
): ((agentName: string, ev: ClaudeStreamEvent) => void) => {
  const {
    observationBus,
    onToolCall,
    onReplyMissing,
    onProgress,
    costTracker,
    threadSessions,
    sessionCostDelta,
    obsSeq,
    turnGuards,
    progressTurns,
    stateMachine,
    idleReclaimer,
    resolveAgentId,
    nudge,
  } = opts;
  const { transitionState } = stateMachine;

  return (agentName: string, ev: ClaudeStreamEvent): void => {
    const bus = observationBus;
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
            onToolCall?.(agentName, {
              toolName: frame.payload.toolName,
              toolUseId: frame.payload.toolUseId,
              status: frame.kind === "tool_use" ? "pending" : "completed",
              text: frame.payload.text,
            });
          } catch {
            /* 审计旁路不阻塞主链路 */
          }
        }
        // D4：节流聚合进频道进度条（分诊/巡检 isNudge 不写频道，但仍推顶栏）
        try {
          (progressTurns.get(agentName) ?? turnGuards.get(agentName)?.progress)?.note(frame);
        } catch {
          /* 进度旁路不阻塞 */
        }
      }
    }
    // D3 / P0.5：result.total_cost_usd 是会话累计，落库前换成相对上次的增量。
    // duration_ms / num_turns 是本回合值，原样累加。无 tracker 时跳过。
    // 必须在 turnGuards.delete 之前取 channel。
    if (ev.type === "result") {
      try {
        const metrics = extractResultMetrics(ev);
        if (metrics && costTracker) {
          const guard = turnGuards.get(agentName);
          const channel = guard?.channel ?? "unknown";
          costTracker.recordTurn({
            agentName,
            agentId: resolveAgentId(agentName),
            channel,
            threadId: guard?.threadId,
            costUsd: sessionCostDelta.next(agentName, metrics.costUsd),
            durationMs: metrics.durationMs,
            numTurns: metrics.numTurns,
          });
        }
      } catch (err) {
        console.warn(`[Daemon] @${agentName} cost record failed:`, errMessage(err));
      }
    }
    // D2：system init 带 session_id 时记下本回合 thread 的亲和（无 thread 则跳过）。
    if (ev.type === "system" && typeof ev.session_id === "string" && ev.session_id) {
      const tid = turnGuards.get(agentName)?.threadId;
      if (tid) {
        try {
          threadSessions?.remember(agentName, tid, ev.session_id);
        } catch (err) {
          console.warn(`[Daemon] @${agentName} thread-session remember failed:`, errMessage(err));
        }
      }
    }
    // stream-json 的 result 事件即精确回合边界（替代 PTY 路径的 ❯ 启发式）：
    // 回合结束立刻回 idle，终端面板的状态列/空闲回收都靠这个状态。
    if (ev.type === "result" && stateMachine.getState(agentName) === "working") {
      transitionState(agentName, "idle");
      idleReclaimer.touch(agentName);
      console.log(`[Daemon] @${agentName} round-end (stream-json result)`);

      // 回复守卫判定：整回合没有发送动作且不是追问本身 → 优先代发，其次追问
      const guard = turnGuards.get(agentName);
      turnGuards.delete(agentName);
      progressTurns.delete(agentName);
      void (async () => {
        let rewritten = false;
        if (guard?.progress) {
          const answer = !guard.hadSend && !guard.isNudge ? guard.lastText?.trim() : undefined;
          try {
            const fin = await guard.progress.finish({
              hadSend: guard.hadSend || guard.isNudge,
              rewrite: answer || undefined,
            });
            rewritten = fin.rewritten;
          } catch {
            /* 进度收尾失败不阻断回复守卫 */
          }
          try {
            onProgress?.(agentName, guard.channel, "", "end");
          } catch {
            /* ignore */
          }
        }
        if (guard && !guard.hadSend && !guard.isNudge && loadDaemonEnv().replyGuard) {
          const answer = guard.lastText?.trim();
          if (answer && rewritten) {
            console.warn(
              `[Daemon] @${agentName} reply-guard: reused progress message as final reply (${answer.length} chars)`,
            );
          } else if (answer && onReplyMissing) {
            console.warn(
              `[Daemon] @${agentName} reply-guard: turn ended without send_message, auto-posting final text (${answer.length} chars)`,
            );
            try {
              onReplyMissing(agentName, guard.channel, answer);
            } catch {
              /* 代发失败走 console，不再追问 */
            }
          } else if (!answer) {
            console.warn(
              `[Daemon] @${agentName} reply-guard: turn ended without send_message and no text, nudging once`,
            );
            const nudgeMsg =
              `${REPLY_GUARD_PREFIX} 系统检测到你上一个回合没有调用 send_message（或 slock message send）——` +
              `你直接打的字不会送到频道，对方还在等回复。请现在把上一条问题的答案用 ` +
              `\`mcp__slock__send_message\`（target="${guard.channel}"）补发出去。` +
              `（触发于 ${new Date().toISOString()}）`;
            nudge(agentName, guard.channel, nudgeMsg);
          }
        }
      })();
    }
  };
};

/** 仅供类型收口：熔断通知签名与主文件共用 */
export type NotifyCircuitBreak = (agentName: string, channelName: string, gate: CostGateDecision) => void;
