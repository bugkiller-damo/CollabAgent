/**
 * Phase 2：SARP/1（slock.agent-runtime v1）协议编解码与 schema 校验。
 * 见 docs/2026-09-20/02-daemon-langchain-langgraph-runtime-design.md §8。
 *
 * 边界纪律：
 * - 本模块只做「线格式 ↔ 类型化消息」转换与协议级校验（信封、schema、
 *   入向 seq 单调性）。回合级状态机（eventSeq、turnId 匹配、唯一终态、
 *   empty-success）在 drivers/persistent-jsonl-worker.ts。
 * - stdout 只承载协议帧；worker 日志只能走 stderr（§8.1.4）。
 * - 未知消息仅当显式 `optional: true` 时忽略；已知类型即使 optional 也必须
 *   通过 schema 校验（§8.1.5/§8.1.6）。
 * - wire 错误码经显式映射表进 DispatchErrorCode——worker 的任意字符串
 *   不允许直接注入内部错误联合（§15.4）；未映射码收敛为 worker-error。
 */

import { isPlainObject } from "./claude-stream.js";
import { DispatchError, type DispatchErrorCode } from "./errors.js";

export const SARP_PROTOCOL = "slock.agent-runtime";
export const SARP_VERSION = 1;
/** §8.1.3：单帧上限 1 MiB（超了视为协议违规，当前 worker 终止） */
export const SARP_MAX_FRAME_BYTES = 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Daemon → Worker（编码）                                              */
/* ------------------------------------------------------------------ */

export interface SarpMcpDescriptor {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface SarpInitializeFields {
  /** §8.2：握手关联 id——runtime.ready 必须原样回显 */
  requestId: string;
  agent: { id: string; name: string; displayName?: string; description?: string };
  /**
   * Phase 5 §11.2：revision = manifest 条目修订（entry.revision）。worker 用
   * runtime.id+entrypoint+revision+model 构造 checkpoint 命名空间——runtime/
   * entrypoint/model/manifest 任一变化都不得复用旧 checkpoint thread。
   */
  runtime: { id: string; entrypoint: string; model?: string; revision?: string };
  workspace: { path: string };
  platform: {
    systemPrompt?: string;
    serverUrl?: string;
    tokenFile?: string;
    mcp?: SarpMcpDescriptor;
  };
  limits: { maxFrameBytes: number; silenceTimeoutMs: number; shutdownTimeoutMs?: number };
}

export interface SarpTurnStartFields {
  turnId: string;
  conversationId: string;
  attempt: number;
  source: { kind: string; channel?: string; threadId?: string; sender?: string };
  prompt: string;
  resume?: { interruptId: string; resumeToken: string; value: string };
}

export type SarpDaemonFrame =
  | { type: "initialize"; fields: SarpInitializeFields }
  | { type: "turn.start"; fields: SarpTurnStartFields }
  | { type: "turn.cancel"; fields: { turnId: string; reason: string } }
  | { type: "shutdown"; fields: { reason?: string; timeoutMs?: number } };

/** 编码一帧（含尾部换行）。seq 由调用方（session）维护单调递增。 */
export const encodeSarpFrame = (frame: SarpDaemonFrame, seq: number, opts?: { timestamp?: string }): string =>
  JSON.stringify({
    protocol: SARP_PROTOCOL,
    version: SARP_VERSION,
    type: frame.type,
    seq,
    timestamp: opts?.timestamp ?? new Date().toISOString(),
    ...frame.fields,
  }) + "\n";

/* ------------------------------------------------------------------ */
/* Worker → Daemon（解码）                                              */
/* ------------------------------------------------------------------ */

export type SarpErrorReason =
  | "frame-too-large"
  | "invalid-json"
  | "invalid-envelope"
  | "unsupported-version"
  | "invalid-schema"
  | "unexpected-message";

export class SarpProtocolError extends Error {
  readonly reason: SarpErrorReason;
  readonly frameType?: string;

