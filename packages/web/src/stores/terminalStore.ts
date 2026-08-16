import { defineStore } from "pinia";
import { ref } from "vue";

export interface TerminalFrame {
  screen: string;
  status: string;
  time?: string;
}

/** agent 终端实时帧 + 历史日志（G3）：key 为 agentName，由 AppLayout 的 WS 消息路由写入 */
export const useTerminalStore = defineStore("terminal", () => {
  const frames = ref<Record<string, TerminalFrame>>({});
  const histories = ref<Record<string, string>>({});

  function setFrame(agentName: string, frame: TerminalFrame): void {
    frames.value = { ...frames.value, [agentName]: frame };
  }

  function setHistory(agentName: string, text: string): void {
    histories.value = { ...histories.value, [agentName]: text };
  }

  return { frames, histories, setFrame, setHistory };
});
