import type { WsServerMessage } from "@collabagent/shared";
import { useAgentStore, useChannelStore, useMessageStore } from "../stores";
import type { AgentActivity } from "../stores/agentStore";
import { useNotificationStore } from "../stores/notificationStore";
import { useTerminalStore } from "../stores/terminalStore";
import { toast } from "../stores/toastStore";
import type { AgentStatusEvent, WsServerEvent } from "../types";

/**
 * WS 事件路由（O16 从 AppLayout 抽出的 onMessage switch）——store 只消费事件，
 * 不感知连接。需在 Pinia 激活后调用（AppLayout 在 setup 内装配，天然满足）。
 */
export function dispatchWsEvent(msg: WsServerEvent): void {
  const messageStore = useMessageStore();
  const channelStore = useChannelStore();
  const agentStore = useAgentStore();
  const notificationStore = useNotificationStore();
  const terminalStore = useTerminalStore();

  // 统一按 string 取 type：WsServerEvent 是多个来源的并集（shared WsServerMessage +
  // LocalWsEvent + AgentStatusEvent），直接解构会被 TS 收窄成单一 union 而误报无可比性
  const type = (msg as { type?: string }).type;

  if (type === "notification.new") {
    notificationStore.prependNotification((msg as any).notification);
  }
  // 终端观察（G3）：daemon 推来的终端帧写入 terminalStore
  if (type === "terminal:frame") {
    const f = msg as any;
    terminalStore.setFrame(f.agentName, {
      screen: f.screen || "",
      status: f.status || "unknown",
      time: f.time,
    });
  }
  if (type === "agent:status" || type === "agent:activity") {
    const a = msg as unknown as AgentStatusEvent;
    // daemon 上报带 agentName（G7 last_pty_line）；旧消息只有 agentId，兜底
    const id = a.agentName || a.agentId || "agent";
    const status = type === "agent:status" ? a.status || "idle" : "working";
    agentStore.updateStatus(id, status as AgentActivity, a.detail || "");
  }
  // 门控投递反馈：daemon 把发给忙碌 agent 的消息排队了（agent 空闲后按序投递，不丢）
  if (type === "agent:delivery-queued") {
    toast.info(`⏳ @${(msg as any).agentName} 正在工作，消息已缓冲，将在其空闲后自动投递`);
  }
  if (type === "message:update" && (msg as any).message) {
    const m = (msg as any).message;
    messageStore.applyMessageUpdate(m.id, m.content, m.editedAt);
  }
  if (type === "message:delete" && (msg as any).message) {
    messageStore.applyMessageDelete((msg as any).message.id);
  }
  if (type === "agent:deliver" && (msg as any).message) {
    const m = (msg as any).message as any;
    // 乐观行调和（O15）：回执带上发送时的 clientNonce，先清掉本地对应的 pending 乐观行
    if (m.clientNonce) messageStore.ackPendingByNonce(m.clientNonce);
    const hasThread = m.thread_id || m.threadId;
    const chs = channelStore.channels;
    const ch = chs.find((c: any) => c.id === m.channelId);
    const targetKey = ch ? "#" + ch.name : m.channelId;
    messageStore.receiveMessage({
      id: m.id,
      seq: m.seq,
      channelId: targetKey,
      senderId: m.senderId,
      senderName: m.senderName || "unknown",
      senderType: m.senderType || "human",
      content: m.content,
      time: m.time || new Date().toISOString(),
      attachments: m.attachments || [],
    } as any);
    if (hasThread) {
      const threadKey = targetKey + ":" + (m.thread_id || m.threadId || "").substring(0, 8);
      messageStore.receiveMessage({
        ...m,
        id: m.id,
        seq: m.seq,
        channelId: threadKey,
        senderId: m.senderId,
        senderName: m.senderName || "unknown",
        senderType: m.senderType || "human",
        content: m.content,
        time: m.time || new Date().toISOString(),
      } as any);
    }
    if (channelStore.activeChannelName && ch?.name !== channelStore.activeChannelName) {
      channelStore.incrementUnread(targetKey);
    }
  }
}
