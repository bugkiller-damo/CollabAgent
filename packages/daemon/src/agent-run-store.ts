import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentRunRecord, AgentRuntimeState, IAgentRunStore } from "./types/index.js";

/**
 * JSON 文件版 Agent 运行记录持久化。
 *
 * 存储两类数据：runs（AgentRunRecord[]）+ states（AgentRuntimeState[]）。
 * 设计为 Phase 5 可平滑迁移到 SQLite（接口保持兼容）。
 *
 * ### 持久化安全
 * - atomic write: 写 .tmp 再 rename，避免崩溃留半文件
 * - 启动加载：文件不存在或解析失败时返回空状态
 */

interface StoreFile {
  runs: AgentRunRecord[];
  states: AgentRuntimeState[];
}

const EMPTY: StoreFile = { runs: [], states: [] };

export const createJsonRunStore = (filePath: string): IAgentRunStore => {
  const ensureDir = (): void => {
    mkdirSync(dirname(filePath), { recursive: true });
  };

  const readAll = (): StoreFile => {
    if (!existsSync(filePath)) return { runs: [], states: [] };
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      return {
        runs: Array.isArray(raw.runs) ? raw.runs : [],
        states: Array.isArray(raw.states) ? raw.states : [],
      };
    } catch (err: any) {
      console.warn(`[RunStore] Failed to load ${filePath}: ${err?.message}, starting empty`);
      return { runs: [], states: [] };
    }
  };

  const writeAll = (data: StoreFile): void => {
    ensureDir();
    const tmp = filePath + ".tmp";
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
      renameSync(tmp, filePath);
    } catch (err: any) {
      console.error(`[RunStore] Atomic write failed: ${err?.message}`);
    }
  };

  const insertAgentRun = (run: AgentRunRecord): void => {
    const data = readAll();
    data.runs = data.runs.filter((r) => r.runId !== run.runId);
    data.runs.push(run);
    writeAll(data);
  };

  const updateAgentRun = (runId: string, updates: Partial<AgentRunRecord>): void => {
    const data = readAll();
    const idx = data.runs.findIndex((r) => r.runId === runId);
    if (idx < 0) {
      console.warn(`[RunStore] updateAgentRun: run ${runId} not found`);
      return;
    }
    data.runs[idx] = { ...data.runs[idx], ...updates };
    writeAll(data);
  };

  const listAgentRuns = (agentId: string): AgentRunRecord[] => {
    return readAll().runs.filter((r) => r.agentId === agentId);
  };

  const getLastRun = (agentId: string): AgentRunRecord | null => {
    const runs = listAgentRuns(agentId);
    if (!runs.length) return null;
    return runs.reduce((latest, r) => (r.startedAt > latest.startedAt ? r : latest));
  };

  const saveRuntimeState = (state: AgentRuntimeState): void => {
    const data = readAll();
    data.states = data.states.filter((s) => s.agentId !== state.agentId);
    data.states.push(state);
    writeAll(data);
  };

  const loadRuntimeState = (agentId: string): AgentRuntimeState | null => {
    const states = readAll().states;
    // saveRuntimeState 已经保证每个 agentId 在 states 里最多一条（写入前先按
    // agentId 过滤掉旧的），这里按 agentId 精确查找，而不是"数组最后一条"——
    // 后者在只有一个 agent 的场景下碰巧是对的，但在多 agent 场景下会把 agent A
    // 的运行时状态（含 lastSessionId）当成 agent B 的返回，造成 session resume
    // 用错 sessionId、崩溃恢复摘要张冠李戴。
    return states.find((s) => s.agentId === agentId) ?? null;
  };

  const markUnfinishedRunsStale = (): number => {
    const data = readAll();
    const now = Date.now();
    let count = 0;
    for (const run of data.runs) {
      if (run.status === "starting" || run.status === "running") {
        run.status = "error";
        run.endedAt = now;
        count++;
      }
    }
    if (count > 0) writeAll(data);
    return count;
  };

  const listActiveAgents = (): { agentId: string; agentName: string }[] => {
    const seen = new Map<string, string>();
    for (const run of readAll().runs) {
      if (run.status === "starting" || run.status === "running") {
        seen.set(run.agentId, run.agentName);
      }
    }
    return Array.from(seen, ([agentId, agentName]) => ({ agentId, agentName }));
  };

  return {
    insertAgentRun,
    updateAgentRun,
    listAgentRuns,
    getLastRun,
    saveRuntimeState,
    loadRuntimeState,
    markUnfinishedRunsStale,
    listActiveAgents,
  };
};

/** 默认文件路径 */
export function defaultStorePath(): string {
  return join(process.cwd(), ".slock", "daemon-state.json");
}