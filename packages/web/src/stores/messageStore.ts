import type { Message } from "@collabagent/shared";
import { defineStore } from "pinia";
import { ref } from "vue";
import { apiClient, apiGet, apiPost } from "../api";
import type { PendingItem } from "../components/chat/types";
import { toast } from "./toastStore";

const CACHE_PREFIX = "msgs_";
const CACHE_LIMIT = 50;

// 断线补拉参数：页大小 200、单 target 上限 10 页防失控、backfillAll 并发 4
// （页并发对齐 buzz RECONNECT_REPLAY_PAGE_CONCURRENCY）
const BACKFILL_PAGE_LIMIT = 200;
const BACKFILL_MAX_PAGES = 10;
const BACKFILL_CONCURRENCY = 4;

// 离线发送队列持久化 key（单 key 存全 target；只落 queued/failed，sending 落盘时归 queued）
const PENDING_CACHE_KEY = "pending_msgs_v1";

function cacheKey(channel: string) {
  return CACHE_PREFIX + channel;
}

/**
 * 线程缓冲区 key 约定：「<频道 key 去 #>:<threadId 前 8 位>」（如 general:abcd1234、
 * dm:<uuid>:abcd1234）——与 ThreadView 路由参数（无 #）同口径；展示层需要 # 自行添加。
 * wsDispatch（写）与 ThreadView（读）必须共用此 helper，防口径漂移（P0-2 教训）。
 */
export function threadBufferKey(channelKey: string, threadId: string): string {
  const base = channelKey.startsWith("#") ? channelKey.slice(1) : channelKey;
  return `${base}:${String(threadId).substring(0, 8)}`;
}

function loadCache(channel: string): Message[] | null {
  try {
    const raw = localStorage.getItem(cacheKey(channel));
    return raw ? (JSON.parse(raw) as Message[]) : null;
  } catch {
    return null;
  }
}

function saveCache(channel: string, msgs: Message[]) {
  try {
    localStorage.setItem(cacheKey(channel), JSON.stringify(msgs.slice(-CACHE_LIMIT)));
  } catch {
    // quota exceeded / unavailable — ignore
  }
}

// 生成指定长度的随机 base36 串（Math.random 拼接截取，仅作客户端幂等键，无安全用途）
function randomBase36(len: number): string {
  let s = "";
  while (s.length < len) s += Math.random().toString(36).slice(2);
  return s.slice(0, len);
}

