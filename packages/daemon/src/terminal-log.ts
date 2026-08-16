import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeAgentDirName } from "./agent-dir-name.js";

/**
 * 终端日志落盘（G3 历史回看）：run 退出时把终端镜像文本追加写到
 * `.slock/terminal-logs/<agent>.log`，daemon 重启后仍可回看。
 *
 * 只存「渲染后的纯文本」（终端模拟器输出），不存原始 ANSI 字节——回放时
 * 直接当文本展示，不引入任何转义序列处理问题。
 */

const LOG_DIR = join(process.cwd(), ".slock", "terminal-logs");
/** 单 agent 日志上限：超过 512KB 时截断保留最后 256KB */
const MAX_FILE_BYTES = 512 * 1024;
const KEEP_FILE_BYTES = 256 * 1024;

function safeName(agentName: string): string {
  // 带哈希的安全名（等长中文名不碰撞，见 agent-dir-name.ts）
  return safeAgentDirName(agentName);
}

function logPath(agentName: string): string {
  return join(LOG_DIR, safeName(agentName) + ".log");
}

export function appendTerminalLog(agentName: string, runId: string, exitCode: number | null, text: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const path = logPath(agentName);
    const header =
      `\n\n═══════════════════════════════════════════════════\n` +
      `run ${runId.slice(0, 8)} · 结束于 ${new Date().toLocaleString("zh-CN")} · exit=${exitCode ?? "?"}\n` +
      `═══════════════════════════════════════════════════\n\n`;
    appendFileSync(path, header + text, "utf-8");
    // 体积控制：超限则截断保留尾部
    const size = statSync(path).size;
    if (size > MAX_FILE_BYTES) {
      const content = readFileSync(path, "utf-8");
      writeFileSync(path, content.slice(-KEEP_FILE_BYTES), "utf-8");
    }
  } catch {
    /* 日志落盘是 best-effort，不影响退出清理链 */
  }
}

/** 读日志尾部（默认最多 200KB 文本），文件不存在返回空串 */
export function readTerminalLogTail(agentName: string, maxChars = 200_000): string {
  try {
    const path = logPath(agentName);
    if (!existsSync(path)) return "";
    const content = readFileSync(path, "utf-8");
    return content.length > maxChars ? content.slice(-maxChars) : content;
  } catch {
    return "";
  }
}
