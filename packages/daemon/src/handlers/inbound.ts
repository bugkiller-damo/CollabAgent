/**
 * server → daemon WS 入站收口（P1.13）。
 *
 * `WsToDaemonMessage` 已在 shared（S2.2）；这里不再 `as Record` 后满地 `as string`。
 * 线协议有松散变体：`thread_id` 蛇形、`agent:deliver` 的 `message || 自身`、
 * `agent:start` 三种嵌套、缺字段。本函数归一化成联合成员，handlers 吃收窄后的类型。
 * 未知 type / 非对象 → null（与旧 switch 落空一致，静默忽略）。
 */

import type {
  AgentDuty,
  WsAgentStartAgent,
  WsAgentStartConfig,
  WsDeliverMessage,
  WsReminderFire,
  WsToDaemonMessage,
} from "@collabagent/shared";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const asFiniteNumber = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const asStringList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

const readRuntimeProfile = (v: unknown): { runtime?: string; model?: string } | undefined => {
  if (!isRecord(v)) return undefined;
  return { runtime: asString(v.runtime), model: asString(v.model) };
};

const readAgentStartAgent = (v: unknown): WsAgentStartAgent | undefined => {
  if (!isRecord(v)) return undefined;
  return {
    id: asString(v.id),
    name: asString(v.name),
    displayName: asString(v.displayName),
    description: asString(v.description),
    runtime: asString(v.runtime),
    model: asString(v.model),
    runtime_profile: readRuntimeProfile(v.runtime_profile),
  };
};

const readAgentStartConfig = (v: unknown): WsAgentStartConfig | undefined => {
  if (!isRecord(v)) return undefined;
  return {
    name: asString(v.name),
    displayName: asString(v.displayName),
    description: asString(v.description),
    runtime: asString(v.runtime),
    model: asString(v.model),
    runtime_profile: readRuntimeProfile(v.runtime_profile),
  };
};

/** `message` 优先；旧/测试载荷可能把字段摊在顶层。`mentionAgents` 缺省 ≠ 空数组。 */
export const readDeliverMessage = (raw: Record<string, unknown>): WsDeliverMessage => {
  const src = isRecord(raw.message) ? raw.message : raw;
  const senderType = src.senderType === "agent" || src.senderType === "system" ? src.senderType : "human";
  return {
    id: asString(src.id) ?? "",
    seq: asFiniteNumber(src.seq) ?? 0,
    channelId: asString(src.channelId) ?? "general",
    senderId: asString(src.senderId) ?? "",
    senderName: asString(src.senderName) ?? "",
    senderHandle: asString(src.senderHandle),
    senderType,
    content: asString(src.content) ?? "",
    time: asString(src.time) ?? "",
    threadId: asString(src.threadId) ?? asString(src.thread_id) ?? null,
    mentionAgents: asStringList(src.mentionAgents),
    dm: src.dm === true,
    dmAgentRecipients: asStringList(src.dmAgentRecipients),
    dmPeerHandle: asString(src.dmPeerHandle),
    forceDeliverTo: asString(src.forceDeliverTo),
    triageAgents: asStringList(src.triageAgents),
  };
};

const readReminder = (v: unknown): WsReminderFire => {
  const r = isRecord(v) ? v : {};
  return {
    id: asString(r.id) ?? "",
    title: asString(r.title) ?? "",
    channel: asString(r.channel) ?? null,
    kind: asString(r.kind) ?? "reminder",
    instructions: asString(r.instructions) ?? null,
  };
};

export const parseWsToDaemonMessage = (raw: unknown): WsToDaemonMessage | null => {
  if (!isRecord(raw) || typeof raw.type !== "string") return null;

  switch (raw.type) {
    case "connected":
      return { type: "connected", serverTime: asString(raw.serverTime) ?? "" };
    case "ping":
      return { type: "ping" };
    case "agent:start":
      return {
        type: "agent:start",
        agentId: asString(raw.agentId),
        agent: readAgentStartAgent(raw.agent),
        config: readAgentStartConfig(raw.config),
      };
    case "agent:stop":
      return { type: "agent:stop", agentId: asString(raw.agentId) ?? "" };
    case "agent:duty": {
      const duty: AgentDuty = raw.duty === "off" ? "off" : "on";
      return {
        type: "agent:duty",
        agentId: asString(raw.agentId) ?? "",
        name: asString(raw.name) ?? "",
        duty,
      };
    }
    case "agent:deliver":
      return {
        type: "agent:deliver",
        seq: asFiniteNumber(raw.seq),
        message: readDeliverMessage(raw),
      };
    case "reminder.fire":
      return {
        type: "reminder.fire",
        agentId: asString(raw.agentId) ?? "",
        reminder: readReminder(raw.reminder),
      };
    case "terminal:watch":
      return { type: "terminal:watch", agentName: asString(raw.agentName) ?? "" };
    case "terminal:unwatch":
      return { type: "terminal:unwatch", agentName: asString(raw.agentName) ?? "" };
    case "terminal:history":
      return { type: "terminal:history", agentName: asString(raw.agentName) ?? "" };
    case "terminal:resize":
      return {
        type: "terminal:resize",
        agentName: asString(raw.agentName) ?? "",
        cols: asFiniteNumber(raw.cols),
        rows: asFiniteNumber(raw.rows),
      };
    case "workspace:read":
      return {
        type: "workspace:read",
        requestId: asString(raw.requestId) ?? "",
        agentName: asString(raw.agentName) ?? "",
        path: asString(raw.path),
      };
    default:
      return null;
  }
};
