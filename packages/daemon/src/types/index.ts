// ============================================================================
// Daemon — 共享类型定义
// 所有模块依赖的类型统一在此定义，避免循环引用和重复定义。
// ============================================================================

// —— 基础状态 ——

/** Agent 顶层生命周期状态（4 态模型） */
export type AgentStatus = "uninit" | "idle" | "starting" | "working" | "stopped";

/** 单次运行的运行时状态 */
export type RunStatus = "starting" | "running" | "exited" | "error";

// —— 核心实体 ——

/** Agent 元信息 */
export interface AgentInfo {
  agentId: string;
  agentName: string;
  displayName?: string;
  description?: string;
}

/** 一条活跃的 Agent 运行实例 */
export interface LiveAgentRun {
  runId: string;
  agentId: string;
  pid: number | null;
  status: RunStatus;
  output: string;
  exitCode: number | null;
  startedAt: number;
}

/** Agent 进程快照（agent-manager 返回） */
export interface AgentRunSnapshot {
  runId: string;
  agentId: string;
  pid: number;
  status: RunStatus;
  exitCode: number | null;
  cols: number;
  rows: number;
  startedAt: number;
}

/** 持久化的 Agent 运行记录 */
export interface AgentRunRecord {
  runId: string;
  agentId: string;
  agentName: string;
  status: RunStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  messagesProcessed: number;
  lastTurnDuration: number | null;
}

/** Agent 运行时持久化状态（供重启恢复） */
export interface AgentRuntimeState {
  agentId: string;
  agentName: string;
  status: AgentStatus;
  lastTransitionAt: number;
  totalRuns: number;
  currentRunId: string | null;
  lastSessionId: string | null;
  lastSessionUpdatedAt: number | null;
}

// —— 启动/配置 ——

/** 启动 Agent 所需参数 */
export interface StartAgentInput {
  agentId: string;
  agentName: string;
  workspaceDir: string;
  systemPromptFile: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}

/** DaemonCore 配置 */
export interface DaemonConfig {
  serverUrl: string;
  apiKey: string;
  dataDir?: string;
}

/** 一条待分发的消息 */
export interface AgentMessage {
  channelName: string;
  replyTarget: string;
  senderName: string;
  content: string;
  isDm?: boolean;
}

// —— PTY 输出 ——

/** PTY 输出事件 */
export interface PtyOutputEvent {
  runId: string;
  data: string;
  timestamp: number;
}

/** PTY 输出总线（agent-manager 暴露给 agent-runtime 的流） */
export interface PtyOutputBus {
  on(event: "data", handler: (ev: PtyOutputEvent) => void): void;
  off(event: "data", handler: (ev: PtyOutputEvent) => void): void;
}

// —— CLI 预设 ——

export interface SessionCaptureConfig {
  source: "claude_project_jsonl_dir" | "stdout_regex" | "stdout_jsonpath";
  pattern?: string;
}

export interface CommandPreset {
  command: string;
  yoloArgs: string[];
  resumeArgsTemplate: string | null;
  sessionIdCapture: SessionCaptureConfig | null;
}

// —— 模块接口（供依赖注入/测试替身） ——

export interface IAgentTokenRegistry {
  issue(agentId: string): string;
  peek(agentId: string): string | undefined;
  validate(agentId: string, token: string | undefined): boolean;
  revokeIfMatches(agentId: string, token: string): void;
}

export interface ILiveRunRegistry {
  add(run: LiveAgentRun): void;
  get(runId: string): LiveAgentRun | undefined;
  remove(runId: string): void;
  list(): LiveAgentRun[];

  createExitEntry(runId: string): void;
  resolveExit(runId: string): void;
  setPendingExitCode(runId: string, exitCode: number | null): void;
  hasPendingExitCode(runId: string): boolean;
  clearPendingExitCode(runId: string): void;
}

export interface IAgentManager {
  startAgent(input: StartAgentInput): Promise<AgentRunSnapshot>;
  stopRun(runId: string): void;
  writeInput(runId: string, input: string | Buffer): void;
  resizeRun(runId: string, cols: number, rows: number): void;
  pauseRun(runId: string): void;
  resumeRun(runId: string): void;
  getRun(runId: string): AgentRunSnapshot | undefined;
  getOutputBus(): PtyOutputBus;
}

export interface IAgentRunStore {
  insertAgentRun(run: AgentRunRecord): void;
  updateAgentRun(runId: string, updates: Partial<AgentRunRecord>): void;
  listAgentRuns(agentId: string): AgentRunRecord[];
  getLastRun(agentId: string): AgentRunRecord | null;
  saveRuntimeState(state: AgentRuntimeState): void;
  loadRuntimeState(): AgentRuntimeState | null;
}

export interface IAgentStartup {
  buildStartupInstructions(agent: AgentInfo, workspaceDir: string): string;
  buildIdentityMarker(agent: AgentInfo): string;
  buildProtocolDoc(role: string): string;
  buildReminderTail(role: string, dispatchId?: string): string;
  writeSystemPromptFile(agentName: string, content: string): string;
  createWorkspaceDir(agentName: string): string;
}

/** stdin 写入策略 */
export type StdinWriteStrategyType = "direct" | "wait-for-prompt" | "bracketed-paste" | "stream-json";

export interface IStdinWriter {
  write(runId: string, text: string, snapshot: AgentRunSnapshot): void;
  readonly strategy: StdinWriteStrategyType;
}

export interface IAgentStdinDispatcher {
  writeDispatchPrompt(agentName: string, taskText: string, dispatchId: string): void;
  writeReportForwardPrompt(agentName: string, reportText: string): void;
  writeStatusForwardPrompt(agentName: string, statusText: string): void;
  writeUserInputPrompt(agentName: string, text: string): void;
  writeReminderPrompt(agentName: string, reminder: { title?: string; channel?: string }): void;
  writeCancelPrompt(agentName: string, dispatchId: string, reason: string): void;
}