  constructor(reason: SarpErrorReason, message: string, frameType?: string) {
    super(message);
    this.name = "SarpProtocolError";
    this.reason = reason;
    this.frameType = frameType;
  }
}

export interface SarpWireError {
  code: string;
  message: string;
  retryable?: boolean;
  retryAfterMs?: number;
}

export interface SarpUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  model?: string;
}

export interface SarpCapabilities {
  persistentProcess?: boolean;
  streamingText?: boolean;
  toolEvents?: boolean;
  durableThreads?: boolean;
  interrupts?: boolean;
  mcp?: boolean;
  usage?: "none" | "tokens" | "cost" | string;
  pty?: boolean;
  maxConcurrency?: number;
}

export type SarpWorkerMessage =
  | {
      type: "runtime.ready";
      seq: number;
      /** §8.3：必须回显 initialize.requestId（session 层校验一致性） */
      requestId?: string;
      runtime: { id: string; frameworkVersion?: string; bridgeVersion?: string };
      capabilities: SarpCapabilities;
      model?: { selected?: string; overrides?: boolean };
    }
  | { type: "runtime.stopped"; seq: number; reason?: string }
  | { type: "runtime.error"; seq: number; requestId?: string; error: SarpWireError }
  | { type: "runtime.warning"; seq: number; code?: string; message: string }
  | { type: "assistant.delta"; seq: number; turnId: string; eventSeq: number; text: string }
  | { type: "assistant.message"; seq: number; turnId: string; eventSeq: number; text: string }
  | { type: "assistant.progress"; seq: number; turnId: string; eventSeq: number; message: string }
  | {
      // §8.5：callId / input 是顶层字段，tool 内只有 name/provider/operation
      type: "tool.start";
      seq: number;
      turnId: string;
      eventSeq: number;
      callId: string;
      tool: { name: string; provider?: string; operation?: string };
      input?: unknown;
    }
  | {
      type: "tool.end";
      seq: number;
      turnId: string;
      eventSeq: number;
      callId: string;
      tool: { name?: string; provider?: string; operation?: string };
      ok: boolean;
      output?: unknown;
      error?: string;
    }
  | { type: "usage"; seq: number; turnId: string; eventSeq: number; usage: SarpUsage }
  | {
      type: "turn.interrupt";
      seq: number;
      turnId: string;
      eventSeq: number;
      interruptId: string;
      resumeToken: string;
      prompt: string;
      payload?: unknown;
    }
  | {
      type: "turn.end";
      seq: number;
      turnId: string;
      eventSeq: number;
      status: "success" | "interrupted" | "cancelled" | "error";
      finalText?: string;
      sessionRef?: string;
      usage?: SarpUsage;
      interrupt?: { interruptId: string; resumeToken: string; prompt: string; payload?: unknown };
      error?: SarpWireError;
    };

/* ---------------------------- 校验工具 ----------------------------- */

// 注意：必须用 function 声明——TS 的 never-returning 调用收窄不覆盖 const 箭头函数
function fail(reason: SarpErrorReason, msg: string, frameType?: string): never {
  throw new SarpProtocolError(reason, msg, frameType);
}

const reqStr = (o: Record<string, unknown>, key: string, t: string): string => {
  const v = o[key];
  if (typeof v !== "string" || v === "") fail("invalid-schema", `${t}.${key}: non-empty string required`, t);
  return v as string;
};

const optStr = (o: Record<string, unknown>, key: string, t: string): string | undefined => {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") fail("invalid-schema", `${t}.${key}: string required`, t);
  return v as string;
};

const reqObj = (o: Record<string, unknown>, key: string, t: string): Record<string, unknown> => {
  const v = o[key];
  if (!isPlainObject(v)) fail("invalid-schema", `${t}.${key}: object required`, t);
  return v as Record<string, unknown>;
};

