/**
 * ❄️ LEGACY / FROZEN（2026-08-20，演进 Step 3）
 * 本文件仅服务 PTY fallback（SLOCK_USE_PTY=1）。headless 是默认且受支持的路径。
 * 冻结纪律：不接受新功能与非缺陷改动；仅在 headless 出现不可修复问题时作回退启用。
 * 保留原因：headless 尚未经过长期验证（2026-08-18 起默认）。
 * 删除评估：headless 稳定运行满 6 周后（2026-09 底）按
 * docs/2026-08-20/02-daemon-evolution-tracker.md Step 3 原删除方案执行。
 */
import { basename } from "node:path";
import type { IAgentManager } from "./types/index.js";

/**
 * Post-start 输入写入器（PTY 模式专用）。
 *
 * 解决"Agent 进程启动后何时能接收输入"的问题。
 * 直接 `pty.write` 可能在进程未就绪时丢失，因此：
 * 1. 轮询 screenText（终端模拟器渲染出来的当前帧，见 terminal-state.ts）
 *    是否出现提示符 `❯` / `›`
 * 2. 出现提示符（或超时 3s）后写入
 * 3. 写入时根据 command 类型决定是否用 bracketed paste 包装
 *
 * 适配自 Hive 的 `post-start-input-writer.ts`，去除了 Gemini 特定检测；
 * paste acknowledgement 等待逻辑保留（见 submitPastedInteractiveInput）。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 何时可删（O13）：本文件整组逻辑（提示符就绪轮询 / bracketed paste / paste-ack
 * 等待 / Enter 时序）都是「agent = PTY 里的 TUI」这一形态的键盘模拟补偿。
 * 删除条件（满足其一）：
 *   a) 输入通道结构化——agent 消息改走 stream-json 持久会话（本仓已有
 *      PersistentClaude，stdin 写 JSON-RPC、无 TUI 键盘路径）或 ACP 类 headless
 *      运行时（对照 buzz-agent：agent 是 stdio JSON-RPC 进程，session/prompt
 *      投递消息，根本没有终端）；
 *   b) claude CLI 官方提供非键盘的结构化输入通道（socket/IPC/持久会话 API）。
 * 前置依赖：终端观察面板目前消费 PTY 渲染帧，结构化路径需先补等价的观察
 * 遥测（buzz 用 OBSERVER_FRAME_TELEMETRY 结构化帧替代截屏）。
 * 详见 docs/2026-08-18/01-pty-keyboard-vs-structured-channels.md。
 *
 * 状态更新（2026-08-18 B2）：条件 a) 及前置依赖均已达成——PersistentClaude
 * stream-json 持久会话已是默认输入通道，观察遥测由 agent-observation.ts
 * 结构化帧 + transcript 渲染承担。本文件仅服务 `SLOCK_USE_PTY=1` fallback，
 * 彻底删除条件 = PTY 模式整体退役。
 * ────────────────────────────────────────────────────────────────────────
 */

/** 支持交互式提示符检测的 CLI 命令 */
export const INTERACTIVE_COMMANDS = new Set(["claude", "codex", "gemini", "opencode"]);

/** 轮询间隔 */
const READY_CHECK_INTERVAL_MS = 50;

/** 兜底超时：8 秒后即使没看到提示符也强制写入（Claude Code 首次启动 + 接受 terms 可能较慢） */
const READY_TIMEOUT_MS = 8000;

/** 支持 bracketed paste 的 CLI（多行内容用 ANSI 转义包装） */
const COMMANDS_WITH_BRACKETED_PASTE = new Set(["claude", "codex", "opencode"]);

/**
 * 从 command 里提取可比对的裸名字——调用方传进来的往往是 resolveClaudeBinary()
 * 解析出的绝对路径（比如 Windows 上的 `C:\...\claude.exe`），而不是字面量
 * "claude"。之前直接拿完整路径去 `COMMANDS_WITH_BRACKETED_PASTE.has(command)`，
 * 在这种情况下永远不可能命中——导致 bracketed paste + paste-ack 等待这条路径
 * （第 4 个 bug 的修复）从来没有真正被走过，一直在用"粘贴内容和回车合并成一次
 * 写入"的旧行为，只是靠运气大部分时候没炸。
 */
export const commandBaseName = (command: string): string =>
  basename(command)
    .replace(/\.(exe|cmd|bat)$/i, "")
    .toLowerCase();

/**
 * 检测当前屏幕是否出现交互式提示符 `❯`/`›`。screenText 已经是终端模拟器
 * 解析后的干净文本（不含 ANSI 控制码），不需要自己再剥。不要求出现在行首——
 * 见 agent-runtime.ts 里同样放宽过的 PROMPT_RE 的注释：不同版本/场景下 Claude
 * 的提示符渲染方式不完全一致，❯ 是个很少在正常文本里出现的生僻字符，放宽
 * 匹配范围比"漏检导致消息永远发不出去"更安全。
 */
export const hasInteractivePromptReady = (screenText: string): boolean => {
  return /[❯›]/u.test(screenText);
};

/**
 * 包装为 bracketed paste 模式（多行 / 特殊字符安全）。
 * Claude Code / Codex / Opencode 都识别 `\x1b[200~...\x1b[201~`。
 */
export const toBracketedPasteSubmission = (text: string): string => {
  return `\x1b[200~${text}\x1b[201~`;
};

