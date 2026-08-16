import { ref } from "vue";
import { defineStore } from "pinia";
import { apiGet, apiPost, apiClient } from "../api";
import type { Message } from "@collabagent/shared";

const CACHE_PREFIX = "msgs_";
const CACHE_LIMIT = 50;

function cacheKey(channel: string) {
  return CACHE_PREFIX + channel;
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

export const useMessageStore = defineStore("messages", () => {
  const messagesByTarget = ref<Record<string, Message[]>>({});
  const lastSeenSeq = ref<Record<string, number>>({});
  const loading = ref(false);

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
      loading.value = false;
    } catch {
      // 请求失败保留缓存内容
      loading.value = false;
    }
  }

  async function sendMessage(channel: string, content: string, attachments?: string[]): Promise<void> {
    const data = await apiPost<{ messageId: string; messageSeq: number }>("/api/messages/send", { target: channel, content, attachmentIds: attachments });
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

  async function editMessage(messageId: string, content: string): Promise<void> {
    await apiClient(`/api/messages/${messageId}`, { method: "PUT", body: { content } });
    applyMessageUpdate(messageId, content);
  }

  function applyMessageUpdate(messageId: string, content: string, editedAt?: string): void {
    const next: Record<string, Message[]> = {};
    for (const k in messagesByTarget.value) {
      next[k] = messagesByTarget.value[k].map((m: any) =>
        m.id === messageId ? { ...m, content, editedAt: editedAt || new Date().toISOString() } : m
      );
    }
    messagesByTarget.value = next;
  }

  function applyMessageTask(messageId: string, taskNumber: number): void {
    const next: Record<string, Message[]> = {};
    for (const k in messagesByTarget.value) {
      next[k] = messagesByTarget.value[k].map((m: any) =>
        m.id === messageId ? { ...m, task_number: taskNumber, task_status: "todo" } : m
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

  function applyMessageDelete(messageId: string): void {
    const next: Record<string, Message[]> = {};
    for (const k in messagesByTarget.value) {
      next[k] = messagesByTarget.value[k].map((m: any) =>
        m.id === messageId ? { ...m, content: "", deleted: true } : m
      );
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
            newReactions = reactions.map((r, i) => i === idx ? { ...r, userIds: [...r.userIds, userId] } : r);
          } else {
            newReactions = [...reactions, { emoji, userIds: [userId] }];
          }
        } else {
          if (idx < 0) return m;
          const newUserIds = reactions[idx].userIds.filter((u) => u !== userId);
          if (newUserIds.length === 0) {
            newReactions = reactions.filter((_, i) => i !== idx);
          } else {
            newReactions = reactions.map((r, i) => i === idx ? { ...r, userIds: newUserIds } : r);
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
    fetchHistory,
    sendMessage,
    receiveMessage,
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
