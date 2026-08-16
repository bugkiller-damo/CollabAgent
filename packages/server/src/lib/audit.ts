/**
 * 事件日志 / 审计（O2）——不可变事件流水 + SHA-256 哈希链。
 *
 * 现状：业务表是「状态快照」，编辑/删除只改当前行（message_edits 是点状补丁），
 * 缺少「谁在什么时间做了什么」的不可变留痕 —— 对 agent 复盘/审计是硬缺口。
 *
 * 本模块提供统一的事件追加原语：
 * - `appendEvent(tx, input)` 在调用方事务内追加一条事件，并串成哈希链；
 * - 每条事件的 hash = sha256(actor_id, actor_type, verb, object_type, object_id, payload, prev_hash)；
 * - 用 `pg_advisory_xact_lock` 串行化链头读取，避免并发追加时两条事件引用同一条 prev_hash。
 *
 * 调用约定：`appendEvent` 必须在 `app.pg.transaction` 内部调用（与业务写入同事务），
 * 这样「写业务表 + 追加事件」要么一起成功、要么一起回滚，不留半截审计。
 */
import { createHash } from "node:crypto";

export type ActorType = "human" | "agent" | "system";

export interface AuditEventInput {
  actorId: string;
  actorType: ActorType;
  verb: string;
  objectType: string;
  objectId: string;
  payload?: Record<string, unknown>;
}

/** 与 app.pg.query 同形的事务客户端（connection.ts 里 tx.query 就是这个形状）。 */
export interface TxClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** 事务级 advisory lock 的 key，用于串行化哈希链头。任意稳定整型即可。 */
const CHAIN_LOCK_KEY = 712_042;

/**
 * 稳定序列化：递归排序对象键。
 * jsonb 在 Postgres 内部按规范序存键，读出时键序可能与写入时不同；
 * 哈希必须与键序无关，否则 verify 阶段会因键序重排而误报断裂。
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonical(input: AuditEventInput, prevHash: string | null): string {
  // 数组序固定，字段序固定，payload 稳定序列化 → 同一逻辑事件永远算出同一 hash（可复现校验）
  return JSON.stringify([
    input.actorId,
    input.actorType,
    input.verb,
    input.objectType,
    input.objectId,
    stableStringify(input.payload ?? {}),
    prevHash,
  ]);
}

/** 纯函数（可单测）：计算某条事件的哈希，prevHash 为首条时传 null。 */
export function eventHash(input: AuditEventInput, prevHash: string | null): string {
  return createHash("sha256").update(canonical(input, prevHash)).digest("hex");
}

/**
 * 追加一条事件并返回 (id, hash)。必须在事务内调用。
 * 首条事件（表为空）的 prev_hash 为 NULL。
 */
export async function appendEvent(tx: TxClient, input: AuditEventInput): Promise<{ id: number; hash: string }> {
  // 串行化：并发追加时保证「读到的上一条 hash」是已提交的，链不会分叉
  await tx.query("SELECT pg_advisory_xact_lock($1)", [CHAIN_LOCK_KEY]);
  const prev = await tx.query<{ hash: string }>("SELECT hash FROM events ORDER BY id DESC LIMIT 1");
  const prevHash = prev.rows[0]?.hash ?? null;
  const hash = eventHash(input, prevHash);
  const inserted = await tx.query<{ id: string | number }>(
    `INSERT INTO events (actor_id, actor_type, verb, object_type, object_id, payload, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.actorId,
      input.actorType,
      input.verb,
      input.objectType,
      input.objectId,
      JSON.stringify(input.payload ?? {}),
      prevHash,
      hash,
    ],
  );
  return { id: Number(inserted.rows[0].id), hash };
}
