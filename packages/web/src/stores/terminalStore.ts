import { create } from "zustand";

export interface TerminalFrame {
  screen: string;
  status: string;
  time?: string;
}

interface TerminalState {
  frames: Record<string, TerminalFrame>;
  histories: Record<string, string>;
  setFrame: (agentName: string, frame: TerminalFrame) => void;
  setHistory: (agentName: string, text: string) => void;
}

/** agent 终端实时帧 + 历史日志（G3）：key 为 agentName，由 AppLayout 的 WS 消息路由写入 */
export const useTerminalStore = create<TerminalState>((set) => ({
  frames: {},
  histories: {},
  setFrame: (agentName, frame) => set((s) => ({ frames: { ...s.frames, [agentName]: frame } })),
  setHistory: (agentName, text) => set((s) => ({ histories: { ...s.histories, [agentName]: text } })),
}));
