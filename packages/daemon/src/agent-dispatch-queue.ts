/**
 * EventQueue 式派发队列（改造方案 A1，见 docs/2026-08-18/03-slock-modification-plan.md §1.A1）。
 *
 * 替代旧的「即派即忘 + dispatchPromises 单链缓冲」：旧实现里 PTY 写入失败后消息
 * 只有一行 console.error 就丢了，也没有「同一条消息被重复派发」的防护。本模块
 * 对齐 buzz buzz-acp/queue.rs 的纪律：
 * - per-agent 串行排空（同一 agent 任一时刻只有一批 in-flight）
 * - in-flight 截止自动过期（投递 promise 不 resolve 不等于成功）
 * - 指数退避 + jitter 重试，MAX_RETRIES 后进死信并回调上报（绝不静默丢消息）
 * - dedup：窗口期内同 agent 同内容去重（平台重复派发/网络重发防护）
 * - 忙碌合并：排空时把积压的多条 pending 合并为一条复合 prompt 一次投递
 *   （对齐 buzz 的批量合并重提示；agent 反正是一个回合处理，合并省一次唤醒）
 *
 * 纯内存实现——daemon 重启即清空。重启丢失的消息由 server 侧的未读/mention
 * 机制兜底（agent 上线后 bootstrap 会拉取），队列不做持久化，避免双写一致性坑。
 */

export interface DispatchQueueItem {
  id: string;
  agentName: string;
  channelName: string;
  kind: "message" | "reminder" | "dispatch";
  /** 完整待发文本（不含 reminder tail——tail 由投递执行器在合并后统一追加） */
  content: string;
  enqueuedAt: number;
  attempts: number;
  /** D1/D2：本条所属线程（合并批次取第一项） */
  threadId?: string;
}

/** 投递执行器：items 长度 >1 时表示合并投递。失败必须 reject，队列据此重试。 */
export type DispatchDeliverFn = (agentName: string, items: DispatchQueueItem[]) => Promise<void>;

export interface DispatchQueueOptions {
  deliver: DispatchDeliverFn;
  /** in-flight 截止（默认 60s，SLOCK_DISPATCH_INFLIGHT_MS 覆盖）。超时按失败处理并重试。 */
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
  onQueued?: (agentName: string, item: DispatchQueueItem) => void;
  /** 一批 pending 被合并为一次投递时回调（items 即合并的那批） */
  onMerged?: (agentName: string, items: DispatchQueueItem[]) => void;
  onRetry?: (agentName: string, item: DispatchQueueItem, err: unknown, nextDelayMs: number) => void;
  onDeadLetter?: (agentName: string, item: DispatchQueueItem, err: unknown) => void;
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
  }): EnqueueStatus;
  /** 指定 agent（或全部）的 pending 数量 */
  depth(agentName?: string): number;
  /** 该 agent 是否有在途/积压/退避中的投递（决定要不要提示「已缓冲」） */
  isBusy(agentName: string): boolean;
  /** 丢弃某 agent 的全部 pending（agent 被删除/停止时用），返回丢弃条数 */
  clear(agentName: string): number;
  /** 清掉所有定时器（daemon 关闭时调） */
  dispose(): void;
}

const readIntEnv = (name: string): number | undefined => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
};

let nextId = 1;

interface AgentQueueState {
  pending: DispatchQueueItem[];
  draining: boolean;
  /** 退避中的唤醒定时器；非 null 表示还没到下一次排空时机 */
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** content → 最近一次入队/投递成功时间戳（dedup 窗口判定用） */
  recentContents: Map<string, number>;
  /** P0.3：clear/dispose 递增；in-flight 失败后若 epoch 变了则不再重试 */
  epoch: number;
}