const optObj = (o: Record<string, unknown>, key: string, t: string): Record<string, unknown> | undefined => {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (!isPlainObject(v)) fail("invalid-schema", `${t}.${key}: object required`, t);
  return v as Record<string, unknown>;
};

const reqInt = (o: Record<string, unknown>, key: string, t: string): number => {
  const v = o[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0)
    fail("invalid-schema", `${t}.${key}: non-negative integer required`, t);
  return v as number;
};

const optNum = (o: Record<string, unknown>, key: string, t: string): number | undefined => {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) fail("invalid-schema", `${t}.${key}: finite number required`, t);
  return v as number;
};

const optBool = (o: Record<string, unknown>, key: string, t: string): boolean | undefined => {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") fail("invalid-schema", `${t}.${key}: boolean required`, t);
  return v as boolean;
};

/** 回合内事件的公共三件套：turnId + eventSeq 必须存在（§8.4.1） */
const turnScope = (o: Record<string, unknown>, t: string): { turnId: string; eventSeq: number } => ({
  turnId: reqStr(o, "turnId", t),
  eventSeq: reqInt(o, "eventSeq", t),
});

const parseUsage = (o: Record<string, unknown> | undefined): SarpUsage | undefined => {
  if (!o) return undefined;
  const u: SarpUsage = {};
  u.inputTokens = optNum(o, "inputTokens", "usage");
  u.outputTokens = optNum(o, "outputTokens", "usage");
  u.totalTokens = optNum(o, "totalTokens", "usage");
  u.costUsd = optNum(o, "costUsd", "usage");
  u.durationMs = optNum(o, "durationMs", "usage");
  u.numTurns = optNum(o, "numTurns", "usage");
  u.model = optStr(o, "model", "usage");
  return u;
};

const parseWireError = (o: Record<string, unknown>, key: string, t: string): SarpWireError => {
  const e = reqObj(o, key, t);
  const err: SarpWireError = {
    code: reqStr(e, "code", `${t}.${key}`),
    message: reqStr(e, "message", `${t}.${key}`),
  };
  err.retryable = optBool(e, "retryable", `${t}.${key}`);
  err.retryAfterMs = optNum(e, "retryAfterMs", `${t}.${key}`);
  return err;
};

const parseInterrupt = (o: Record<string, unknown>, t: string) => ({
  interruptId: reqStr(o, "interruptId", t),
  resumeToken: reqStr(o, "resumeToken", t),
  prompt: reqStr(o, "prompt", t),
  payload: o.payload,
});

/* ----------------------------- 解码器 ------------------------------ */

/**
 * 解码一行 worker → daemon 帧。
 * - 返回 null：未知 type 且 optional:true（§8.1.5 显式忽略）。
 * - 抛 SarpProtocolError：坏帧 / 信封非法 / 版本不符 / schema 失败 / 未知且未标 optional。
 * - 入向 seq 单调性由 SarpInbound.next 强制（本函数无状态）。
 */
