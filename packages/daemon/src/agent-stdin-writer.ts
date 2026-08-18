import type { AgentRunSnapshot, IStdinWriter, StdinWriteStrategyType } from "./types/index.js";

/**
 * Agent stdin 写入策略。
 *
 * 四种策略：
 * - direct:           立即写入
 * - wait-for-prompt:  等待提示符后写入（PTY 模式）
 * - bracketed-paste:  ANSI 转义包装（多行内容）
 * - stream-json:      Claude Code 的 stream-json 协议
 *
 * 实际写入由调用方通过 manager.writeInput 完成；本模块聚焦于格式化与调度策略。
 */

const lineSep = "\n";

export const createDirectWriter = (): IStdinWriter => ({
  strategy: "direct",
  write(runId: string, text: string, _snapshot: AgentRunSnapshot): void {
    console.log(`[Writer:${runId}/direct] ${text.slice(0, 80)}`);
  },
});

export const createBracketedPasteWriter = (): IStdinWriter => ({
  strategy: "bracketed-paste",
  write(runId: string, text: string, _snapshot: AgentRunSnapshot): void {
    const wrapped = `\x1b[200~${text}\x1b[201~${lineSep}`;
    console.log(`[Writer:${runId}/bracketed-paste] ${text.slice(0, 80)}`);
    void wrapped;
  },
});

export const createWaitForPromptWriter = (): IStdinWriter => ({
  strategy: "wait-for-prompt",
  write(runId: string, text: string, _snapshot: AgentRunSnapshot): void {
    console.log(`[Writer:${runId}/wait-for-prompt] ${text.slice(0, 80)}`);
  },
});

export const createStreamJsonWriter = (): IStdinWriter => ({
  strategy: "stream-json",
  write(runId: string, text: string, _snapshot: AgentRunSnapshot): void {
    const payload = JSON.stringify({ type: "user", message: { role: "user", content: text } }) + lineSep;
    console.log(`[Writer:${runId}/stream-json] ${payload.slice(0, 80)}`);
    void payload;
  },
});

export function createStdinWriter(strategy: StdinWriteStrategyType): IStdinWriter {
  switch (strategy) {
    case "direct":
      return createDirectWriter();
    case "bracketed-paste":
      return createBracketedPasteWriter();
    case "wait-for-prompt":
      return createWaitForPromptWriter();
    case "stream-json":
      return createStreamJsonWriter();
    default:
      return createDirectWriter();
  }
}
