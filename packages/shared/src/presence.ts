/** Agent 值班意愿（库列 agents.duty）。与运行时五态、agents.status 归档正交。 */
export type AgentDuty = "on" | "off";

/**
 * 产品合成态：意愿 × 办公室门 × 运行时。
 * 停班压过一切；进程回收（stopped）对值班中的人仍显示空闲。
 */
export type AgentPresence = "idle" | "starting" | "working" | "off_duty" | "computer_offline";

export type AgentRuntimeHint = "uninit" | "idle" | "starting" | "working" | "stopped" | "online" | string;

export const PRESENCE_LABEL: Record<AgentPresence, { text: string; cls: string; dot: string }> = {
  working: { text: "工作中", cls: "text-blue-500", dot: "bg-blue-500" },
  starting: { text: "启动中", cls: "text-amber-500", dot: "bg-amber-500" },
  idle: { text: "空闲", cls: "text-green-500", dot: "bg-green-500" },
  off_duty: { text: "停班", cls: "text-gray-400", dot: "bg-gray-400" },
  computer_offline: { text: "计算机离线", cls: "text-gray-400", dot: "bg-gray-400" },
};

export function parseAgentDuty(raw: unknown): AgentDuty {
  return raw === "off" ? "off" : "on";
}

/** 唯一允许的产品口径。server / web / daemon 上报共用。 */
export function composePresence(
  duty: AgentDuty | string | null | undefined,
  computerOnline: boolean,
  runtime?: AgentRuntimeHint | null,
): AgentPresence {
  if (parseAgentDuty(duty) === "off") return "off_duty";
  if (!computerOnline) return "computer_offline";
  if (runtime === "working" || runtime === "starting") return runtime;
  return "idle";
}

/** 旧 isOnline：仅「值班且办公室开门」。停班 / 机离线都是 false。 */
export function presenceIsOnline(presence: AgentPresence): boolean {
  return presence === "idle" || presence === "starting" || presence === "working";
}

export function agentListFields(
  duty: AgentDuty | string | null | undefined,
  computerOnline: boolean,
  runtime?: AgentRuntimeHint | null,
): { duty: AgentDuty; presence: AgentPresence; isOnline: boolean } {
  const d = parseAgentDuty(duty);
  const presence = composePresence(d, computerOnline, runtime);
  return { duty: d, presence, isOnline: presenceIsOnline(presence) };
}