export const decodeSarpWorkerFrame = (line: string | Buffer): SarpWorkerMessage | null => {
  const text = typeof line === "string" ? line : line.toString("utf-8");
  if (Buffer.byteLength(text, "utf-8") > SARP_MAX_FRAME_BYTES) {
    fail("frame-too-large", `frame exceeds ${SARP_MAX_FRAME_BYTES} bytes`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("invalid-json", "frame is not valid JSON");
  }
  if (!isPlainObject(raw)) fail("invalid-envelope", "frame must be a JSON object");
  const o = raw as Record<string, unknown>;
  const t = typeof o.type === "string" ? o.type : undefined;

  if (o.protocol !== SARP_PROTOCOL) fail("invalid-envelope", `protocol must be "${SARP_PROTOCOL}"`, t);
  if (o.version !== SARP_VERSION) fail("unsupported-version", `version must be ${SARP_VERSION}`, t);
  if (typeof t !== "string" || t === "") fail("invalid-envelope", "type: non-empty string required");
  const seq = typeof o.seq === "number" && Number.isInteger(o.seq) && o.seq > 0 ? o.seq : null;
  if (seq === null) fail("invalid-envelope", "seq: positive integer required", t);
  if (typeof o.timestamp !== "string" || o.timestamp === "") {
    fail("invalid-envelope", "timestamp: ISO 8601 string required", t);
  }
  const optional = o.optional === true;
  if (o.optional !== undefined && typeof o.optional !== "boolean") {
    fail("invalid-envelope", "optional: boolean required", t);
  }

  switch (t) {
    case "runtime.ready": {
      const rt = reqObj(o, "runtime", t);
      const caps = optObj(o, "capabilities", t) ?? {};
      const model = optObj(o, "model", t);
      return {
        type: t,
        seq,
        requestId: optStr(o, "requestId", t),
        runtime: {
          id: reqStr(rt, "id", t),
          frameworkVersion: optStr(rt, "frameworkVersion", t),
          bridgeVersion: optStr(rt, "bridgeVersion", t),
        },
        capabilities: {
          persistentProcess: optBool(caps, "persistentProcess", t),
          streamingText: optBool(caps, "streamingText", t),
          toolEvents: optBool(caps, "toolEvents", t),
          durableThreads: optBool(caps, "durableThreads", t),
          interrupts: optBool(caps, "interrupts", t),
          mcp: optBool(caps, "mcp", t),
          usage: optStr(caps, "usage", t),
          pty: optBool(caps, "pty", t),
          maxConcurrency: optNum(caps, "maxConcurrency", t),
        },
        model: model
          ? { selected: optStr(model, "selected", t), overrides: optBool(model, "overrides", t) }
          : undefined,
      };
    }
    case "runtime.stopped":
      return { type: t, seq, reason: optStr(o, "reason", t) };
    case "runtime.error":
      return { type: t, seq, requestId: optStr(o, "requestId", t), error: parseWireError(o, "error", t) };
    case "runtime.warning":
      return { type: t, seq, code: optStr(o, "code", t), message: reqStr(o, "message", t) };
    case "assistant.delta":
      return { type: t, seq, ...turnScope(o, t), text: reqStr(o, "text", t) };
    case "assistant.message":
      return { type: t, seq, ...turnScope(o, t), text: reqStr(o, "text", t) };
    case "assistant.progress":
      return { type: t, seq, ...turnScope(o, t), message: reqStr(o, "message", t) };
    case "tool.start": {
      const tool = reqObj(o, "tool", t);
      return {
        type: t,
        seq,
        ...turnScope(o, t),
        callId: reqStr(o, "callId", t),
        tool: {
          name: reqStr(tool, "name", `${t}.tool`),
          provider: optStr(tool, "provider", `${t}.tool`),
          operation: optStr(tool, "operation", `${t}.tool`),
        },
        input: o.input,
      };
    }
    case "tool.end": {
      const tool = optObj(o, "tool", t) ?? {};
      const ok = o.ok;
      if (typeof ok !== "boolean") fail("invalid-schema", `${t}.ok: boolean required`, t);
      return {
        type: t,
        seq,
        ...turnScope(o, t),
        callId: reqStr(o, "callId", t),
        tool: {
          name: optStr(tool, "name", `${t}.tool`),
          provider: optStr(tool, "provider", `${t}.tool`),
          operation: optStr(tool, "operation", `${t}.tool`),
        },
        ok,
        output: o.output,
        error: optStr(o, "error", t),
      };
    }
    case "usage": {
      const u = reqObj(o, "usage", t);
      return { type: t, seq, ...turnScope(o, t), usage: parseUsage(u)! };
    }
    case "turn.interrupt":
      return { type: t, seq, ...turnScope(o, t), ...parseInterrupt(o, t) };
    case "turn.end": {
      const status = o.status;
      if (status !== "success" && status !== "interrupted" && status !== "cancelled" && status !== "error") {
        fail("invalid-schema", `${t}.status: invalid terminal status`, t);
      }
      const intr = optObj(o, "interrupt", t);
      const errObj = optObj(o, "error", t);
      return {
        type: t,
        seq,
        ...turnScope(o, t),
        status,
        finalText: optStr(o, "finalText", t),
        sessionRef: optStr(o, "sessionRef", t),
        usage: parseUsage(optObj(o, "usage", t)),
        interrupt: intr ? parseInterrupt(intr, `${t}.interrupt`) : undefined,
        error: errObj
          ? {
              code: reqStr(errObj, "code", `${t}.error`),
              message: reqStr(errObj, "message", `${t}.error`),
              retryable: optBool(errObj, "retryable", `${t}.error`),
              retryAfterMs: optNum(errObj, "retryAfterMs", `${t}.error`),
            }
          : undefined,
      };
    }
    default:
      // §8.1.5：未知 type 仅当显式 optional:true 才允许忽略
      if (optional) return null;
      fail("unexpected-message", `unknown message type: ${t}`, t);
  }
};

/**
 * 入向帧流校验器：在 decode 之上强制 worker→daemon seq 单调递增（§8.1.2）。
 * 每个 worker 进程一个实例；握手与回合帧共用同一序号空间。
 */
export class SarpInbound {
  private lastSeq = 0;

  next(line: string | Buffer): SarpWorkerMessage | null {
    const msg = decodeSarpWorkerFrame(line);
    if (msg === null) return null;
    if (msg.seq <= this.lastSeq) {
      fail("unexpected-message", `inbound seq regression: ${msg.seq} <= ${this.lastSeq}`, msg.type);
    }
    this.lastSeq = msg.seq;
    return msg;
  }
}

/* --------------------------- 错误码映射 ----------------------------- */

/**
 * wire error.code → DispatchErrorCode（§15.4 显式映射；worker 字符串不直接入联合）。
 * 未映射码收敛为 worker-error（永久）——worker 想要可重试必须报已知码。
 */
const WIRE_ERROR_MAP: Record<string, DispatchErrorCode> = {
  MODEL_RATE_LIMITED: "provider-rate-limited",
  PROVIDER_RATE_LIMITED: "provider-rate-limited",
  RATE_LIMITED: "provider-rate-limited",
  MODEL_AUTH_FAILED: "provider-auth-failed",
  PROVIDER_AUTH_FAILED: "provider-auth-failed",
  AUTH_FAILED: "provider-auth-failed",
  MODEL_NETWORK_FAILED: "provider-network-failed",
  PROVIDER_NETWORK_FAILED: "provider-network-failed",
  NETWORK_FAILED: "provider-network-failed",
  MODEL_NOT_ALLOWED: "model-not-allowed",
  GRAPH_INPUT_INVALID: "graph-input-invalid",
  INPUT_INVALID: "graph-input-invalid",
  MCP_START_FAILED: "mcp-start-failed",
  RUNTIME_ID_MISMATCH: "runtime-id-mismatch",
  DURABLE_THREADS_REQUIRED: "durable-threads-required",
  PROTOCOL_VERSION_UNSUPPORTED: "protocol-version-unsupported",
  PROTOCOL_VIOLATION: "protocol-violation",
  INTERRUPT_NOT_FOUND: "interrupt-not-found",
  COMMAND_NOT_FOUND: "command-not-found",
  CWD_NOT_FOUND: "cwd-not-found",
  SECRET_ENV_MISSING: "secret-env-missing",
  EMPTY_SUCCESS: "empty-success",
};

export const mapWireError = (wire: SarpWireError): DispatchError => {
  const code = WIRE_ERROR_MAP[wire.code] ?? "worker-error";
  const suffix = wire.code in WIRE_ERROR_MAP ? "" : ` (unmapped code ${wire.code})`;
  return new DispatchError(code, `[worker] ${wire.code}: ${wire.message}${suffix}`, {
    retryAfterMs: wire.retryAfterMs,
  });
};