export const createAgentDispatchQueue = (opts: DispatchQueueOptions): AgentDispatchQueue => {
  const now = opts.now ?? (() => Date.now());
  // env 在 create 时解析一次（与仓内其他模块「每次调用读 env」的惯例不同：
  // 队列参数运行期变更没有场景，测试直接传 options 覆盖即可）
  const inflightMs = opts.inflightMs ?? readIntEnv("SLOCK_DISPATCH_INFLIGHT_MS") ?? 60000;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const maxDelayMs = opts.maxDelayMs ?? 30000;
  const maxRetries = opts.maxRetries ?? readIntEnv("SLOCK_DISPATCH_MAX_RETRIES") ?? 3;
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
      s = { pending: [], draining: false, retryTimer: null, recentContents: new Map(), epoch: 0 };
      states.set(agentName, s);
    }
    return s;
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
  const pruneRecent = (s: AgentQueueState): void => {
    const cutoff = now() - dedupWindowMs;
    for (const [k, ts] of s.recentContents) {
      if (ts < cutoff) s.recentContents.delete(k);
    }
  };

  const drain = (agentName: string): void => {
    const s = stateOf(agentName);
    if (s.draining || s.retryTimer) return;
    if (s.pending.length === 0) return;
    s.draining = true;
    const epoch = s.epoch;

    // 忙碌合并：一次取走全部 pending 作为一批投递。合并的语义由投递执行器
    // 决定（拼接内容），队列只保证「这批要么一起成功、要么一起按 attempts 计费」。
    const batch = s.pending.splice(0, s.pending.length);
    if (batch.length > 1) safe(() => opts.onMerged?.(agentName, batch));

    // in-flight 截止：deliver 挂住不等于投递中，超时就当失败重试——
    // 防止一次卡死的投递把该 agent 的队列永久堵死。
    let settled = false;
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        if (!settled) reject(new Error(`dispatch in-flight timeout (${inflightMs}ms)`));
      }, inflightMs);
    });

    Promise.race([opts.deliver(agentName, batch), timeout])
      .then(() => {
        settled = true;
        const t = now();
        for (const item of batch) {
          s.recentContents.set(item.content, t);
          settleDone(item);
        }
        safe(() => opts.onDelivered?.(agentName, batch));
      })
      .catch((err) => {
        settled = true;
        // P0.3：stop/unregister/dispose 之后不再把 in-flight 失败批次塞回 pending
        if (s.epoch !== epoch) {
          for (const item of batch) settleDone(item);
          return;
        }
        if (opts.isDeliverable && !opts.isDeliverable(agentName)) {
          for (const item of batch) {
            settleDone(item);
            safe(() => opts.onDeadLetter?.(agentName, item, err));
          }
          return;
        }
        const retryable: DispatchQueueItem[] = [];
        for (const item of batch) {
          item.attempts += 1;
          if (item.attempts >= maxRetries) {
            // 死信：回调上报，由上层（daemon-core → WS → server）决定如何呈现，
            // 队列自己不再持有这条消息。
            console.error(
              `[DispatchQueue] @${agentName} message dead-lettered after ${item.attempts} attempts:`,
              (err as any)?.message ?? err,
            );
            settleDone(item);
            safe(() => opts.onDeadLetter?.(agentName, item, err));
          } else {
            retryable.push(item);
          }
        }
        if (retryable.length > 0) {
          const delay = backoff(Math.min(...retryable.map((i) => i.attempts)));
          for (const item of retryable) safe(() => opts.onRetry?.(agentName, item, err, delay));
          // 重回队首（保持原始相对顺序），退避结束后继续排空
          s.pending.unshift(...retryable);
          s.retryTimer = setTimeout(() => {
            s.retryTimer = null;
            drain(agentName);
          }, delay);
        }
      })
      .finally(() => {
        s.draining = false;
        // 成功路径：如果期间有新消息入队，继续排空
        if (s.pending.length > 0 && !s.retryTimer) drain(agentName);
      });
  };

  return {
    enqueue(input) {
      const { agentName } = input;
      // 永久失败快速通道：agent 已停止/无 id 时重试无意义，直接死信
      if (opts.isDeliverable && !opts.isDeliverable(agentName)) {
        const err = new Error(`@${agentName} not deliverable (stopped or unknown agent)`);
        const item: DispatchQueueItem = {
          id: `dq-${nextId++}`,
          agentName,
          channelName: input.channelName,
          kind: input.kind ?? "message",
          content: input.content,
          enqueuedAt: now(),
          attempts: maxRetries,
          threadId: input.threadId,
        };
        safe(() => opts.onDeadLetter?.(agentName, item, err));
        return { status: "dead", err };
      }

      const s = stateOf(agentName);
      pruneRecent(s);
      // dedup：窗口内见过同内容（含仍在 pending 的）——平台重复派发防护。
      // 代价是「用户 15s 内连发两条一模一样的消息」会被吞一条，可接受：
      // 正常人类/agent 对话极少逐字重复，而重复派发的危害（agent 干两遍活）更大。
      if (s.recentContents.has(input.content) || s.pending.some((p) => p.content === input.content)) {
        return { status: "deduped" };
      }

      const item: DispatchQueueItem = {
        id: `dq-${nextId++}`,
        agentName,
        channelName: input.channelName,
        kind: input.kind ?? "message",
        content: input.content,
        enqueuedAt: now(),
        attempts: 0,
        threadId: input.threadId,
      };
      const done = new Promise<void>((r) => doneResolvers.set(item.id, r));
      s.pending.push(item);
      s.recentContents.set(item.content, now());
      safe(() => opts.onQueued?.(agentName, item));
      drain(agentName);
      return { status: "queued", item, done };
    },

    depth(agentName) {
      if (agentName !== undefined) return states.get(agentName)?.pending.length ?? 0;
      let n = 0;
      for (const s of states.values()) n += s.pending.length;
      return n;
    },

    isBusy(agentName) {
      const s = states.get(agentName);
      if (!s) return false;
      return s.draining || s.pending.length > 0 || s.retryTimer !== null;
    },

    clear(agentName) {
      const s = states.get(agentName);
      if (!s) return 0;
      s.epoch += 1;
      const n = s.pending.length;
      for (const item of s.pending) settleDone(item); // 丢弃也算完结，await 方不挂住
      s.pending.length = 0;
      if (s.retryTimer) {
        clearTimeout(s.retryTimer);
        s.retryTimer = null;
      }
      return n;
    },

    dispose() {
      for (const s of states.values()) {
        s.epoch += 1;
        if (s.retryTimer) clearTimeout(s.retryTimer);
        s.retryTimer = null;
        for (const item of s.pending) settleDone(item);
        s.pending.length = 0;
      }
      states.clear();
    },
  };
};
