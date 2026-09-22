/**
 * EventQueue 式派发队列（改造方案 A1，见 docs/2026-08-18/03-slock-modification-plan.md §1.A1）。
 *
 * 替代旧的「即派即忘 + dispatchPromises 单链缓冲」：旧实现里 PTY 写入失败后消息
 * 只有一行 console.error 就丢了，也没有「同一条消息被重复派发」的防护。本模块
 * 对齐 buzz buzz-acp/queue.rs 的纪律：
 * - per-agent 串行排空（同一 agent 任一时刻只有一批 in-flight——
 *   PersistentClaude 单会话串行回合 + 回复守卫按 agent 键控，并发回合会串台）
 * - A4：pending 按 (channel, thread, kind) 分桶——合并只在同桶内发生，
 *   跨频道/跨线程/分诊与 @ 绝不拼进同一批（此前合并批取 items[0] 的频道
 *   投递，会把 B 频道的消息错投到 A 频道）
 * - A4/§8.13⑦：in-flight 超时不再判失败重投——deliver 是回合级 promise，
 *   超时大概率是回合还在真跑，重投会产生第二个回合共用 session/守卫
 *   （实测连锁：守卫串台代发 + 重复回合 + 成本记到 unknown channel）。
 *   超时只告警并继续等真实 settle；真正的看门狗是驱动层 300s 沉默超时，
 *   进程死了 deliver 会真 reject，那时重试才是安全的。
 * - 指数退避 + jitter 重试（合并批按最高 attempts 定速），耗尽进死信回调上报
 * - dedup：窗口期内同桶同内容去重（平台重复派发/网络重发防护）。
 *   A4 去重后写：只在投递成功后记录——死信/丢弃不占窗口，重发不被吞
 * - 忙碌合并：排空时把同桶积压的多条 pending 合并为一条复合 prompt 一次投递
 *   （对齐 buzz 的批量合并重提示；agent 反正是一个回合处理，合并省一次唤醒）
 *
 * 纯内存实现——daemon 重启即清空。重启丢失的消息由 server 侧的未读/mention
 * 机制兜底（agent 上线后 bootstrap 会拉取），队列不做持久化，避免双写一致性坑。
 */

import { loadDaemonEnv } from "./config.js";
import { DispatchError, errMessage, isDispatchError, isRetriableError } from "./errors.js";

/**
 * A4：kind 语义化——入桶判别（triage/nudge/reminder 不与 message 合并）并随
 * item 传到 armTurnGuard（守卫按 kind 判 isNudge，不再只靠 prompt 前缀嗅探）。
 * "dispatch" 保留给经理派单路径。
 */
export type DispatchKind = "message" | "reminder" | "dispatch" | "triage" | "nudge";

export interface DispatchQueueItem {
  id: string;
  agentName: string;
  channelName: string;
  kind: DispatchKind;
  /** 完整待发文本（不含 reminder tail——tail 由投递执行器在合并后统一追加） */
  content: string;
  enqueuedAt: number;
  attempts: number;
  /** D1/D2：本条所属线程（合并批次取第一项） */
  threadId?: string;
  /**
   * Phase 2（§8.4）：回合 turnId——首次入队生成，A1 退避重投复用同一
   * turnId（幂等锚，worker/SDK 可按它去重），attempt 取 attempts+1。
   * 合并批次用 items[0] 的 turnId。
   */
  turnId: string;
  /** Phase 2（§11.1）：reminder 等带来源稳定 ID（ReminderFirePayload.id），conversationId 分桶用 */
  sourceId?: string;
  /** Phase 2（§8.4）：人类发送者名——bridge worker 的 turn.start source.sender */
  sender?: string;
}

/** 投递执行器：items 长度 >1 时表示合并投递。失败必须 reject，队列据此重试。 */
export type DispatchDeliverFn = (agentName: string, items: DispatchQueueItem[]) => Promise<void>;

