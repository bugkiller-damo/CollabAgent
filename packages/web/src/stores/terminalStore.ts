import { defineStore } from "pinia";
import { ref } from "vue";

export interface TerminalFrame {
  screen: string;
  status: string;
  time?: string;
}

/**
 * B1 结构化观察帧（与 daemon agent-observation.ts 的 ObservationFrame 同形）。
 * headless 路径的围观数据源：daemon 在 terminal:watch 期间实时转发（terminal:obs-frame），
 * 打开面板时先补 replay buffer（terminal:obs-history）。
 */
export interface ObsFrame {
  agentName: string;
  seq: number;
  timestamp: number;
  kind: "system" | "text" | "thinking" | "tool_use" | "tool_result" | "turn_start" | "turn_end" | "error";
  turnId: string | null;
  payload: {
    text?: string;
    toolName?: string;
    toolUseId?: string;
    toolInput?: unknown;
    summary?: string;
  };
}

/** 每 agent 帧缓冲上限（与 daemon replay buffer 一致） */
const OBS_CAP = 500;

/** agent 终端实时帧 + 历史日志（G3）+ 结构化观察帧（B1）：key 为 agentName，由 WS 消息路由写入 */
export const useTerminalStore = defineStore("terminal", () => {
  const frames = ref<Record<string, TerminalFrame>>({});
  const histories = ref<Record<string, string>>({});
  const obsFrames = ref<Record<string, ObsFrame[]>>({});

  function setFrame(agentName: string, frame: TerminalFrame): void {
    frames.value = { ...frames.value, [agentName]: frame };
  }

  function setHistory(agentName: string, text: string): void {
    histories.value = { ...histories.value, [agentName]: text };
  }

  function appendObsFrame(agentName: string, frame: ObsFrame): void {
    const arr = [...(obsFrames.value[agentName] ?? []), frame];
    if (arr.length > OBS_CAP) arr.splice(0, arr.length - OBS_CAP);
    obsFrames.value = { ...obsFrames.value, [agentName]: arr };
  }

  function setObsHistory(agentName: string, frames: ObsFrame[]): void {
    obsFrames.value = { ...obsFrames.value, [agentName]: frames.slice(-OBS_CAP) };
  }

  return { frames, histories, obsFrames, setFrame, setHistory, appendObsFrame, setObsHistory };
});
