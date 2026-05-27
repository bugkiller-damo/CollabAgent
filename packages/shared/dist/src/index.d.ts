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
    archived: boolean;
    joined?: boolean;
    memberCount: number;
    createdAt: ISO8601;
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
export interface Reminder {
    id: UUID;
    ownerId: UUID;
    title: string;
    fireAt: ISO8601;
    repeatRule?: RepeatRule;
    channelRef?: string;
    anchorMsgId?: UUID;
    status: ReminderStatus;
    createdAt: ISO8601;
}
export type ReminderEventType = "created" | "fired" | "snoozed" | "updated" | "canceled" | "dismissed";
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
export type WsServerMessageType = "agent:deliver" | "agent:start" | "agent:stop" | "agent:status" | "agent:activity_probe" | "reminder.upsert" | "reminder.cancel" | "reminder.snapshot" | "ping";
export type WsClientMessageType = "ready" | "agent:deliver:ack" | "agent:activity" | "agent:status" | "pong";
export interface WsServerMessage {
    type: WsServerMessageType;
    seq?: number;
    message?: Message;
    deliveryId?: UUID;
    reminder?: Reminder;
    reminders?: Reminder[];
    traceparent?: string;
}
export interface WsClientMessage {
    type: WsClientMessageType;
    seq?: number;
    status?: string;
    traceparent?: string;
}
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