export interface DispatchQueueOptions {
  deliver: DispatchDeliverFn;
  /**
   * in-flight 告警阈值（默认 6min，SLOCK_DISPATCH_INFLIGHT_MS 覆盖）。
   * A4：超时只打「仍在跑」告警并继续等 deliver 真实 settle，不重投——
   * 回合级 deliver 超时几乎总是进程还在跑，重投会制造重复回合。
   */
  inflightMs?: number;
  /** 退避基数（默认 1000ms），封顶 maxDelayMs（默认 30000ms），±20% jitter */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 最大尝试次数（默认 3，SLOCK_DISPATCH_MAX_RETRIES 覆盖），耗尽进死信 */
  maxRetries?: number;
  /** dedup 窗口（默认 15000ms）。窗口内同 agent 同 content 的入队被吞掉 */
  dedupWindowMs?: number;
  /** 返回 false 时入队即死信（如 agent stopped / 无 agentId——重试无意义的永久失败） */
  isDeliverable?: (agentName: string) => boolean;
  /**
   * P0.6：投递前闸门（如成本熔断）。每次 drain 出队前重新评估——入队时放行、
   * 排空时已熔断的积压/退避消息在此被拦下丢弃（不投递、不重试：熔断条件
   * 短期内不会自愈，重试只会空转退避）。
   */
  deliveryGate?: (agentName: string) => { blocked: boolean; reason?: string };
  onQueued?: (agentName: string, item: DispatchQueueItem) => void;
  /** 一批 pending 被合并为一次投递时回调（items 即合并的那批） */
  onMerged?: (agentName: string, items: DispatchQueueItem[]) => void;
  onRetry?: (agentName: string, item: DispatchQueueItem, err: unknown, nextDelayMs: number) => void;
  onDeadLetter?: (agentName: string, item: DispatchQueueItem, err: unknown) => void;
  /** P0.6：drain 时被 deliveryGate 拦下的批次（已 settle，不会再投递） */
  onDeliveryBlocked?: (agentName: string, items: DispatchQueueItem[], reason: string) => void;
  onDelivered?: (agentName: string, items: DispatchQueueItem[]) => void;
  /** 测试注入时钟 */
  now?: () => number;
}

export type EnqueueStatus =
  | { status: "queued"; item: DispatchQueueItem; done: Promise<void> }
  | { status: "deduped" }
  | { status: "dead"; err: unknown };

export interface AgentDispatchQueue {
  enqueue(input: {
    agentName: string;
    channelName: string;
    content: string;
    kind?: DispatchQueueItem["kind"];
    threadId?: string;
    /** Phase 2：reminder 等带来源稳定 ID（conversationId 分桶用） */
    sourceId?: string;
    /** Phase 2：人类发送者名（turn.start source.sender） */
    sender?: string;
  }): EnqueueStatus;
  /** 指定 agent（或全部）的 pending 数量（跨桶合计） */
  depth(agentName?: string): number;
  /** 该 agent 是否有在途/积压/退避中的投递（决定要不要提示「已缓冲」） */
  isBusy(agentName: string): boolean;
  /** 丢弃某 agent 的全部 pending（agent 被删除/停止时用），返回丢弃条数 */
  clear(agentName: string): number;
  /** 清掉所有定时器（daemon 关闭时调） */
  dispose(): void;
}

