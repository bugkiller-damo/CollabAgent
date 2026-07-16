import type { IAgentManager, IAgentStdinDispatcher } from "./types/index.js";

/**
 * Agent stdin 消息调度器。
 *
 * 负责把各种业务消息格式化为带 [Slock 系统消息] 标签的输入，
 * 写入对应 agent 进程的 stdin。
 *
 * 六种消息：dispatch / report / status / userInput / reminder / cancel
 */
export const createAgentStdinDispatcher = (
  manager: IAgentManager,
  getRunId: (agentName: string) => string | null,
): IAgentStdinDispatcher => {
  const wrap = (kind: string, body: string): string => {
    return `[Slock 系统消息 ${kind}]\n${body}\n[/Slock]\n`;
  };

  return {
    writeDispatchPrompt(agentName: string, taskText: string, dispatchId: string): void {
      const runId = getRunId(agentName);
      if (!runId) { console.warn(`[Dispatcher] No runId for @${agentName}`); return; }
      const body = `<dispatch id="${dispatchId}">\n${taskText}\n</dispatch>`;
      manager.writeInput(runId, wrap("dispatch", body));
    },

    writeReportForwardPrompt(agentName: string, reportText: string): void {
      const runId = getRunId(agentName);
      if (!runId) return;
      manager.writeInput(runId, wrap("report", `<report>\n${reportText}\n</report>`));
    },

    writeStatusForwardPrompt(agentName: string, statusText: string): void {
      const runId = getRunId(agentName);
      if (!runId) return;
      manager.writeInput(runId, wrap("status", `<status>${statusText}</status>`));
    },

    writeUserInputPrompt(agentName: string, text: string): void {
      const runId = getRunId(agentName);
      if (!runId) return;
      manager.writeInput(runId, wrap("user", `<user-input>${text}</user-input>`));
    },

    writeReminderPrompt(agentName: string, reminder: { title?: string; channel?: string }): void {
      const runId = getRunId(agentName);
      if (!runId) return;
      const parts = [];
      if (reminder.title) parts.push(`标题：${reminder.title}`);
      if (reminder.channel) parts.push(`频道：${reminder.channel}`);
      const body = `<reminder>\n${parts.join("\n")}\n</reminder>`;
      manager.writeInput(runId, wrap("reminder", body));
    },

    writeCancelPrompt(agentName: string, dispatchId: string, reason: string): void {
      const runId = getRunId(agentName);
      if (!runId) return;
      const body = `<cancel id="${dispatchId}" reason="${reason}">\n</cancel>`;
      manager.writeInput(runId, wrap("cancel", body));
    },
  };
};