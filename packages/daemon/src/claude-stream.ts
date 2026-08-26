/**
 * Claude Code `--output-format stream-json` 事件的保守联合类型（P1.13）。
 *
 * 不走 Zod：热路径上每行 stdout 一次 parse，未知 type / 多余字段必须静默忽略
 * （`streamEventToFrames` 对 mystery/null 返回 []，单测锁死）。在 JSON.parse
 * 边界用 `asClaudeStreamEvent` 收成联合，之后不再 `ev: any`。
 */

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export type ClaudeStreamSystemEvent = {
  type: "system";
  subtype?: string;
  session_id?: string;
  model?: string;
};

export type ClaudeStreamAssistantEvent = {
  type: "assistant";
  message?: { id?: string; content?: unknown };
};

export type ClaudeStreamUserEvent = {
  type: "user";
  message?: { role?: string; content?: unknown };
};

export type ClaudeStreamResultEvent = {
  type: "result";
  subtype?: string;
  duration_ms?: unknown;
  total_cost_usd?: unknown;
  num_turns?: unknown;
  result?: unknown;
  session_id?: string;
};

export type ClaudeStreamEvent =
  | ClaudeStreamSystemEvent
  | ClaudeStreamAssistantEvent
  | ClaudeStreamUserEvent
  | ClaudeStreamResultEvent;

const KNOWN_TYPES = new Set(["system", "assistant", "user", "result"]);

/**
 * JSON.parse 之后的唯一收口。非对象 / 无 type / 未知 type → null
 *（调用方当旁路事件丢掉；PersistentClaude 仍按「任意合法 JSON」续命超时）。
 */
export const asClaudeStreamEvent = (u: unknown): ClaudeStreamEvent | null => {
  if (!isPlainObject(u) || typeof u.type !== "string" || !KNOWN_TYPES.has(u.type)) return null;
  return u as ClaudeStreamEvent;
};
