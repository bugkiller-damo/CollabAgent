/**
 * Phase 2：待恢复 interrupt 持久化（设计 §11.4）。
 *
 * turn.interrupt 只是预览帧，规范记录是 turn.end.status=interrupted 时
 * 由 dispatch 写入本 store——daemon 重启后能从磁盘恢复 pending interrupt，
 * 同 conversation 的下一条消息携带 resumeToken 恢复 graph。
 *
 * 纪律（§11.4.4）：
 * - resumeToken 一次性：恢复成功后删除；retry 时保留（turn 未达终态）；
 * - 存 (agentId, conversationId) 键，同一 conversation 只允许一个 pending；
 * - runtime identity 变化（runtime/entrypoint 不符）→ 不兼容 interrupt 清除；
 * - 独立 JSON 文件 + 原子写（同 agent-session-store 风格），私目录 0700；
 * - 只存恢复必需的 token/prompt，不存完整 graph state / secrets。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirPrivateSync, slockDir } from "./private-dir.js";

export interface PendingRuntimeInterrupt {
  agentId: string;
  /** 批次 C（P1.4）：审批面展示/匹配用——agentName/channel/threadId 在 put
   *  时由 dispatch 上下文带入；旧记录缺省兼容。 */
  agentName?: string;
  channel?: string;
  threadId?: string;
  runtime: string;
  entrypoint?: string;
  /** Phase 5 §11.2：manifest 条目 revision——修订变化后旧 resumeToken 作废 */
  revision?: string;
  conversationId: string;
  interruptId: string;
  resumeToken: string;
  prompt: string;
  createdAt: number;
  expiresAt: number;
}

export interface IRuntimeInterruptStore {
  /** turn.end interrupted 时 upsert；同 (agentId, conversationId) 覆盖旧记录 */
  put(record: PendingRuntimeInterrupt): void;
  /**
   * 派发前取待恢复 interrupt。校验 runtime/entrypoint 与当前 profile 兼容、
   * 未过期——不符/过期即清除并返回 null（§11.4.4 不兼容 interrupt 不残留）。
   */
  take(
    agentId: string,
    conversationId: string,
    runtime: string,
    entrypoint?: string,
    revision?: string,
  ): PendingRuntimeInterrupt | null;
  /**
   * Phase 5：identity 变化时主动清——删该 agent 所有 runtime/entrypoint/
   * revision 与当前 profile 不符的 pending 记录（不再等 take 时惰性清）。
   * 返回清除条数。
   */
  clearIncompatible(agentId: string, runtime: string, entrypoint?: string, revision?: string): number;
  /** 恢复成功 / conversation 终结后删除（无记录返回 false） */
  delete(agentId: string, conversationId: string): boolean;
  /** agent 注销/删除时清空其全部 pending */
  clearAgent(agentId: string): number;
  list(): PendingRuntimeInterrupt[];
}

interface StoreFile {
  records: PendingRuntimeInterrupt[];
}

const keyOf = (agentId: string, conversationId: string): string => `${agentId}${conversationId}`;

export const defaultInterruptStorePath = (): string => join(slockDir(), "daemon-runtime-interrupts.json");

export const createRuntimeInterruptStore = (
  filePath: string,
  opts?: { now?: () => number; ttlMs?: number; onChange?: (records: PendingRuntimeInterrupt[]) => void },
): IRuntimeInterruptStore => {
  const now = opts?.now ?? (() => Date.now());
  /** 批次 C（P1.4）：每次落盘的集合变更后通知（含 take 的惰性清除）——
   *  daemon-core 据此向 server 推 interrupts:state 全量快照。 */
  const notify = (): void => {
    try {
      opts?.onChange?.(readAll().records);
    } catch {
      /* onChange 是旁路，不得打断 store 写路径 */
    }
  };
  /** pending interrupt 默认 7 天过期（§11.4：token 不能无限期悬置） */
  const ttlMs = opts?.ttlMs ?? 7 * 24 * 60 * 60 * 1000;

  const readAll = (): StoreFile => {
    if (!existsSync(filePath)) return { records: [] };
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      return { records: Array.isArray(raw.records) ? raw.records : [] };
    } catch (err) {
      console.warn(`[InterruptStore] Failed to load ${filePath}: ${(err as Error)?.message}, starting empty`);
      return { records: [] };
    }
  };

  const writeAll = (data: StoreFile): void => {
    mkdirPrivateSync(dirname(filePath));
    const tmp = filePath + ".tmp";
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
      renameSync(tmp, filePath);
    } catch (err) {
      console.error(`[InterruptStore] Atomic write failed: ${(err as Error)?.message}`);
    }
  };

  return {
    put(record) {
      const data = readAll();
      const k = keyOf(record.agentId, record.conversationId);
      const idx = data.records.findIndex((r) => keyOf(r.agentId, r.conversationId) === k);
      const next = { ...record, expiresAt: record.expiresAt || now() + ttlMs };
      if (idx >= 0) data.records[idx] = next;
      else data.records.push(next);
      writeAll(data);
      notify();
    },

    take(agentId, conversationId, runtime, entrypoint, revision) {
      const data = readAll();
      const k = keyOf(agentId, conversationId);
      const idx = data.records.findIndex((r) => keyOf(r.agentId, r.conversationId) === k);
      if (idx < 0) return null;
      const rec = data.records[idx];
      const compatible =
        rec.runtime === runtime &&
        (rec.entrypoint ?? undefined) === (entrypoint ?? undefined) &&
        (rec.revision ?? undefined) === (revision ?? undefined);
      if (!compatible || rec.expiresAt <= now()) {
        data.records.splice(idx, 1);
        writeAll(data);
        notify();
        return null;
      }
      return rec;
    },

    clearIncompatible(agentId, runtime, entrypoint, revision) {
      const data = readAll();
      const next = data.records.filter(
        (r) =>
          r.agentId !== agentId ||
          (r.runtime === runtime &&
            (r.entrypoint ?? undefined) === (entrypoint ?? undefined) &&
            (r.revision ?? undefined) === (revision ?? undefined)),
      );
      if (next.length === data.records.length) return 0;
      writeAll({ records: next });
      notify();
      return data.records.length - next.length;
    },

    delete(agentId, conversationId) {
      const data = readAll();
      const k = keyOf(agentId, conversationId);
      const idx = data.records.findIndex((r) => keyOf(r.agentId, r.conversationId) === k);
      if (idx < 0) return false;
      data.records.splice(idx, 1);
      writeAll(data);
      notify();
      return true;
    },

    clearAgent(agentId) {
      const data = readAll();
      const before = data.records.length;
      const next = data.records.filter((r) => r.agentId !== agentId);
      if (next.length === before) return 0;
      writeAll({ records: next });
      notify();
      return before - next.length;
    },

    list() {
      return [...readAll().records];
    },
  };
};
