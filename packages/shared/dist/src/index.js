// ============================================================
// CollabAgent — 共享类型定义
// 基于 Slock 数据模型逆向分析
// ============================================================
export const RUNTIME_CATALOG_IDS = ["claude", "codex", "gemini", "opencode"];
/** P0 已接线、创建 picker 可收的 runtime */
export const WIRED_RUNTIME_IDS = ["claude"];
export { PROGRESS_PREFIX, channelProgressEnabled, DEFAULT_PROGRESS_THROTTLE_MS, formatProgressMessage, isProgressContent, labelTool, readProgressThrottleMs, summarizeProgress, } from "./progress.js";
export { PRESENCE_LABEL, agentListFields, composePresence, parseAgentDuty, presenceIsOnline, } from "./presence.js";
//# sourceMappingURL=index.js.map