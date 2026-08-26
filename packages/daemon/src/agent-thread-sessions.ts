import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirPrivateSync } from "./private-dir.js";

/**
 * D2 thread↔session 映射（Step 6，prompt 隔离批）。
 * 独立 JSON，不挂 AgentRunRecord——headless 默认从不 insertAgentRun。
 * PersistentClaude 仍每 agent 一进程；本表供 one-shot --resume 与崩溃记账。
 */

export interface ThreadSessionRecord {
  agentName: string;
  threadId: string;
  sessionId: string;
  updatedAt: number;
}

export interface IThreadSessionStore {
  remember(agentName: string, threadId: string, sessionId: string, at?: number): ThreadSessionRecord | null;
  lookup(agentName: string, threadId: string): ThreadSessionRecord | null;
  list(filter?: { agentName?: string }): ThreadSessionRecord[];
}

interface StoreFile {
  records: ThreadSessionRecord[];
}

const recordKey = (agentName: string, threadId: string): string => `${agentName}\0${threadId}`;

export const defaultThreadSessionStorePath = (): string => join(process.cwd(), ".slock", "daemon-thread-sessions.json");

export const createJsonThreadSessionStore = (filePath: string, opts?: { now?: () => number }): IThreadSessionStore => {
  const now = opts?.now ?? (() => Date.now());

  const readAll = (): StoreFile => {
    if (!existsSync(filePath)) return { records: [] };
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      return { records: Array.isArray(raw.records) ? raw.records : [] };
    } catch (err: any) {
      console.warn(`[ThreadSessions] Failed to load ${filePath}: ${err?.message}, starting empty`);
      return { records: [] };
    }
  };

  const writeAll = (data: StoreFile): void => {
    mkdirPrivateSync(dirname(filePath));
    const tmp = filePath + ".tmp";
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
      renameSync(tmp, filePath);
    } catch (err: any) {
      console.error(`[ThreadSessions] Atomic write failed: ${err?.message}`);
    }
  };

  const remember = (
    agentName: string,
    threadId: string,
    sessionId: string,
    at?: number,
  ): ThreadSessionRecord | null => {
    const name = agentName.trim();
    const tid = threadId.trim();
    const sid = sessionId.trim();
    if (!name || !tid || !sid) return null;
    const data = readAll();
    const key = recordKey(name, tid);
    const idx = data.records.findIndex((r) => recordKey(r.agentName, r.threadId) === key);
    const next: ThreadSessionRecord = {
      agentName: name,
      threadId: tid,
      sessionId: sid,
      updatedAt: at ?? now(),
    };
    if (idx >= 0) data.records[idx] = next;
    else data.records.push(next);
    writeAll(data);
    return next;
  };

  const lookup = (agentName: string, threadId: string): ThreadSessionRecord | null =>
    readAll().records.find((r) => r.agentName === agentName && r.threadId === threadId) ?? null;

  const list = (filter?: { agentName?: string }): ThreadSessionRecord[] => {
    const rows = readAll().records;
    return filter?.agentName ? rows.filter((r) => r.agentName === filter.agentName) : rows;
  };

  return { remember, lookup, list };
};
