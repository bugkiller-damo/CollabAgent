import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirPrivateSync, slockDir } from "./private-dir.js";

/**
 * A2 agent→sessionId 持久化（会话续接盘）。
 *
 * headless 默认路径的 stream-json `system` init 事件携带 session_id，
 * createStreamTurnHandler 把它记进本表；下次 spawn PersistentClaude 时以
 * `--resume <id>` 温启动——空闲回收（30min 默认）/ daemon 重启后 agent
 * 不再是空白进程（报告 §8.3「金鱼」问题）。独立 JSON 文件，同 D2 风格
 * （agent-thread-sessions.ts），不挂 AgentRunRecord。
 *
 * 生命周期约定：
 * - 保留：reclaimIdleAgent（进程回收但记忆留）、stopAll（daemon 关闭，
 *   下次启动续接）、registerAgent 重注册（改配置不清记忆）。
 * - 清除：unregisterAgent（含 duty off / agent:stop）、显式 stopAgent、
 *   --resume 后宽限期内早退 / 首事件 error（驱动判定 id 失效，回调 forget）。
 */

export interface AgentSessionRecord {
  agentName: string;
  sessionId: string;
  updatedAt: number;
}

export interface IAgentSessionStore {
  remember(agentName: string, sessionId: string, at?: number): AgentSessionRecord | null;
  lookup(agentName: string): AgentSessionRecord | null;
  /** 显式停 / 注销 / resume 失败时清除；返回是否真的删到了记录 */
  forget(agentName: string): boolean;
  list(): AgentSessionRecord[];
}

interface StoreFile {
  records: AgentSessionRecord[];
}

export const defaultAgentSessionStorePath = (): string => join(slockDir(), "daemon-agent-sessions.json");

export const createJsonAgentSessionStore = (filePath: string, opts?: { now?: () => number }): IAgentSessionStore => {
  const now = opts?.now ?? (() => Date.now());

  const readAll = (): StoreFile => {
    if (!existsSync(filePath)) return { records: [] };
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      return { records: Array.isArray(raw.records) ? raw.records : [] };
    } catch (err: any) {
      console.warn(`[AgentSessions] Failed to load ${filePath}: ${err?.message}, starting empty`);
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
      console.error(`[AgentSessions] Atomic write failed: ${err?.message}`);
    }
  };

  const remember = (agentName: string, sessionId: string, at?: number): AgentSessionRecord | null => {
    const name = agentName.trim();
    const sid = sessionId.trim();
    if (!name || !sid) return null;
    const data = readAll();
    const idx = data.records.findIndex((r) => r.agentName === name);
    const next: AgentSessionRecord = { agentName: name, sessionId: sid, updatedAt: at ?? now() };
    if (idx >= 0) data.records[idx] = next;
    else data.records.push(next);
    writeAll(data);
    return next;
  };

  const lookup = (agentName: string): AgentSessionRecord | null =>
    readAll().records.find((r) => r.agentName === agentName) ?? null;

  const forget = (agentName: string): boolean => {
    const data = readAll();
    const idx = data.records.findIndex((r) => r.agentName === agentName);
    if (idx < 0) return false;
    data.records.splice(idx, 1);
    writeAll(data);
    return true;
  };

  const list = (): AgentSessionRecord[] => readAll().records;

  return { remember, lookup, forget, list };
};
