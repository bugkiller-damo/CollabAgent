import { z } from "zod";

/**
 * WS 入站消息运行时校验（评估报告 P1.28：此前 `JSON.parse(raw) as X` 无任何运行时
 * 校验——畸形/恶意帧的字段以 undefined/错型流入 switch 分支，靠「恰好没人解引用崩」
 * 而不崩；此处补上纵深防御：type 白名单 + 关键字段类型校验，不过关的帧整帧丢弃
 * （与既有 try/catch 同语义：不回错、不断连，只 warn）。
 *
 * 严格度取舍（立此存照）：
 * - schema 逐字段对齐 @collabagent/shared 的 WsFromDaemonMessage / WsFromBrowserMessage
 *   union（required 照抄）——改字段先改 shared（既定纪律），这里挡的是「不守约的发送方」；
 * - 未知 type / 错型字段 → 丢帧 + 限频 warn（10s 一条，防劣质客户端刷日志）；
 * - .passthrough()：多余字段放行（shared 加字段后旧 server 不拒帧，前向兼容）；
 * - ready 的字段全部 optional：handler 对每个字段都 if-guard（persistComputerReady /
 *   daemonMeta 更新），且 scripts/probe-p127-presence.mjs 只发 {type:"ready",runtimes:[]}，
 *   强制 required 会拒掉合法的轻量握手；
 * - opaque 载荷（obs frame/frames）只验「是对象」，内容不深校验——服务端只转发不解构，
 *   深校验的维护成本高于收益。
 */

/** 任意对象（不深校验内容——服务端仅转发的 opaque 载荷） */
const objectVal = z.custom<any>((v) => typeof v === "object" && v !== null);
const str = z.string();

// ---------- daemon → server（WsFromDaemonMessage，12 成员） ----------

const readySchema = z
  .object({
    type: z.literal("ready"),
    capabilities: z.array(z.string()).optional(),
    runtimes: z.array(z.unknown()).optional(), // RuntimeProbe[] | string[]，normalizeRuntimes 归一化
    hostname: str.optional(),
    daemonVersion: str.optional(),
    os: str.optional(),
    arch: str.optional(),
  })
  .passthrough();

const agentStatusSchema = z
  .object({
    type: z.literal("agent:status"),
    agentId: str,
    agentName: str,
    status: str,
    detail: str,
  })
  .passthrough();

const deliveryQueuedSchema = z
  .object({ type: z.literal("agent:delivery-queued"), agentName: str, channelName: str })
  .passthrough();

const deliveryDeadLetterSchema = z
  .object({
    type: z.literal("agent:delivery-dead-letter"),
    agentName: str,
    channelName: str,
    error: str,
  })
  .passthrough();

const toolCallSchema = z
  .object({
    type: z.literal("agent:tool-call"),
    agentName: str,
    agentId: str,
    toolName: str.nullable(),
    toolUseId: str.nullable(),
    status: z.enum(["pending", "completed"]),
    text: str.nullable(),
    time: str,
  })
  .passthrough();

const terminalFrameSchema = z
  .object({
    type: z.literal("terminal:frame"),
    agentName: str,
    screen: str,
    status: str,
    time: str,
  })
  .passthrough();

const obsFrameSchema = z
  .object({ type: z.literal("terminal:obs-frame"), agentName: str, frame: objectVal })
  .passthrough();

const obsHistorySchema = z
  .object({ type: z.literal("terminal:obs-history"), agentName: str, frames: z.array(objectVal) })
  .passthrough();

const terminalHistorySchema = z
  .object({ type: z.literal("terminal:history"), agentName: str, text: str })
  .passthrough();

const progressSchema = z
  .object({
    type: z.literal("agent:progress"),
    agentName: str,
    channelName: str,
    headline: str,
    phase: z.enum(["start", "update", "end"]),
  })
  .passthrough();

const workspaceResultSchema = z
  .object({
    type: z.literal("workspace:result"),
    requestId: str,
    agentName: str,
    exists: z.boolean(),
    files: z.array(z.object({ path: str, bytes: z.number(), mtime: str }).passthrough()).optional(),
    path: str.optional(),
    content: str.optional(),
    bytes: z.number().optional(),
    error: str.optional(),
  })
  .passthrough();

const pongSchema = z.object({ type: z.literal("pong") }).passthrough();

export const wsFromDaemonSchema = z.union([
  readySchema,
  agentStatusSchema,
  deliveryQueuedSchema,
  deliveryDeadLetterSchema,
  toolCallSchema,
  terminalFrameSchema,
  obsFrameSchema,
  obsHistorySchema,
  terminalHistorySchema,
  progressSchema,
  workspaceResultSchema,
  pongSchema,
]);

// ---------- browser → server（WsFromBrowserMessage，5 成员） ----------

export const wsFromBrowserSchema = z.union([
  z.object({ type: z.literal("terminal:watch"), agentName: str }).passthrough(),
  z.object({ type: z.literal("terminal:unwatch"), agentName: str }).passthrough(),
  z.object({ type: z.literal("terminal:history"), agentName: str }).passthrough(),
  z
    .object({
      type: z.literal("terminal:resize"),
      agentName: str,
      cols: z.number().optional(),
      rows: z.number().optional(),
    })
    .passthrough(),
  pongSchema,
]);

/** 解析 + 校验一帧入站消息；非法（非 JSON / 未知 type / 错型字段）返回 null（丢帧）。 */
export function parseWsInbound<T>(
  raw: string,
  schema: {
    safeParse(data: unknown): { success: true; data: T } | { success: false; error: { issues: unknown[] } };
  },
  direction: string,
): T | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null; // 非 JSON：与旧行为一致静默丢弃
  }
  const r = schema.safeParse(json);
  if (!r.success) {
    warnInvalidFrame(direction, raw, r.error.issues.length);
    return null;
  }
  return r.data;
}

// 劣质客户端可高频灌坏帧刷日志——限频：每方向最多 10s 一条 warn
const lastWarnAt = new Map<string, number>();
function warnInvalidFrame(direction: string, raw: string, issueCount: number): void {
  const now = Date.now();
  const last = lastWarnAt.get(direction) || 0;
  if (now - last < 10_000) return;
  lastWarnAt.set(direction, now);
  console.warn(`[WS] dropped invalid ${direction} frame (issues=${issueCount}): ${raw.slice(0, 120)}`);
}
