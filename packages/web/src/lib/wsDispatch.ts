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
  // P1.25：已读多端同步——任一标签页标记已读后 server 广播回来（发起端 store 已
  // 乐观更新，markAsRead/markAllAsRead 幂等：已读行直接跳过/计数不重复减）。
  if (type === "notification.read") {
    const m = msg as unknown as { ids?: string[] | null; all?: boolean };
    if (m.all) notificationStore.markAllAsRead();
    else if (Array.isArray(m.ids)) for (const id of m.ids) notificationStore.markAsRead(id);
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
  // B1 结构化观察帧：事件流面板消费（obs-history 整体置换，obs-frame 逐条追加）
  if (type === "terminal:obs-frame") {
    const f = msg as any;
    if (f.agentName && f.frame) terminalStore.appendObsFrame(f.agentName, f.frame);
  }
  if (type === "terminal:obs-history") {
    const f = msg as any;
    if (f.agentName && Array.isArray(f.frames)) terminalStore.setObsHistory(f.agentName, f.frames);
  }
  if (type === "terminal:history") {
    const f = msg as any;
    if (f.agentName && typeof f.text === "string") terminalStore.setHistory(f.agentName, f.text);
  }
  if (type === "agent:progress") {
    const p = msg as any;
    if (p.phase === "end") agentStore.clearProgress(p.channelName || "", p.agentName);
    else if (p.agentName && p.channelName) agentStore.setProgress(p.channelName, p.agentName, p.headline || "思考");
  }
  if (type === "agent:presence") {
    const p = msg as any;
    if (p.agentName) {
      agentStore.applyPresence({
        agentName: p.agentName,
        agentId: p.agentId,
        duty: p.duty === "off" ? "off" : "on",
        computerOnline: !!p.computerOnline,
        presence: p.presence,
      });
    }
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
  // A1 派发队列死信：重试多次仍投递失败（或 agent 已停止）——消息确认丢失，需人工介入
  if (type === "agent:delivery-dead-letter") {
    const m = msg as any;
    // P1.26：server 侧 dispatch 离线告警（reason="daemon-offline"）——目标 agent 的
    // owner daemon 未连接，消息不会实时送达也不会被唤醒（重连不补拉）。与 daemon
    // 上报的 A1 死信（重试耗尽）区分文案。
    if (m.reason === "daemon-offline") {
      toast.warning(`⚠️ 发给 @${m.agentName} 的消息暂未送达（对方 daemon 离线）：${m.error || "对方设备未连接"}`);
    } else {
      toast.error(`❌ 发给 @${m.agentName} 的消息投递失败（已自动重试多次）：${m.error || "未知原因"}，请重新发送`);
    }
  }
  if (type === "message:update" && (msg as any).message) {
    const m = (msg as any).message;
    messageStore.applyMessageUpdate(m.id, m.content, m.editedAt);
  }
  if (type === "message:delete" && (msg as any).message) {
    const id = (msg as any).message.id as string;
    // D4 进度条硬删：从列表拿掉，不留「已删除」占位
    const wasProgress = Object.values(messageStore.messagesByTarget).some((list) =>
      (list as any[]).some((m) => m.id === id && String(m.content ?? "").startsWith("⏳")),
    );
    messageStore.applyMessageDelete(id, { remove: wasProgress });
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
      senderHandle: m.senderHandle,
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
        senderHandle: m.senderHandle,
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
