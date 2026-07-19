/**
 * Agent 名 → 文件系统安全目录/文件名。
 *
 * 原来的做法是 `name.replace(/[^a-zA-Z0-9_-]/g, "_")`——中文名全部坍缩成等长
 * 的下划线串（"悬疑小说家" → "_____"），**等长的中文名 agent 会共用同一个
 * 工作区**（MEMORY.md / CLAUDE.md / .mcp.json 全部串台，2026-07-18 实测发现）。
 *
 * 现在的策略：ASCII 名保持原样；只要清洗过程中有信息丢失（含非 ASCII 字符），
 * 就在清洗结果后追加一个由原名的全部码点决定的 6 位短哈希——确定性、稳定、
 * 不同原名几乎不会碰撞。
 */
export function safeAgentDirName(agentName: string): string {
  const base = agentName.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (base === agentName) return base;
  let hash = 0;
  for (let i = 0; i < agentName.length; i++) {
    hash = ((hash << 5) - hash + agentName.charCodeAt(i)) | 0;
  }
  return `${base}-${(hash >>> 0).toString(36).slice(0, 6)}`;
}

/** 旧方案（无哈希）的目录名——迁移老工作区时用来定位遗留目录 */
export function legacyAgentDirName(agentName: string): string {
  return agentName.replace(/[^a-zA-Z0-9_-]/g, "_");
}