let nextId = 1;
let nextTurnId = 1;
// §15.4：turnId 是 worker journal 幂等键，必须跨 daemon 重启唯一——纯进程
// 计数器重启归零会让新回合撞上历史终态（replay 旧 error/success/interrupted，
// 图根本不跑；实机事故 2026-09-22）。boot nonce 隔离命名空间，队列内 retry
// 仍复用 item.turnId（同一逻辑回合幂等语义不变）。
const turnBootNonce = `b${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** A4：(channel, thread, kind) 分桶——合并/去重/重试都在同桶内进行 */
interface BucketState {
  pending: DispatchQueueItem[];
  /** 本桶在途批次的 content 集——去重窗口覆盖在途期（同内容重发仍吞掉） */
  inflight: Set<string>;
  /**
   * content → 最近一次投递成功时间戳（dedup 窗口判定用）。
   * A4 去重后写：只在真投递成功时记录——死信/被 clear 丢弃的消息不占
   * 窗口，同内容重发不会被吞（§8.13 验收「死信后重发不被吞」）。
   */
  recentContents: Map<string, number>;
}

interface AgentQueueState {
  /** key = `${channel}\0${thread ?? ""}\0${kind}`；桶按创建顺序保存 */
  buckets: Map<string, BucketState>;
  draining: boolean;
  /** 退避中的唤醒定时器；非 null 表示还没到下一次排空时机 */
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** in-flight 告警定时器（仅日志，不 settle） */
  inflightTimer: ReturnType<typeof setTimeout> | null;
  /** P0.3：clear/dispose 递增；in-flight 失败后若 epoch 变了则不再重试 */
  epoch: number;
}

export const createAgentDispatchQueue = (opts: DispatchQueueOptions): AgentDispatchQueue => {
  const now = opts.now ?? (() => Date.now());
  // env 在 create 时解析一次（队列参数运行期变更没有场景；测试直接传 options 覆盖）。
  // P1.10：默认走 config.ts。生产路径（createDispatch）也会显式传入 inflightMs /
  // maxRetries，与 loadDaemonEnv 默认值一致。
  const envCfg = loadDaemonEnv();
  const inflightMs = opts.inflightMs ?? envCfg.dispatchInflightMs;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const maxDelayMs = opts.maxDelayMs ?? 30000;
  const maxRetries = opts.maxRetries ?? envCfg.dispatchMaxRetries;
  const dedupWindowMs = opts.dedupWindowMs ?? 15000;

  const states = new Map<string, AgentQueueState>();
  /**
   * item.id → 完成通知。dispatchToAgent 的调用方（runAgent 等）历来
   // 「await 到投递完成（含失败被吞）」——保留这个语义：delivered 和
   // dead-letter 都 resolve（不 reject），错误走 onDeadLetter 回调。
   */
  const doneResolvers = new Map<string, () => void>();
  const settleDone = (item: DispatchQueueItem): void => {
    const r = doneResolvers.get(item.id);
    if (r) {
      doneResolvers.delete(item.id);
      r();
    }
  };
  const stateOf = (agentName: string): AgentQueueState => {
    let s = states.get(agentName);
    if (!s) {
      s = { buckets: new Map(), draining: false, retryTimer: null, inflightTimer: null, epoch: 0 };
      states.set(agentName, s);
    }
    return s;
  };

  const bucketKeyOf = (input: { channelName: string; threadId?: string; kind: DispatchKind }): string =>
    `${input.channelName}\0${input.threadId ?? ""}\0${input.kind}`;

  const bucketOf = (s: AgentQueueState, key: string): BucketState => {
    let b = s.buckets.get(key);
    if (!b) {
      b = { pending: [], inflight: new Set(), recentContents: new Map() };
      s.buckets.set(key, b);
    }
    return b;
  };

  const hasPending = (s: AgentQueueState): boolean => {
    for (const b of s.buckets.values()) if (b.pending.length > 0) return true;
    return false;
  };

  /** 取头部 enqueuedAt 最早的非空桶——跨频道/线程按到达顺序公平排空 */
  const pickBucket = (s: AgentQueueState): string | null => {
    let best: string | null = null;
    let bestAt = Number.POSITIVE_INFINITY;
    for (const [key, b] of s.buckets) {
      const head = b.pending[0];
      if (head && head.enqueuedAt < bestAt) {
        bestAt = head.enqueuedAt;
        best = key;
      }
    }
    return best;
  };

  const safe = (fn: (() => void) | undefined): void => {
    if (!fn) return;
    try {
      fn();
    } catch {
      /* 回调抛错不阻断队列 */
    }
  };

  /** 第 attempt 次失败后的退避时长：base * 2^(attempt-1)，封顶 maxDelay，±20% jitter */
  const backoff = (attempt: number): number => {
    const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.round(exp * jitter);
  };

  /** dedup 窗口清理：惰性——只在入队判定时顺便清过期项，不开后台定时器 */
  const pruneRecent = (b: BucketState): void => {
    const cutoff = now() - dedupWindowMs;
    for (const [k, ts] of b.recentContents) {
      if (ts < cutoff) b.recentContents.delete(k);
    }
  };

  /** 丢弃一组 item：settle + 可选死信回调（A4：clear/gate 丢弃不静默） */
  const discardPending = (
    agentName: string,
    items: DispatchQueueItem[],
    err: unknown,
    notify: "dead-letter" | "silent",
  ): void => {
    for (const item of items) {
      settleDone(item); // 丢弃也算完结，await 方不挂住
      if (notify === "dead-letter") safe(() => opts.onDeadLetter?.(agentName, item, err));
    }
  };

  const drain = (agentName: string): void => {
    const s = stateOf(agentName);
    if (s.draining || s.retryTimer) return;
    const bucketKey = pickBucket(s);
    if (bucketKey === null) return;
    const bucket = s.buckets.get(bucketKey)!;

    // P0.6：投递前闸门（成本熔断）。入队时 gate 可能还没触发（预算在积压/
    // 退避期间被耗尽），所以每次真正出队投递前重新评估；被拦的批次直接
    // 丢弃完结——熔断当天不会自愈，重试只是空转退避。熔断是 agent 级，
    // 所有桶的 pending 一并拦下。
    const gate = opts.deliveryGate?.(agentName);
    if (gate?.blocked) {
      const reason = gate.reason ?? "delivery gate blocked";
      const blocked: DispatchQueueItem[] = [];
      for (const b of s.buckets.values()) blocked.push(...b.pending.splice(0, b.pending.length));
      console.warn(`[DispatchQueue] @${agentName} ${blocked.length} queued message(s) blocked: ${reason}`);
      discardPending(agentName, blocked, new DispatchError("agent-stopped", reason), "silent");
      safe(() => opts.onDeliveryBlocked?.(agentName, blocked, reason));
      return;
    }

    s.draining = true;
    const epoch = s.epoch;

    // 忙碌合并：一次取走同桶全部 pending 作为一批投递（A4：绝不跨桶合并——
    // 不同频道/线程/kind 的消息不拼进同一回合，target 由桶唯一确定）。
    const batch = bucket.pending.splice(0, bucket.pending.length);
    for (const item of batch) bucket.inflight.add(item.content);
    if (batch.length > 1) safe(() => opts.onMerged?.(agentName, batch));

    // A4/§8.13⑦：in-flight 超时只告警、继续等真实 settle——回合级 deliver
    // 超时几乎总是进程还在真跑（长任务有心跳续命，300s 沉默才是真正的卡死
    // 边界）。此时重投会起第二个回合共用 session/守卫（实测：守卫串台代发 +
    // 重复回合 + 成本记 unknown channel）。进程真死了 deliver 会 reject，
    // 那时按失败重试是安全的——没有真在跑的回合可串台。
    let settled = false;
    s.inflightTimer = setTimeout(() => {
      s.inflightTimer = null;
      if (!settled) {
        console.warn(
          `[DispatchQueue] @${agentName} dispatch in-flight >${inflightMs}ms — turn still running, waiting for real settle (no re-dispatch)`,
        );
      }
    }, inflightMs);
    const finishInflight = (): void => {
      for (const item of batch) bucket.inflight.delete(item.content);
    };

    opts
      .deliver(agentName, batch)
      .then(() => {
        settled = true;
        if (s.inflightTimer) {
          clearTimeout(s.inflightTimer);
          s.inflightTimer = null;
        }
        finishInflight();
        // P0.3/A4：clear/stop 之后迟到的成功不回写 dedup 记录、不发 onDelivered
        if (s.epoch !== epoch) {
          for (const item of batch) settleDone(item);
          return;
        }
        const t = now();
        for (const item of batch) {
          // A4 去重后写：只在真实投递成功时记录 dedup 窗口
          bucket.recentContents.set(item.content, t);
          settleDone(item);
        }
        safe(() => opts.onDelivered?.(agentName, batch));
      })
      .catch((err) => {
        settled = true;
        if (s.inflightTimer) {
          clearTimeout(s.inflightTimer);
          s.inflightTimer = null;
        }
        finishInflight();
        // P0.3：stop/unregister/dispose 之后不再把 in-flight 失败批次塞回 pending
        if (s.epoch !== epoch) {
          for (const item of batch) settleDone(item);
          return;
        }
        if (opts.isDeliverable && !opts.isDeliverable(agentName)) {
          discardPending(agentName, batch, err, "dead-letter");
          return;
        }
        // P1.14：显式标注 retriable=false 的 DispatchError（agent stopped /
        // 无 agentId / 会话被换）重试无意义，首次失败即死信，不空转退避。
        // 未分类的普通 Error 由 isRetriableError 视为可重试，保持既有行为。
        if (!isRetriableError(err)) {
          console.error(
            `[DispatchQueue] @${agentName} ${batch.length} message(s) dead-lettered (non-retriable ${errMessage(err)})`,
          );
          discardPending(agentName, batch, err, "dead-letter");
          return;
        }
        const retryable: DispatchQueueItem[] = [];
        const dead: DispatchQueueItem[] = [];
        for (const item of batch) {
          item.attempts += 1;
          if (item.attempts >= maxRetries) dead.push(item);
          else retryable.push(item);
        }
        if (dead.length > 0) {
          // 死信：回调上报，由上层（daemon-core → WS → server）决定如何呈现，
          // 队列自己不再持有这条消息。
          console.error(
            `[DispatchQueue] @${agentName} ${dead.length} message(s) dead-lettered after ${maxRetries} attempts:`,
            errMessage(err),
          );
          discardPending(agentName, dead, err, "dead-letter");
        }
        if (retryable.length > 0) {
          // A4：合并批按最高 attempts 定速——最新鲜的条目不许给最失败的条目加速。
          // §15.2：worker 声明的 retryAfterMs（如 MODEL_RATE_LIMITED）取与
          // 指数退避的较大值，再钳制到 maxDelayMs——防止 worker 无限放大等待。
          const declared = isDispatchError(err) && typeof err.retryAfterMs === "number" ? err.retryAfterMs : 0;
          const delay = Math.min(
            maxDelayMs,
            Math.max(backoff(Math.max(...retryable.map((i) => i.attempts))), declared),
          );
          for (const item of retryable) safe(() => opts.onRetry?.(agentName, item, err, delay));
          // 重回本桶队首（保持原始相对顺序），退避结束后继续排空
          bucket.pending.unshift(...retryable);
          s.retryTimer = setTimeout(() => {
            s.retryTimer = null;
            drain(agentName);
          }, delay);
        }
      })
      .finally(() => {
        s.draining = false;
        // settle 后若期间有新消息入队（任意桶），继续排空
        if (hasPending(s) && !s.retryTimer) drain(agentName);
      });
  };

  return {
    enqueue(input) {
      const { agentName } = input;
      const kind = input.kind ?? "message";
      // 永久失败快速通道：agent 已停止/无 id 时重试无意义，直接死信
      if (opts.isDeliverable && !opts.isDeliverable(agentName)) {
        const err = new DispatchError("agent-stopped", `@${agentName} not deliverable (stopped or unknown agent)`);
        const item: DispatchQueueItem = {
          id: `dq-${nextId++}`,
          agentName,
          channelName: input.channelName,
          kind,
          content: input.content,
          enqueuedAt: now(),
          attempts: maxRetries,
          threadId: input.threadId,
          turnId: `turn-${turnBootNonce}-${nextTurnId++}`,
          sourceId: input.sourceId,
          sender: input.sender,
        };
        safe(() => opts.onDeadLetter?.(agentName, item, err));
        return { status: "dead", err };
      }

      const s = stateOf(agentName);
      const bucket = bucketOf(s, bucketKeyOf({ channelName: input.channelName, threadId: input.threadId, kind }));
      pruneRecent(bucket);
      // dedup：同桶窗口内见过同内容（投递成功的 recentContents + 仍在 pending
      // 的 + 在途批次的）——平台重复派发防护。去重后写：死信/丢弃不写
      // recentContents，同内容重发不被吞。
      // 代价是「用户 15s 内连发两条一模一样的消息」会被吞一条，可接受：
      // 正常人类/agent 对话极少逐字重复，而重复派发的危害（agent 干两遍活）更大。
      if (
        bucket.recentContents.has(input.content) ||
        bucket.inflight.has(input.content) ||
        bucket.pending.some((p) => p.content === input.content)
      ) {
        return { status: "deduped" };
      }

      const item: DispatchQueueItem = {
        id: `dq-${nextId++}`,
        agentName,
        channelName: input.channelName,
        kind,
        content: input.content,
        enqueuedAt: now(),
        attempts: 0,
        threadId: input.threadId,
        turnId: `turn-${turnBootNonce}-${nextTurnId++}`,
        sourceId: input.sourceId,
        sender: input.sender,
      };
      const done = new Promise<void>((r) => doneResolvers.set(item.id, r));
      bucket.pending.push(item);
      safe(() => opts.onQueued?.(agentName, item));
      drain(agentName);
      return { status: "queued", item, done };
    },

    depth(agentName) {
      const count = (s: AgentQueueState | undefined): number => {
        if (!s) return 0;
        let n = 0;
        for (const b of s.buckets.values()) n += b.pending.length;
        return n;
      };
      if (agentName !== undefined) return count(states.get(agentName));
      let n = 0;
      for (const s of states.values()) n += count(s);
      return n;
    },

    isBusy(agentName) {
      const s = states.get(agentName);
      if (!s) return false;
      return s.draining || s.retryTimer !== null || hasPending(s);
    },

    clear(agentName) {
      const s = states.get(agentName);
      if (!s) return 0;
      s.epoch += 1;
      let n = 0;
      // A4：丢弃走死信回调——频道侧能看到「消息未送达」而非无声消失
      const err = new DispatchError("agent-stopped", `@${agentName} queue cleared (stop/unregister)`);
      for (const b of s.buckets.values()) {
        n += b.pending.length;
        discardPending(agentName, b.pending.splice(0, b.pending.length), err, "dead-letter");
        b.inflight.clear();
        b.recentContents.clear();
      }
      if (s.retryTimer) {
        clearTimeout(s.retryTimer);
        s.retryTimer = null;
      }
      if (s.inflightTimer) {
        clearTimeout(s.inflightTimer);
        s.inflightTimer = null;
      }
      return n;
    },

    dispose() {
      const err = new DispatchError("agent-stopped", "dispatch queue disposed (daemon shutdown)");
      for (const [agentName, s] of states) {
        s.epoch += 1;
        if (s.retryTimer) clearTimeout(s.retryTimer);
        s.retryTimer = null;
        if (s.inflightTimer) clearTimeout(s.inflightTimer);
        s.inflightTimer = null;
        for (const b of s.buckets.values()) {
          discardPending(agentName, b.pending.splice(0, b.pending.length), err, "dead-letter");
          b.inflight.clear();
          b.recentContents.clear();
        }
      }
      states.clear();
    },
  };
};
