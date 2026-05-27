import { create } from "zustand";
import type { Message, PaginationOpts } from "@collabagent/shared";

interface MessageState {
  messagesByTarget: Record<string, Message[]>;
  pendingMessages: Message[];
  lastSeenSeq: Record<string, number>;
  loading: boolean;

  fetchHistory: (channel: string, opts?: PaginationOpts) => Promise<void>;
  sendMessage: (channel: string, content: string, attachments?: string[]) => Promise<void>;
  receiveMessage: (message: Message) => void;
  addReaction: (messageId: string, emoji: string) => Promise<void>;
  removeReaction: (messageId: string, emoji: string) => Promise<void>;
  setMessages: (target: string, messages: Message[]) => void;
  prependMessages: (target: string, messages: Message[]) => void;
}

export const useMessageStore = create<MessageState>((set, get) => ({
  messagesByTarget: {},
  pendingMessages: [],
  lastSeenSeq: {},
  loading: false,

  fetchHistory: async (channel, opts) => {
    set({ loading: true });
    const params = new URLSearchParams({ channel });
    if (opts?.before) params.set("before", String(opts.before));
    if (opts?.after) params.set("after", String(opts.after));
    if (opts?.limit) params.set("limit", String(opts.limit));
    const res = await fetch(`/api/messages?${params}`);
    const data = await res.json();
    const target = channel;
    set((s) => ({
      messagesByTarget: { ...s.messagesByTarget, [target]: data.messages },
      loading: false,
    }));
  },

  sendMessage: async (channel, content, attachments) => {
    const res = await fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: channel, content, attachmentIds: attachments }),
    });
    if (!res.ok) throw new Error("Send failed");
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
    await fetch(`/api/messages/${messageId}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji }),
    });
  },

  removeReaction: async (messageId, emoji) => {
    await fetch(`/api/messages/${messageId}/reactions`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji }),
    });
  },

  setMessages: (target, messages) => {
    set((s) => ({
      messagesByTarget: { ...s.messagesByTarget, [target]: messages },
    }));
  },

  prependMessages: (target, messages) => {
    set((s) => ({
      messagesByTarget: {
        ...s.messagesByTarget,
        [target]: [...messages, ...(s.messagesByTarget[target] || [])],
      },
    }));
  },
}));