/** Claude 对大段粘贴内容的确认占位符，例如 "[Pasted text #1 +42 lines]" */
const PASTE_ACK_RE = /\[Pasted text #\d+/;
export const hasPasteAck = (screenText: string): boolean => PASTE_ACK_RE.test(screenText);

const PASTE_ACK_CHECK_INTERVAL_MS = 50;
const PASTE_SETTLE_DELAY_MS = 100;
/** 按文本长度缩放的粘贴确认超时：短文本几百毫秒，长文本最多 3s */
const PASTE_ACK_MIN_TIMEOUT_MS = 300;
const PASTE_ACK_MAX_TIMEOUT_MS = 3000;

/**
 * 用 bracketed paste 写入正文，但不在同一次 write 里立即跟上回车——而是等
 * Claude 显示 "[Pasted text #N" 确认占位符（或按文本长度缩放的超时），再等一小段
 * settle 时间之后才发回车。
 *
 * 为什么需要：几千字符的大段粘贴（比如 bootstrap 系统提示 + 首条消息合并后的文本）
 * 写进 Claude 的 Ink 输入框需要处理时间；如果紧跟着立刻发回车，Enter 可能在 Claude
 * 内部状态还没来得及消化完整段粘贴内容之前就被处理/丢弃，导致提交静默失败——从外部
 * 看就是"确实写进去了（PTY 输出里能看到内容），但 Claude 什么反应都没有"，进程
 * 永久停在那，output 长度冻结不再变化。这正是 Hive 的 `post-start-input-writer.ts`
 * 用 paste-ack 等待解决的问题；本文件之前的版本把这段逻辑简化掉了。
 */
const submitPastedInteractiveInput = (agentManager: IAgentManager, runId: string, text: string): void => {
  const wrapped = toBracketedPasteSubmission(text);
  agentManager.writeInput(runId, wrapped);
  console.log(
    `[PostStart] ${runId} wrote bracketed paste (${text.length} chars), waiting for ack/timeout before Enter`,
  );

  const timeoutMs = Math.min(PASTE_ACK_MAX_TIMEOUT_MS, Math.max(PASTE_ACK_MIN_TIMEOUT_MS, text.length * 2));
  const startedAt = Date.now();

  const trySubmit = (): void => {
    const run = agentManager.getRun(runId);
    if (!run) {
      console.warn(`[PostStart] ${runId} run disappeared while waiting for paste-ack, giving up on Enter`);
      return;
    }
    if (run.status === "exited" || run.status === "error") {
      console.warn(`[PostStart] ${runId} run ${run.status} while waiting for paste-ack, giving up on Enter`);
      return;
    }

    const acked = hasPasteAck(run.screenText);
    const timedOut = Date.now() - startedAt >= timeoutMs;

    if (acked || timedOut) {
      console.log(
        `[PostStart] ${runId} sending Enter now (acked=${acked}, timedOut=${timedOut}, ` +
          `elapsed=${Date.now() - startedAt}ms) screen=...${run.screenText.replace(/\s+/g, " ").trim().slice(-300)}`,
      );
      setTimeout(() => {
        try {
          agentManager.writeInput(runId, "\r");
        } catch (err: any) {
          console.warn(`[PostStart] ${runId} writeInput("\\r") threw:`, err?.message ?? err);
        }
      }, PASTE_SETTLE_DELAY_MS);
      return;
    }
    setTimeout(trySubmit, PASTE_ACK_CHECK_INTERVAL_MS);
  };
  setTimeout(trySubmit, PASTE_ACK_CHECK_INTERVAL_MS);
};

/** 写入器函数签名：把 text 投递到指定 runId（等提示符就绪后） */
export type PostStartInputWriter = (runId: string, text: string) => void;

/**
 * 创建 post-start input writer。
 *
 * @param agentManager - IAgentManager 实例（用于 getRun / writeInput）
 * @param command      - 启动的 CLI 命令名（如 "claude"），决定是否用 bracketed paste
 * @returns writer 函数
 */
export const createPostStartInputWriter = (agentManager: IAgentManager, command: string): PostStartInputWriter => {
  return (runId: string, text: string): void => {
    const startedAt = Date.now();
    let attempts = 0;
    const MAX_ATTEMPTS = 100; // 100 * 50ms = 5s 硬上限（覆盖 READY_TIMEOUT_MS）

    const tryWrite = (): void => {
      attempts++;
      const run = agentManager.getRun(runId);
      if (!run) {
        // run 已被清理（用户 stop / 进程已退出），放弃
        return;
      }
      if (run.status === "exited" || run.status === "error") {
        return;
      }

      const elapsed = Date.now() - startedAt;
      const promptReady = hasInteractivePromptReady(run.screenText);
      const timedOut = elapsed >= READY_TIMEOUT_MS;
      const exhausted = attempts >= MAX_ATTEMPTS;

      if (promptReady || timedOut || exhausted) {
        const useBracketedPaste = COMMANDS_WITH_BRACKETED_PASTE.has(commandBaseName(command));
        if (useBracketedPaste) {
          submitPastedInteractiveInput(agentManager, runId, text);
        } else {
          agentManager.writeInput(runId, text + "\r");
        }
        if (timedOut && !promptReady) {
          console.warn(
            `[PostStart] ${runId} prompt not ready after ${READY_TIMEOUT_MS}ms ` +
              `(command=${basename(command)}, outputLen=${run.output.length}); ` +
              `writing anyway. screen=...${run.screenText.replace(/\s+/g, " ").trim().slice(-300)}`,
          );
        }
        return;
      }

      setTimeout(tryWrite, READY_CHECK_INTERVAL_MS);
    };

    tryWrite();
  };
};
