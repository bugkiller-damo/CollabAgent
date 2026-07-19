import type { AgentStatus } from "./types/index.js";

/**
 * Agent 五态模型（uninit/idle/starting/working/stopped）状态机。
 * 见 docs/2026-07-15/03-state-machine.md。
 */
interface AgentState {
  status: AgentStatus;
  lastTransitionAt: number;
  startupTimer: ReturnType<typeof setTimeout> | null;
}

const VALID_TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
  uninit: ["idle", "stopped"],
  // idle → working 合法：PTY 复用分支（agent 空闲但进程还活着）收到新消息时
  // 直接进入工作态，不需要重新走 starting（agent-runtime-dispatch.ts 的 else 分支）。
  idle: ["starting", "working", "stopped"],
  starting: ["working", "idle", "stopped"],
  working: ["idle", "stopped"],
  stopped: ["idle"],
};

const STATE_LABEL: Record<AgentStatus, string> = {
  uninit: "未初始化",
  idle: "空闲",
  starting: "启动中",
  working: "工作中",
  stopped: "已停止",
};

function assertTransition(from: AgentStatus, to: AgentStatus): void {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed?.includes(to)) {
    console.warn(`[Runtime] Invalid state transition: ${from} → ${to} (ignored)`);
    throw new Error(`Invalid state transition: ${from} → ${to}`);
  }
}

/** installStuckDetector 用的查询结果——只暴露诊断需要的字段，不泄露内部 Map */
export interface WorkingAgentInfo {
  name: string;
  lastTransitionAt: number;
}

export interface IAgentStateMachine {
  transitionState(name: string, to: AgentStatus): void;
  getState(name: string): AgentStatus | undefined;
  setStartupTimer(name: string, timer: ReturnType<typeof setTimeout>): void;
  clearStartupTimer(name: string): void;
  /** 当前处于 "working" 状态的 agent 列表（installStuckDetector 用） */
  getWorkingAgents(): WorkingAgentInfo[];
}

export const createAgentStateMachine = (): IAgentStateMachine => {
  const agentStates = new Map<string, AgentState>();

  const transitionState = (name: string, to: AgentStatus): void => {
    const current = agentStates.get(name);
    const from: AgentStatus = current?.status ?? "uninit";
    // 同态迁移是 no-op（退出清理链等会对已是 idle 的 agent 再转一次 idle），
    // 直接放行，不打扰 assertTransition 的警告日志。
    if (from === to) return;
    try { assertTransition(from, to); } catch { return; }
    agentStates.set(name, { status: to, lastTransitionAt: Date.now(), startupTimer: null });
    console.log(`[Runtime] @${name} ${STATE_LABEL[from]} → ${STATE_LABEL[to]}`);
  };

  const clearStartupTimer = (name: string): void => {
    const st = agentStates.get(name);
    if (st?.startupTimer) { clearTimeout(st.startupTimer); st.startupTimer = null; }
  };

  return {
    transitionState,
    clearStartupTimer,
    getState: (name: string) => agentStates.get(name)?.status,
    setStartupTimer: (name: string, timer: ReturnType<typeof setTimeout>) => {
      const st = agentStates.get(name);
      if (st) st.startupTimer = timer;
    },
    getWorkingAgents: (): WorkingAgentInfo[] => {
      const result: WorkingAgentInfo[] = [];
      for (const [name, st] of agentStates.entries()) {
        if (st.status === "working") result.push({ name, lastTransitionAt: st.lastTransitionAt });
      }
      return result;
    },
  };
};
