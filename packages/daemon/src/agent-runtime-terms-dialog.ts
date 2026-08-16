import type { IAgentManager, PtyOutputEvent } from "./types/index.js";

/**
 * Claude Code 首次运行时弹的"Accept Permissions"对话框检测（对应 live bug 1 的修复）。
 * 看 screenText（终端模拟器渲染出来的当前帧，已经是干净文本），不用再自己
 * 剥 ANSI。
 *
 * 触发条件：
 * - 出现 `Iaccept` 或 `I accept`（Ink TUI 渲染有时相邻 span 之间没有空格）
 * - 出现 `Entertoconfirm` 或 `Enter to confirm`
 * - 出现 `1.No,exit` 和 `2.Yes` 选项
 */
export const isClaudeAcceptDialog = (screenText: string): boolean => {
  const clean = screenText;
  const hasAcceptOption = /I\s*accept/i.test(clean) || /Yes\s*,?\s*I\s*accept/i.test(clean);
  const hasConfirmText = /Enter\s*to\s*confirm/i.test(clean) || /Enter\s*confirm/i.test(clean);
  const hasExitOption = /No\s*,?\s*exit/i.test(clean);
  return (hasAcceptOption && hasExitOption) || hasConfirmText;
};

/**
 * 安装一次性 terms-accept 处理器。
 * 检测到 Accept Permissions 对话框后：
 * - 发送 `2`（选择 "Yes, I accept"）
 * - 等 200ms 再发 `\r`（确认）
 * - 然后自身取消订阅
 *
 * 如果没有检测到对话框（已接受过 terms），1.5s 后自动放行。
 *
 * 返回一个 Promise，在"对话框已处理完毕"或"确认本次不会出现对话框"时 resolve。
 * **为什么需要这个**：对话框的选项列表本身也用 `❯` 标出当前选中项（如
 * `❯ 1. No, exit`），这与 `post-start-input-writer.ts` 判断"聊天输入框已就绪"
 * 用的是同一个字符。如果 bootstrap 消息在对话框还开着的时候就被写入，会被
 * 对话框当作方向键/字符输入吃掉（对话框只认方向键+回车），导致 bootstrap
 * 消息永久丢失，agent 停在一个空的输入框上、永远不回复。因此调用方必须
 * 等这个 Promise resolve 之后，再开始为真正的聊天输入框做就绪轮询。
 */
export const installTermsAcceptHandler = (
  agentManager: IAgentManager,
  runId: string,
  agentName: string,
): Promise<void> => {
  return new Promise<void>((resolve) => {
    let detected = false;
    let acceptSent = false;
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const unsub = agentManager.getOutputBus().subscribe(runId, (ev: PtyOutputEvent) => {
      if (acceptSent) return;
      const run = agentManager.getRun(runId);
      if (!run) return;
      if (run.status === "exited" || run.status === "error") return;

      if (!detected) {
        if (isClaudeAcceptDialog(run.screenText)) {
          detected = true;
          console.log(`[Runtime] @${agentName} detected Accept-Permissions dialog, auto-accepting`);
        }
        return;
      }

      if (!acceptSent) {
        acceptSent = true;
        try {
          agentManager.writeInput(runId, "2");
        } catch {
          /* */
        }
        setTimeout(() => {
          try {
            agentManager.writeInput(runId, "\r");
            console.log(`[Runtime] @${agentName} accepted permissions`);
          } catch {
            /* */
          }
          // 再等 300ms 让 Claude 把界面从对话框切到真正的聊天输入框
          setTimeout(settle, 300);
        }, 200);
        setTimeout(() => {
          try {
            unsub();
          } catch {
            /* */
          }
        }, 1000);
      }
    });

    // 1.5s 内没检测到对话框 → 判定本次不会出现（已接受过 terms），放行
    setTimeout(() => {
      if (!detected) settle();
    }, 1500);
    // 兜底：即便检测到对话框但卡住，最多等 10s 也要放行，避免 bootstrap 永久卡死
    setTimeout(() => {
      try {
        unsub();
      } catch {
        /* */
      }
      settle();
    }, 10000);
  });
};
