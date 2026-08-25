import type { AgentDuty, AgentPresence } from "./presence.js";
export type UUID = string;
export type ISO8601 = string;
export type Email = string;
export type MessageType = "human" | "agent" | "system";
export type TargetKind = "channel" | "dm" | "thread";
export interface MessageTarget {
    kind: TargetKind;
    channel?: string;
    peer?: string;
    threadId?: string;
}
export interface Message {
    id: UUID;
    seq: number;
    channelId: UUID;
    senderId: UUID;
    senderName: string;
    /** users.handle / agents.name；点开档案用。历史消息可能缺省 */
    senderHandle?: string;
    senderType: MessageType;
    content: string;
    time: ISO8601;
    threadId?: UUID;
    replyTarget?: string;
    taskNumber?: number;
    taskStatus?: TaskStatus;
    taskAssignee?: UUID;
    attachments?: AttachmentRef[];
    reactions?: Reaction[];
    traceparent?: string;
}
export interface Reaction {
    emoji: string;
    userId: UUID;
    createdAt: ISO8601;
}
export interface AttachmentRef {
    id: UUID;
    name: string;
    mimeType: string;
    sizeBytes: number;
}
export type ChannelVisibility = "public" | "private";
export interface Channel {
    id: UUID;
    serverId: UUID;
    name: string;
    description?: string;
    visibility: ChannelVisibility;
    joined?: boolean;
    archived: boolean;
    memberCount: number;
    createdAt: ISO8601;
    /** T8：频道经理自动分诊开关（DB 列 manager_triage_enabled；默认关） */
    managerTriageEnabled?: boolean;
}
export type MemberRole = "owner" | "admin" | "member";
export type MemberType = "human" | "agent";
export interface ChannelMember {
    channelId: UUID;
    memberId: UUID;
    memberType: MemberType;
    role: MemberRole;
    joinedAt: ISO8601;
}
export interface PersonChannelContext {
    id: string;
    role: string | null;
    isManager: boolean;
    joinedAt: string | null;
}
export interface PersonChannelMembership {
    id: string;
    name: string;
    role: string | null;
    isManager?: boolean;
    /** public / private / dm；旧数据可能缺省 */
    type?: "public" | "private" | "dm";
    description?: string | null;
    /** DM 对端 handle，用于跳转 /dm/:handle */
    peerHandle?: string | null;
}
export interface PersonComputerRef {
    id: string;
    name: string;
    online: boolean;
}
export interface PersonStats {
    messages: number;
    tasksOpen: number;
    tasksDone: number;
    costUsd?: number | null;
}
export interface PersonProfile {
    type: MemberType;
    id: string;
    handle: string;
    displayName: string | null;
    description: string | null;
    avatarUrl: string | null;
    createdAt: string;
    lastMessageAt?: string | null;
    runtime?: string;
    model?: string;
    /** @deprecated 用 presence；值为值班且办公室开门 */
    isOnline?: boolean;
    duty?: AgentDuty;
    presence?: AgentPresence;
    ownedByMe?: boolean;
    computer?: PersonComputerRef | null;
    channel?: PersonChannelContext | null;
    channels: PersonChannelMembership[];
    channelsHasMore?: boolean;
    channelsCapped?: boolean;
}
export interface User {
    id: UUID;
    handle: string;
    displayName: string;
    description?: string;
    avatarUrl?: string;
    createdAt: ISO8601;
}
export type AgentStatus = "active" | "inactive" | "sleeping";
export interface Agent {
    id: UUID;
    userId: UUID;
    serverId: UUID;
    name: string;
    displayName: string;
    description?: string;
    avatarUrl?: string;
    status: AgentStatus;
    duty?: AgentDuty;
    presence?: AgentPresence;
    runtime: string;
    model: string;
    capabilities: string[];
    createdAt: ISO8601;
}
export type TaskStatus = "todo" | "in_progress" | "in_review" | "done";
export interface Task {
    number: number;
    messageId: UUID;
    channelId: UUID;
    title: string;
    status: TaskStatus;
    assignee?: UUID;
    createdAt: ISO8601;
    updatedAt: ISO8601;
}
export type ReminderStatus = "scheduled" | "fired" | "canceled";
export type RepeatRule = string;
export type ReminderKind = "reminder" | "patrol";
export interface Reminder {
    id: UUID;
    ownerId: UUID;
    kind?: ReminderKind;
    title: string;
    instructions?: string;
    fireAt: ISO8601;
    repeatRule?: RepeatRule;
    channelRef?: string;
    anchorMsgId?: UUID;
    status: ReminderStatus;
    paused?: boolean;
    consecutiveSilent?: number;
    maxConsecutiveSilent?: number;
    createdAt: ISO8601;
}
export type ReminderEventType = "created" | "fired" | "snoozed" | "updated" | "canceled" | "dismissed" | "paused" | "resumed" | "auto_paused";
export interface ReminderEvent {
    id: UUID;
    reminderId: UUID;
    eventType: ReminderEventType;
    detail?: Record<string, unknown>;
    createdAt: ISO8601;
}
export interface Attachment {
    id: UUID;
    uploaderId: UUID;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    storageKey: string;
    storageUrl: string;
    createdAt: ISO8601;
}
export type ClientMode = "managed-runner" | "self-hosted-runner" | "legacy-machine";
export interface AuthContext {
    agentId: UUID;
    serverUrl: string;
    serverId: UUID | null;
    token: string;
    clientMode: ClientMode;
    capabilities: string[];
}
export interface MachineToken {
    id: UUID;
    userId: UUID;
    serverId: UUID;
    tokenHash: string;
    tokenPrefix: string;
    scope: Record<string, unknown>;
    expiresAt?: ISO8601;
    revokedAt?: ISO8601;
}
export type ActionType = "channel:create" | "agent:create";
export interface ActionCard {
    id: UUID;
    channelId: UUID;
    createdBy: UUID;
    targetUser: UUID;
    actionType: ActionType;
    actionData: Record<string, unknown>;
    status: "pending" | "approved" | "rejected";
    createdAt: ISO8601;
}
export interface Integration {
    id: UUID;
    serviceId: string;
    name: string;
    provider: string;
    config: Record<string, unknown>;
}
export interface AgentLogin {
    id: UUID;
    agentId: UUID;
    integrationId: UUID;
    status: "active" | "expired" | "revoked";
    expiresAt?: ISO8601;
}
/** agent:deliver 的 message 载荷（messages.ts / agents-dispatch.ts / agents-messages.ts 组装） */
export interface WsDeliverMessage {
    id: UUID;
    seq: number;
    /** "#general" 或 "dm:<uuid>"（daemon 端剥 # 前缀解析频道名） */
    channelId: string;
    senderId: UUID;
    senderName: string;
    senderHandle?: string;
    senderType: MessageType;
    content: string;
    time: ISO8601;
    threadId?: UUID | null;
    attachments?: AttachmentRef[];
    /** O15：回显给发送方，对账本地待确认消息 */
    clientNonce?: string;
    /** server 预过滤的「有权回应的 agent」handle 列表；空数组 = 有人被@但无人有权回应 */
    mentionAgents?: string[];
    /** DM 标记 + agent 接收方（无需 @ 唤醒） */
    dm?: boolean;
    dmAgentRecipients?: string[];
    dmPeerHandle?: string;
    /** 经理/worker 派发通知的显式路由目标（绕开 daemon 防自环） */
    forceDeliverTo?: string;
    /** T8：无 @ 顶层消息的单选分诊经理（server 按 is_manager 最早加入者选出） */
    triageAgents?: string[];
}
/** B1 结构化观察帧——规范定义在 shared，daemon agent-observation.ts 从此 re-export */
export interface ObservationFrame {
    agentName: string;
    /** 总线内自增序号（跨 agent 全局唯一，便于排序/去重） */
    seq: number;
    timestamp: number;
    kind: "system" | "text" | "thinking" | "tool_use" | "tool_result" | "turn_start" | "turn_end" | "error";
    /** 回合标识：stream-json 里 assistant message 的 id（没有则为 null） */
    turnId: string | null;
    payload: {
        text?: string;
        toolName?: string;
        toolUseId?: string;
        toolInput?: unknown;
        /** turn_end 时的结果摘要（耗时/cost/成功与否） */
        summary?: string;
    };
}
/** agent:start 的 config 变体（agents.ts 创建 / agents-public.ts PATCH） */
export interface WsAgentStartConfig {
    name?: string;
    displayName?: string;
    description?: string;
    runtime?: string;
    model?: string;
    runtime_profile?: {
        runtime?: string;
        model?: string;
    };
}
/** agent:start 的 agent 变体（agents-public.ts 公开注册） */
export interface WsAgentStartAgent {
    id?: UUID;
    name?: string;
    displayName?: string;
    description?: string;
    runtime?: string;
    model?: string;
    runtime_profile?: {
        runtime?: string;
        model?: string;
    };
}
/** reminder.fire 的 reminder 载荷（reminder-scheduler.ts 组装） */
export interface WsReminderFire {
    id: UUID;
    title: string;
    channel: string | null;
    kind: string;
    instructions: string | null;
}
/** notification.new 的 notification 载荷（notifications.ts createNotification 组装） */
export interface WsNotification {
    id: UUID;
    type: string;
    actorId?: UUID;
    actorName?: string | null;
    channelId?: UUID | null;
    messageId?: UUID | null;
    title: string;
    body?: string | null;
    metadata?: unknown;
    read?: boolean;
    createdAt?: ISO8601;
}
export type WsToDaemonMessage = {
    type: "connected";
    serverTime: ISO8601;
} | {
    type: "agent:start";
    agentId?: UUID;
    agent?: WsAgentStartAgent;
    config?: WsAgentStartConfig;
} | {
    type: "agent:stop";
    agentId: UUID;
} | {
    type: "agent:duty";
    agentId: UUID;
    name: string;
    duty: AgentDuty;
} | {
    type: "agent:deliver";
    seq?: number;
    message: WsDeliverMessage;
} | {
    type: "reminder.fire";
    agentId: UUID;
    reminder: WsReminderFire;
} | {
    type: "terminal:watch";
    agentName: string;
} | {
    type: "terminal:unwatch";
    agentName: string;
} | {
    type: "terminal:history";
    agentName: string;
} | {
    type: "terminal:resize";
    agentName: string;
    cols?: number;
    rows?: number;
} | {
    type: "workspace:read";
    requestId: string;
    agentName: string;
    path?: string;
} | {
    type: "ping";
};
/** Computer 能力地图：已装 / 未装 / 已装但平台未接线（P0 spawn 仅 claude） */
export type RuntimeProbeStatus = "installed" | "not_installed" | "installed_unsupported";
export interface RuntimeProbe {
    id: string;
    status: RuntimeProbeStatus;
    version?: string;
}
export declare const RUNTIME_CATALOG_IDS: readonly ["claude", "codex", "gemini", "opencode"];
export type RuntimeCatalogId = (typeof RUNTIME_CATALOG_IDS)[number];
/** P0 已接线、创建 picker 可收的 runtime */
export declare const WIRED_RUNTIME_IDS: readonly ["claude"];
export type WsFromDaemonMessage = {
    type: "ready";
    capabilities: string[];
    /** 新 daemon 发 RuntimeProbe[]；旧 daemon / 测试仍可能发 string[]，server 会归一化 */
    runtimes: RuntimeProbe[] | string[];
    hostname: string;
    daemonVersion: string;
    os?: string;
    arch?: string;
} | {
    type: "agent:status";
    agentId: string;
    agentName: string;
    status: string;
    detail: string;
} | {
    type: "agent:delivery-queued";
    agentName: string;
    channelName: string;
} | {
    type: "agent:delivery-dead-letter";
    agentName: string;
    channelName: string;
    error: string;
} | {
    type: "agent:tool-call";
    agentName: string;
    agentId: string;
    toolName: string | null;
    toolUseId: string | null;
    status: "pending" | "completed";
    text: string | null;
    time: ISO8601;
} | {
    type: "terminal:frame";
    agentName: string;
    screen: string;
    status: string;
    time: ISO8601;
} | {
    type: "terminal:obs-frame";
    agentName: string;
    frame: ObservationFrame;
} | {
    type: "terminal:obs-history";
    agentName: string;
    frames: ObservationFrame[];
} | {
    type: "terminal:history";
    agentName: string;
    text: string;
} | {
    type: "agent:progress";
    agentName: string;
    channelName: string;
    headline: string;
    phase: "start" | "update" | "end";
} | {
    type: "workspace:result";
    requestId: string;
    agentName: string;
    exists: boolean;
    files?: {
        path: string;
        bytes: number;
        mtime: string;
    }[];
    path?: string;
    content?: string;
    bytes?: number;
    error?: string;
} | {
    type: "pong";
};
export type WsToBrowserMessage = {
    type: "connected";
    time: ISO8601;
} | {
    type: "agent:deliver";
    seq?: number;
    message: WsDeliverMessage;
} | {
    type: "message:update";
    message: {
        id: UUID;
        content: string;
        editedAt: ISO8601;
    };
} | {
    type: "message:delete";
    message: {
        id: UUID;
    };
} | {
    type: "notification.new";
    notification: WsNotification;
} | {
    type: "agent:status";
    agentId: string;
    agentName: string;
    status: string;
    detail: string;
} | {
    type: "agent:presence";
    agentId: UUID;
    agentName: string;
    duty: AgentDuty;
    computerOnline: boolean;
    presence: AgentPresence;
} | {
    type: "agent:delivery-queued";
    agentName: string;
    channelName: string;
} | {
    type: "agent:delivery-dead-letter";
    agentName: string;
    channelName: string;
    error: string;
} | {
    type: "terminal:history";
    agentName: string;
    text: string;
} | {
    type: "terminal:obs-history";
    agentName: string;
    frames: ObservationFrame[];
} | {
    type: "terminal:frame";
    agentName: string;
    screen: string;
    status: string;
    time: ISO8601;
} | {
    type: "terminal:obs-frame";
    agentName: string;
    frame: ObservationFrame;
} | {
    type: "agent:progress";
    agentName: string;
    channelName: string;
    headline: string;
    phase: "start" | "update" | "end";
} | {
    type: "workspace:result";
    requestId: string;
    agentName: string;
    exists: boolean;
    files?: {
        path: string;
        bytes: number;
        mtime: string;
    }[];
    path?: string;
    content?: string;
    bytes?: number;
    error?: string;
};
export type WsFromBrowserMessage = {
    type: "terminal:watch";
    agentName: string;
} | {
    type: "terminal:unwatch";
    agentName: string;
} | {
    type: "terminal:history";
    agentName: string;
} | {
    type: "terminal:resize";
    agentName: string;
    cols?: number;
    rows?: number;
} | {
    type: "pong";
};
export interface AgentWorkspaceFile {
    path: string;
    bytes: number;
    mtime: string;
}
export interface AgentWorkspaceSnapshot {
    exists: boolean;
    files: AgentWorkspaceFile[];
    path?: string;
    content?: string;
    bytes?: number;
    error?: string;
}
/** broadcast(channelId, …) 允许的频道广播事件子集（server 路由组包发频道成员） */
export type WsChannelBroadcast = Extract<WsToBrowserMessage, {
    type: "agent:deliver" | "message:update" | "message:delete";
}>;
/** @deprecated 用 WsToBrowserMessage */
export type WsServerMessage = WsToBrowserMessage;
/** @deprecated 用 WsFromBrowserMessage */
export type WsClientMessage = WsFromBrowserMessage;
/** @deprecated 用 WsToBrowserMessage["type"] */
export type WsServerMessageType = WsServerMessage["type"];
/** @deprecated 用 WsFromBrowserMessage["type"] */
export type WsClientMessageType = WsClientMessage["type"];
export { PROGRESS_PREFIX, channelProgressEnabled, DEFAULT_PROGRESS_THROTTLE_MS, formatProgressMessage, isProgressContent, labelTool, readProgressThrottleMs, summarizeProgress, type ProgressFrame, type ProgressSnapshot, type ProgressToolItem, } from "./progress.js";
export { PRESENCE_LABEL, agentListFields, composePresence, parseAgentDuty, presenceIsOnline, type AgentDuty, type AgentPresence, type AgentRuntimeHint, } from "./presence.js";
export interface ApiError {
    ok: false;
    code: string;
    message: string;
}
export interface ApiOk<T = unknown> {
    ok: true;
    data: T;
}
export type ApiResponse<T = unknown> = ApiOk<T> | ApiError;
export interface PaginationOpts {
    before?: number;
    after?: number;
    around?: UUID;
    limit?: number;
}
//# sourceMappingURL=index.d.ts.map