// 恢复上次会话遗留的离线队列：sending 态说明死在发送途中，一律归 queued 等重发
// （nonce 不变，重发由服务端按 clientNonce 去重，不会重复落库）
function loadPending(): Record<string, PendingItem[]> {
  try {
    const raw = localStorage.getItem(PENDING_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, PendingItem[]>;
    const restored: Record<string, PendingItem[]> = {};
    for (const k in parsed) {
      const list = parsed[k];
      if (!Array.isArray(list)) continue;
      const items = list
        .filter((p) => p && typeof p.tempId === "string" && typeof p.nonce === "string")
        .map((p) => (p.status === "sending" ? { ...p, status: "queued" as const } : p));
      if (items.length) restored[k] = items;
    }
    return restored;
  } catch {
    return {};
  }
}

export const useMessageStore = defineStore("messages", () => {
  const messagesByTarget = ref<Record<string, Message[]>>({});
  const lastSeenSeq = ref<Record<string, number>>({});
  const loading = ref(false);
  // 离线发送队列（按 target 分组，持久化到 localStorage，切频道/刷新不丢）
  const pendingByTarget = ref<Record<string, PendingItem[]>>(loadPending());

  // per-target 重入护栏：补拉/flush 进行中对同 target 的重复触发直接返回
  const backfillInflight = new Set<string>();
  const flushInflight = new Set<string>();
  // 线程缓冲区 key 登记（非响应式）：backfillAll 据此跳过 thread key——它不是可解析
  // 频道名，硬拉 history 会被 server 端 cleanChannelName 清成主频道名，把顶层历史
  // 灌进线程缓冲区（ThreadView 只按 id 去重追加，污染会以「回复」形态上屏）
  const threadKeys = new Set<string>();

  async function fetchHistory(channel: string, opts?: { before?: number; limit?: number }): Promise<void> {
    loading.value = true;
    // 先用本地缓存即时渲染（离线也能看到上次的消息）
    if (!messagesByTarget.value[channel]) {
      const cached = loadCache(channel);
      if (cached && cached.length) {
        messagesByTarget.value = { ...messagesByTarget.value, [channel]: cached };
      }
    }
    const params: Record<string, string> = { channel };
    if (opts?.before) params.before = String(opts.before);
    if (opts?.limit) params.limit = String(opts.limit);
    try {
      const data = await apiGet<{ messages: Message[] }>("/api/messages", params);
      const msgs = data.messages || [];
      saveCache(channel, msgs);
      messagesByTarget.value = { ...messagesByTarget.value, [channel]: msgs };
      // 推进已见水位：before 翻旧页时本页 seq 更小，max 保护不回退
      const maxSeq = msgs.reduce((acc, m) => Math.max(acc, m.seq || 0), 0);
      if (maxSeq > 0) {
        lastSeenSeq.value = {
          ...lastSeenSeq.value,
          [channel]: Math.max(maxSeq, lastSeenSeq.value[channel] || 0),
        };
      }
      loading.value = false;
    } catch {
      // 请求失败保留缓存内容
      loading.value = false;
    }
  }

  async function sendMessage(channel: string, content: string, attachments?: string[]): Promise<void> {
    const data = await apiPost<{ messageId: string; messageSeq: number }>("/api/messages/send", {
      target: channel,
      content,
      attachmentIds: attachments,
    });
    const newMsg = {
      id: data.messageId,
      channelId: channel,
      seq: data.messageSeq,
      senderId: "me",
      senderName: "Me",
      senderType: "human" as const,
      content,
      time: new Date().toISOString(),
    } as Message;
    receiveMessage(newMsg);
  }

  function receiveMessage(message: Message): void {
    const target = message.channelId;
    const existing = messagesByTarget.value[target] || [];
    if (existing.find((m) => m.id === message.id)) return;
    // Don't add thread replies to main channel view — they belong in thread view only
    if ((message as any).threadId) return;
    const updated = [...existing, message];
    saveCache(target, updated);
    messagesByTarget.value = {
      ...messagesByTarget.value,
      [target]: updated,
    };
    lastSeenSeq.value = {
      ...lastSeenSeq.value,
      [target]: Math.max(message.seq, lastSeenSeq.value[target] || 0),
    };
  }

  /**
   * P0-2：线程回复直写线程缓冲区——receiveMessage 的「threadId 不入主列表」守卫
   * 对主列表写入是正确的，但线程缓冲区需要绕开它。key 用 threadBufferKey() 约定
   * （无 #），message.channelId 保留真实频道 target（#name / dm:uuid）。
   * 不写 localStorage 缓存、不推进 lastSeenSeq：ThreadView 挂载即走 REST loadThread，
   * 缓存无人消费；线程 seq 与主频道共用序列，推进了也没有补拉端点对应。
   */
  function receiveThreadReply(threadKey: string, message: Message): void {
    threadKeys.add(threadKey);
    const existing = messagesByTarget.value[threadKey] || [];
    if (existing.find((m) => m.id === message.id)) return;
    messagesByTarget.value = {
      ...messagesByTarget.value,
      [threadKey]: [...existing, message],
    };
  }

  // ---- 断线增量补拉（重连后按 lastSeenSeq 分页补齐缺口）----

  /**
   * 单 target 补拉：从已见最大 seq 起循环拉 /api/messages/history（after=游标），
   * 逐条 receiveMessage（天然按 id 去重）。游标用局部变量推进——补拉期间到达的
   * live 消息会抬高 store 的 lastSeenSeq，但不能跳过中间尚未补到的窗口。
   * 失败静默：保持 live-only，lastSeenSeq 不伪造推进，下次重连再补（对齐 buzz 降级语义）。
   */
  async function backfillTarget(target: string): Promise<void> {
    if (backfillInflight.has(target)) return;
    backfillInflight.add(target);
    try {
      let after = lastSeenSeq.value[target] || 0;
      for (let page = 0; page < BACKFILL_MAX_PAGES; page++) {
        const data = await apiGet<{ messages: Message[]; hasMore?: boolean }>("/api/messages/history", {
          channel: target,
          after: String(after),
          limit: String(BACKFILL_PAGE_LIMIT),
        });
        // 服务端按 seq 升序返回；本地再排一次兜底，receiveMessage 按 id 去重
        const msgs = (data.messages || []).slice().sort((a, b) => a.seq - b.seq);
        if (msgs.length === 0) return;
        for (const m of msgs) {
          // history 返回的 channelId 是频道 UUID，这里归一到发起补拉的 target key
          receiveMessage({ ...m, channelId: target });
        }
        if (!data.hasMore) return;
        const maxSeq = msgs[msgs.length - 1].seq;
        if (maxSeq <= after) return; // 游标无推进，防异常数据死循环
        after = maxSeq;
      }
    } catch {
      // 静默降级 live-only
    } finally {
      backfillInflight.delete(target);
    }
  }

  /** 全量补拉：对 messagesByTarget 全部 key，worker-pool 有限并发 4 */
  async function backfillAll(): Promise<void> {
    // 跳过线程缓冲区 key（见 threadKeys 注释：history 端点会把 thread key 清成主频道名）
    const targets = Object.keys(messagesByTarget.value).filter((t) => !threadKeys.has(t));
    let nextIndex = 0;
    const workerCount = Math.min(BACKFILL_CONCURRENCY, targets.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIndex < targets.length) {
          const target = targets[nextIndex++];
          await backfillTarget(target);
        }
      }),
    );
  }

  // ---- 离线发送队列（乐观发送 + clientNonce 幂等）----

  // 每次变更后持久化：只落 queued/failed；sending 落盘时归 queued
  // （恢复后按原 nonce 重发，服务端按 clientNonce 幂等去重，不会重复落库）
  function persistPending() {
    try {
      const toSave: Record<string, PendingItem[]> = {};
      for (const k in pendingByTarget.value) {
        const items = pendingByTarget.value[k].map((p) =>
          p.status === "sending" ? { ...p, status: "queued" as const } : p,
        );
        if (items.length) toSave[k] = items;
      }
      localStorage.setItem(PENDING_CACHE_KEY, JSON.stringify(toSave));
    } catch {
      // quota exceeded / unavailable — ignore（对齐 saveCache 风格）
    }
  }

  // W-A3：failReason 仅在 failed 态留存（PendingRow 展示 server 400/403 文案）；
  // 转入 sending/queued 时清除，避免陈旧原因残留
  function setPendingStatus(target: string, tempId: string, status: PendingItem["status"], failReason?: string) {
    const list = pendingByTarget.value[target];
    if (!list?.some((p) => p.tempId === tempId)) return; // 可能已被 ackPendingByNonce 调和移除
    pendingByTarget.value = {
      ...pendingByTarget.value,
      [target]: list.map((p) =>
        p.tempId === tempId ? { ...p, status, failReason: status === "failed" ? failReason : undefined } : p,
      ),
    };
    persistPending();
  }

  function removePending(target: string, tempId: string) {
    const list = pendingByTarget.value[target];
    if (!list) return;
    const next = list.filter((p) => p.tempId !== tempId);
    if (next.length === list.length) return;
    const record = { ...pendingByTarget.value };
    if (next.length) record[target] = next;
    else delete record[target];
    pendingByTarget.value = record;
    persistPending();
  }

  /** 入队一条待发送消息：tempId=tmp-<ts>-<4位随机>，nonce=n-<24位随机base36> */
  function enqueuePending(target: string, content: string, attachmentIds?: string[]): PendingItem {
    const item: PendingItem = {
      tempId: `tmp-${Date.now()}-${randomBase36(4)}`,
      nonce: `n-${randomBase36(24)}`,
      content,
      status: "queued",
      attachmentIds: attachmentIds?.length ? attachmentIds : undefined,
    };
    pendingByTarget.value = {
      ...pendingByTarget.value,
      [target]: [...(pendingByTarget.value[target] || []), item],
    };
    persistPending();
    return item;
  }

  /**
   * 逐条串行发送该 target 的 queued 项：queued→sending→成功移除；失败标 failed
   * 并中断本轮（保持顺序，其余 queued 留待下次 flush）。per-target 并发护栏防重入。
   */
  async function flushPending(target: string): Promise<void> {
    if (flushInflight.has(target)) return;
    flushInflight.add(target);
    try {
      for (;;) {
        const next = (pendingByTarget.value[target] || []).find((p) => p.status === "queued");
        if (!next) return;
        setPendingStatus(target, next.tempId, "sending");
        try {
          const sent = await apiPost<{ skippedMentions?: { handle: string; reason: string }[] }>("/api/messages/send", {
            target,
            content: next.content,
            attachmentIds: next.attachmentIds,
            clientNonce: next.nonce, // 幂等键：同 nonce 重发由服务端去重
          });
          if (sent?.skippedMentions?.length) {
            const names = sent.skippedMentions.map((s) => `@${s.handle}`).join("、");
            toast.info(`${names} 已停班，消息已发出但不会唤醒`);
          }
          removePending(target, next.tempId);
        } catch (err: any) {
          setPendingStatus(target, next.tempId, "failed", err?.message || "网络错误");
          return;
        }
      }
    } finally {
      flushInflight.delete(target);
    }
  }

  /** 补发全部 target 的 queued 项（重连/恢复在线时调用；各 target 间并行、内部串行） */
  async function flushAllPending(): Promise<void> {
    await Promise.all(Object.keys(pendingByTarget.value).map((target) => flushPending(target)));
  }

  /** 重试单条 failed：failed→sending，沿用同一 nonce 重发（幂等由服务端去重兜底） */
  async function retryPending(target: string, tempId: string): Promise<void> {
    const item = (pendingByTarget.value[target] || []).find((p) => p.tempId === tempId);
    if (!item || item.status === "sending") return;
    setPendingStatus(target, tempId, "sending");
    try {
      await apiPost("/api/messages/send", {
        target,
        content: item.content,
        attachmentIds: item.attachmentIds,
        clientNonce: item.nonce,
      });
      removePending(target, tempId);
    } catch (err: any) {
      setPendingStatus(target, tempId, "failed", err?.message || "网络错误");
    }
  }

  function discardPending(target: string, tempId: string): void {
    removePending(target, tempId);
  }

  /** WS agent:deliver 回执带 clientNonce 时的乐观行调和：移除全部 target 下匹配 nonce 的 pending */
  function ackPendingByNonce(nonce: string): void {
    if (!nonce) return;
    let changed = false;
    const record: Record<string, PendingItem[]> = {};
    for (const k in pendingByTarget.value) {
      const filtered = pendingByTarget.value[k].filter((p) => p.nonce !== nonce);
      if (filtered.length !== pendingByTarget.value[k].length) changed = true;
      if (filtered.length) record[k] = filtered;
    }
    if (!changed) return;
    pendingByTarget.value = record;
    persistPending();
  }

  async function editMessage(messageId: string, content: string): Promise<void> {
    await apiClient(`/api/messages/${messageId}`, { method: "PUT", body: { content } });
    applyMessageUpdate(messageId, content);
  }

  function applyMessageUpdate(messageId: string, content: string, editedAt?: string): void {
    const next: Record<string, Message[]> = {};
    for (const k in messagesByTarget.value) {
      next[k] = messagesByTarget.value[k].map((m: any) =>
        m.id === messageId ? { ...m, content, editedAt: editedAt || new Date().toISOString() } : m,
      );
    }
    messagesByTarget.value = next;
  }

  function applyMessageTask(messageId: string, taskNumber: number): void {
    const next: Record<string, Message[]> = {};
    for (const k in messagesByTarget.value) {
      next[k] = messagesByTarget.value[k].map((m: any) =>
        m.id === messageId ? { ...m, task_number: taskNumber, task_status: "todo" } : m,
      );
    }
    messagesByTarget.value = next;
  }

  async function addReaction(messageId: string, emoji: string, userId: string): Promise<void> {
    await apiPost(`/api/messages/${messageId}/reactions`, { emoji });
    applyReaction(messageId, emoji, userId, "add");
  }

  async function removeReaction(messageId: string, emoji: string, userId: string): Promise<void> {
    await apiClient(`/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, { method: "DELETE" });
    applyReaction(messageId, emoji, userId, "remove");
  }

  async function deleteMessage(messageId: string): Promise<void> {
    await apiClient(`/api/messages/${messageId}`, { method: "DELETE" });
    applyMessageDelete(messageId);
  }

  function applyMessageDelete(messageId: string, opts?: { remove?: boolean }): void {
    const next: Record<string, Message[]> = {};
    for (const k in messagesByTarget.value) {
      if (opts?.remove) {
        next[k] = messagesByTarget.value[k].filter((m: any) => m.id !== messageId);
      } else {
        next[k] = messagesByTarget.value[k].map((m: any) =>
          m.id === messageId ? { ...m, content: "", deleted: true } : m,
        );
      }
    }
    messagesByTarget.value = next;
  }

  function applyReaction(messageId: string, emoji: string, userId: string, action: "add" | "remove"): void {
    const next: Record<string, Message[]> = {};
    for (const k in messagesByTarget.value) {
      next[k] = messagesByTarget.value[k].map((m: any) => {
        if (m.id !== messageId) return m;
        const reactions: { emoji: string; userIds: string[] }[] = m.reactions || [];
        const idx = reactions.findIndex((r) => r.emoji === emoji);
        let newReactions: typeof reactions;
        if (action === "add") {
          if (idx >= 0) {
            if (reactions[idx].userIds.includes(userId)) return m;
            newReactions = reactions.map((r, i) => (i === idx ? { ...r, userIds: [...r.userIds, userId] } : r));
          } else {
            newReactions = [...reactions, { emoji, userIds: [userId] }];
          }
        } else {
          if (idx < 0) return m;
          const newUserIds = reactions[idx].userIds.filter((u) => u !== userId);
          if (newUserIds.length === 0) {
            newReactions = reactions.filter((_, i) => i !== idx);
          } else {
            newReactions = reactions.map((r, i) => (i === idx ? { ...r, userIds: newUserIds } : r));
          }
        }
        return { ...m, reactions: newReactions };
      });
    }
    messagesByTarget.value = next;
  }

  return {
    messagesByTarget,
    lastSeenSeq,
    loading,
    pendingByTarget,
    fetchHistory,
    sendMessage,
    receiveMessage,
    receiveThreadReply,
    backfillTarget,
    backfillAll,
    enqueuePending,
    flushPending,
    flushAllPending,
    retryPending,
    discardPending,
    ackPendingByNonce,
    editMessage,
    applyMessageUpdate,
    applyMessageTask,
    deleteMessage,
    applyMessageDelete,
    addReaction,
    removeReaction,
    applyReaction,
  };
});
