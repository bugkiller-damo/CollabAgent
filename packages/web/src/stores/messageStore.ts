import { create } from "zustand";
import { apiGet, apiPost, apiClient } from "../api/client";
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

interface MessageState {
  messagesByTarget: Record<string, Message[]>;
  lastSeenSeq: Record<string, number>;
  loading: boolean;
  fetchHistory: (channel: string, opts?: { before?: number; limit?: number }) => Promise<void>;
  sendMessage: (channel: string, content: string, attachments?: string[]) => Promise<void>;
  receiveMessage: (message: Message) => void;
  editMessage: (messageId: string, content: string) => Promise<void>;
  applyMessageUpdate: (messageId: string, content: string, editedAt?: string) => void;
  deleteMessage: (messageId: string) => Promise<void>;
  applyMessageDelete: (messageId: string) => void;
  addReaction: (messageId: string, emoji: string, userId: string) => Promise<void>;
  removeReaction: (messageId: string, emoji: string, userId: string) => Promise<void>;
  applyReaction: (messageId: string, emoji: string, userId: string, action: "add" | "remove") => void;
}

export const useMessageStore = create<MessageState>((set, get) => ({
  messagesByTarget: {},
  lastSeenSeq: {},
  loading: false,

  fetchHistory: async (channel, opts) => {
    set({ loading: true });
    // 先用本地缓存即时渲染（离线也能看到上次的消息）
    if (!get().messagesByTarget[channel]) {
      const cached = loadCache(channel);
      if (cached && cached.length) {
        set((s) => ({ messagesByTarget: { ...s.messagesByTarget, [channel]: cached } }));
      }
    }
    const params: Record<string, string> = { channel };
    if (opts?.before) params.before = String(opts.before);
    if (opts?.limit) params.limit = String(opts.limit);
    try {
      const data = await apiGet<{ messages: Message[] }>("/api/messages", params);
      const msgs = data.messages || [];
      saveCache(channel, msgs);
      set((s) => ({
        messagesByTarget: { ...s.messagesByTarget, [channel]: msgs },
        loading: false,
      }));
    } catch {
      // 请求失败保留缓存内容
      set({ loading: false });
    }
  },

  sendMessage: async (channel, content, attachments) => {
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
    get().receiveMessage(newMsg);
  },

  receiveMessage: (message) => {
    const target = message.channelId;
    set((s) => {
      const existing = s.messagesByTarget[target] || [];
      if (existing.find((m) => m.id === message.id)) return s;
      // Don't add thread replies to main channel view — they belong in thread view only
      if ((message as any).threadId) return s;
      const updated = [...existing, message];
      saveCache(target, updated);
      return {
        messagesByTarget: {
          ...s.messagesByTarget,
          [target]: updated,
        },
        lastSeenSeq: {
          ...s.lastSeenSeq,
          [target]: Math.max(message.seq, s.lastSeenSeq[target] || 0),
        },
      };
    });
  },

  editMessage: async (messageId, content) => {
    await apiClient(`/api/messages/${messageId}`, { method: "PUT", body: { content } });
    get().applyMessageUpdate(messageId, content);
  },

  applyMessageUpdate: (messageId, content, editedAt) => {
    set((s) => {
      const next: Record<string, Message[]> = {};
      for (const k in s.messagesByTarget) {
        next[k] = s.messagesByTarget[k].map((m: any) =>
          m.id === messageId ? { ...m, content, editedAt: editedAt || new Date().toISOString() } : m
        );
      }
      return { messagesByTarget: next };
    });
  },

  addReaction: async (messageId, emoji, userId) => {
    await apiPost(`/api/messages/${messageId}/reactions`, { emoji });
    get().applyReaction(messageId, emoji, userId, "add");
  },

  removeReaction: async (messageId, emoji, userId) => {
    await apiClient(`/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, { method: "DELETE" });
    get().applyReaction(messageId, emoji, userId, "remove");
  },

  deleteMessage: async (messageId) => {
    await apiClient(`/api/messages/${messageId}`, { method: "DELETE" });
    get().applyMessageDelete(messageId);
  },

  applyMessageDelete: (messageId) => {
    set((s) => {
      const next: Record<string, Message[]> = {};
      for (const k in s.messagesByTarget) {
        next[k] = s.messagesByTarget[k].map((m: any) =>
          m.id === messageId ? { ...m, content: "", deleted: true } : m
        );
      }
      return { messagesByTarget: next };
    });
  },

  applyReaction: (messageId, emoji, userId, action) => {
    set((s) => {
      const next: Record<string, Message[]> = {};
      for (const k in s.messagesByTarget) {
        next[k] = s.messagesByTarget[k].map((m: any) => {
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
      return { messagesByTarget: next };
    });
  },
}));
