import type { PostStartInputWriter } from "./post-start-input-writer.js";
import type { IAgentManager, IAgentStdinDispatcher } from "./types/index.js";

/**
 * Agent stdin 消息调度器。
 *
 * 负责把各种业务消息格式化为带 [Slock 系统消息] 标签的输入，
 * 投递到对应 agent 进程的 PTY。
 *
 * 六种消息：dispatch / report / status / userInput / reminder / cancel
 *
 * 写入策略：内部通过 PostStartInputWriter 投递，会等 PTY 提示符 `❯` / `›` 就绪
 * 后再写入，避免在 CLI 未就绪时丢消息。
 */
export const createAgentStdinDispatcher = (
  _manager: IAgentManager,
  getRunId: (agentName: string) => string | null,
  writer: PostStartInputWriter,
): IAgentStdinDispatcher => {
  const wrap = (kind: string, body: string): string => {
    return `[Slock 系统消息 ${kind}]\n${body}\n[/Slock]\n`;
  };

  const writeToRun = (agentName: string, payload: string): void => {
    const runId = getRunId(agentName);
    if (!runId) {
      console.warn(`[Dispatcher] No runId for @${agentName}`);
      return;
    }
    writer(runId, payload);
  };

  return {
    writeDispatchPrompt(agentName: string, taskText: string, dispatchId: string): void {
      const body = `<dispatch id="${dispatchId}">\n${taskText}\n</dispatch>`;
      writeToRun(agentName, wrap("dispatch", body));
    },

    writeReportForwardPrompt(agentName: string, reportText: string): void {
      writeToRun(agentName, wrap("report", `<report>\n${reportText}\n</report>`));
    },

    writeStatusForwardPrompt(agentName: string, statusText: string): void {
      writeToRun(agentName, wrap("status", `<status>${statusText}</status>`));
    },

    writeUserInputPrompt(agentName: string, text: string): void {
      writeToRun(agentName, wrap("user", `<user-input>${text}</user-input>`));
    },

    writeReminderPrompt(agentName: string, reminder: { title?: string; channel?: string }): void {
      const parts: string[] = [];
      if (reminder.title) parts.push(`标题：${reminder.title}`);
      if (reminder.channel) parts.push(`频道：${reminder.channel}`);
      const body = `<reminder>\n${parts.join("\n")}\n</reminder>`;
      writeToRun(agentName, wrap("reminder", body));
    },

    writeCancelPrompt(agentName: string, dispatchId: string, reason: string): void {
      const body = `<cancel id="${dispatchId}" reason="${reason}">\n</cancel>`;
      writeToRun(agentName, wrap("cancel", body));
    },
  };
};
