/**
 * 回合结束检测用到的两组状态：
 *
 * 1. pending —— 写入过消息但还没等到回合结束。布尔语义而非计数：如果第二条
 *    消息在第一条还没处理完时到达（同一个已运行的 PTY 会复用），两次 incPending
 *    会把计数推到 2，但 Claude 很可能把两条消息在同一次"思考"里一起处理完，
 *    只会出现一次真正的回合结束信号；如果用计数，一次 decPending 只会减到 1，
 *    永远清不干净，导致之后误判"还在等回复"或状态卡死（见 live bug 8）。
 *
 * 2. busyObserved —— 是否已经观察到过忙碌状态。单看 screenText"当前是不是
 *    空闲"不够：刚启动的欢迎屏和真正说完话之后的空闲屏，从"当前这一帧"的
 *    角度看是完全一样的——都是"没有忙碌标记 + 有 ❯"。必须先观察到真的进入过
 *    忙碌状态（"esc to interrupt" 出现过），再回到空闲，才算数（见 live bug 11）。
 *
 * 判断"就绪/忙碌"看的是 `AgentRunSnapshot.screenText`——由 terminal-state.ts
 * 的终端模拟器解析 PTY 输出后，实际渲染出来的"当前这一帧"，不是原始字节的
 * 流水账。这两组状态 + screenText 一起，取代了之前连续 4 次踩坑
 * （见 docs/2026-07-16/08-hive-alignment-gap-analysis.md 第 3/5/6/10 个 bug）
 * 的"偏移量记账 + 正则扫描历史"方案。
 *
 * 何时可删（O13）：本模块是「从 TUI 画面反推协议状态」的启发式。删除条件：
 * agent 输入/输出走结构化通道（PersistentClaude 的 stream-json 模式里
 * `{"type":"result"}` 事件就是精确的回合边界，无需任何画面猜测；buzz-agent
 * 的 ACP session/prompt 响应同理）。claude 每版本 UI 文案变动（如 busy 标记
 * 措辞）都会冲击 BUSY_MARKER_RE/PROMPT_RE，结构化输出事件不受此影响。
 */
export const BUSY_MARKER_RE = /esc\s*to\s*interrupt/i;
export const PROMPT_RE = /[❯›]/u;

export interface ITurnTracker {
  incPending(name: string): void;
  decPending(name: string): void;
  hasPending(name: string): boolean;
  markBusyObserved(name: string): void;
  hasBeenBusy(name: string): boolean;
  clearBusyObserved(name: string): void;
}

export const createTurnTracker = (): ITurnTracker => {
  const pendingMsgCount = new Map<string, true>();
  const busyObservedByAgent = new Map<string, true>();

  return {
    incPending: (name: string) => {
      pendingMsgCount.set(name, true);
    },
    decPending: (name: string) => {
      pendingMsgCount.delete(name);
    },
    hasPending: (name: string): boolean => pendingMsgCount.has(name),
    markBusyObserved: (name: string) => {
      busyObservedByAgent.set(name, true);
    },
    hasBeenBusy: (name: string): boolean => busyObservedByAgent.has(name),
    clearBusyObserved: (name: string) => {
      busyObservedByAgent.delete(name);
    },
  };
};
