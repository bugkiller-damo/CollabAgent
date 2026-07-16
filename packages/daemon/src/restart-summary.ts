import type { AgentRunRecord } from "./types/index.js";

/**
 * 重启摘要注入器。
 * daemon 重启或 agent 重建时把最近 N 条运行摘要注入系统提示。
 */

export const MAX_RUNS_IN_SUMMARY = 5;

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.round(min / 60)}h`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface RunSummary {
  startedAt: number;
  endedAt: number | null;
  status: string;
  exitCode: number | null;
  messagesProcessed: number;
  durationMs: number | null;
}

export function summarizeRun(run: AgentRunRecord): RunSummary {
  return {
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    status: run.status,
    exitCode: run.exitCode,
    messagesProcessed: run.messagesProcessed,
    durationMs: run.endedAt ? run.endedAt - run.startedAt : null,
  };
}

export function summarizeRecentRuns(runs: AgentRunRecord[], max: number = MAX_RUNS_IN_SUMMARY): RunSummary[] {
  return runs
    .slice()
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, max)
    .map(summarizeRun);
}

export function formatRestartSummary(agentName: string, runs: AgentRunRecord[]): string {
  const recent = summarizeRecentRuns(runs);
  if (!recent.length) return "";

  const lines: string[] = [];
  lines.push(`## 恢复摘要 (@${agentName})`);
  lines.push("");
  for (const r of recent) {
    const dur = r.durationMs !== null ? ` (${r.messagesProcessed} msgs, ${fmtDuration(r.durationMs)})` : ` (${r.messagesProcessed} msgs)`;
    const exit = r.exitCode !== null && r.exitCode !== 0 ? ` exit=${r.exitCode}` : "";
    lines.push(`- ${fmtTime(r.startedAt)}  ${r.status}${dur}${exit}`);
  }

  const totalMsgs = recent.reduce((sum, r) => sum + r.messagesProcessed, 0);
  const lastRun = recent[0]!;
  const lastSince = fmtDuration(Date.now() - lastRun.startedAt);
  lines.push("");
  lines.push(`最近会话: ${lastSince}前开始，处理 ${totalMsgs} 条消息。`);

  return lines.join("\n");
}