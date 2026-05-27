import { create } from "zustand";
import { apiGet, apiPost } from "../api/client";
import type { Message } from "@collabagent/shared";

interface MessageState {
  messagesByTarget: Record<string, Message[]>;
  lastSeenSeq: Record<string, number>;
  loading: boolean;
  fetchHistory: (channel: string, opts?: { before?: number; limit?: number }) => Promise<void>;
  sendMessage: (channel: string, content: string, attachments?: string[]) => Promise<void>;
  receiveMessage: (message: Message) => void;
  addReaction: (messageId: string, emoji: string) => Promise<void>;
  removeReaction: (messageId: string, emoji: string) => Promise<void>;
}

export const useMessageStore = create<MessageState>((set, get) => ({
  messagesByTarget: {},
  lastSeenSeq: {},
  loading: false,

  fetchHistory: async (channel, opts) => {
    set({ loading: true });
    const params: Record<string, string> = { channel };
    if (opts?.before) params.before = String(opts.before);
    if (opts?.limit) params.limit = String(opts.limit);
    try {
      const data = await apiGet<{ messages: Message[] }>("/api/messages", params);
      set((s) => ({
        messagesByTarget: { ...s.messagesByTarget, [channel]: data.messages || [] },
        loading: false,
      }));
    } catch {
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
      return {
        messagesByTarget: {
          ...s.messagesByTarget,
          [target]: [...existing, message],
        },
        lastSeenSeq: {
          ...s.lastSeenSeq,
          [target]: Math.max(message.seq, s.lastSeenSeq[target] || 0),
        },
      };
    });
  },

  addReaction: async (messageId, emoji) => {
    await apiPost(`/api/messages/${messageId}/reactions`, { emoji });
  },

  removeReaction: async (messageId, emoji) => {
    await apiPost(`/api/messages/${messageId}/reactions/remove`, { emoji });
  },
}));
