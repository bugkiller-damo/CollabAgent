import { readTerminalLogTail } from "../terminal-log.js";
import type { HandlerContext } from "./types.js";

export function handleTerminalWatch(ctx: HandlerContext, msg: Record<string, unknown>): void {
  // 浏览器观众上线：开始按 400ms 节拍推这个 agent 的终端帧（G3）。
  // 帧内容直接取终端模拟器渲染好的当前屏（screenText），无变化不推。
  // B1：headless（persistent）路径没有 PTY 屏——用观察帧 replay buffer 渲染
  // 的 transcript 作为 screen 推同一条 terminal:frame 通道，web 侧零改动。
  const agentName = msg.agentName as string;
  if (!agentName || ctx.terminalWatchers.has(agentName)) return;
  // B1 web 结构化视图：观看期间把观察帧原样推给浏览器（事件流面板消费），
  // 先补 replay buffer 作历史。PTY 路径无观察帧（bus 为空），订阅零开销；
  // 引用计数纪律与 terminal:frame 一致（无人观看不传输）。
  {
    const obsBus = ctx.runtime.__getObservationBus();
    const replay = obsBus.replay(agentName);
    if (replay.length > 0) {
      ctx.sendWs({ type: "terminal:obs-history", agentName, frames: replay });
    }
    const unsub = obsBus.subscribe(agentName, (f) => {
      ctx.sendWs({ type: "terminal:obs-frame", agentName, frame: f });
    });
    ctx.terminalObsUnsubs.set(agentName, unsub);
  }
  // 先补发一段历史：运行中的 run 发 scrollback（观众能看到打开终端前
  // 发生的事）；没有运行中的 run 则发观察帧 transcript（headless）或
  // 落盘日志的尾部（agent 已被回收也能回看）。
  {
    const runId = ctx.runtime.__getRunId(agentName);
    const run = runId ? ctx.runtime.__getAgentManager().getRun(runId) : undefined;
    const obsTranscript = ctx.runtime.__getObservationBus().transcript(agentName, 60_000);
    const historyText = run?.historyText || obsTranscript || readTerminalLogTail(agentName, 60_000);
    if (historyText.trim()) {
      ctx.sendWs({ type: "terminal:history", agentName, text: historyText });
    }
  }
  const tick = () => {
    const runId = ctx.runtime.__getRunId(agentName);
    const manager = ctx.runtime.__getAgentManager();
    const run = runId ? manager.getRun(runId) : undefined;
    const state = ctx.runtime.getAgentState(agentName) ?? "unknown";
    // headless：有观察帧内容就不算 offline（没有 PTY run 但 agent 活着）
    const obsScreen = run ? "" : ctx.runtime.__getObservationBus().transcript(agentName, 60_000);
    const status = run ? state : obsScreen ? state : "offline";
    const screen = run?.screenText ?? obsScreen;
    const key = status + "|" + screen;
    if (ctx.terminalLastFrame.get(agentName) === key) return;
    ctx.terminalLastFrame.set(agentName, key);
    ctx.sendWs({
      type: "terminal:frame",
      agentName,
      screen,
      status,
      time: new Date().toISOString(),
    });
  };
  tick(); // 立即推一帧，观众打开就能看到当前屏
  ctx.terminalWatchers.set(agentName, setInterval(tick, 400));
  console.log(`[Daemon] Terminal watch started for @${agentName}`);
}

export function handleTerminalHistory(ctx: HandlerContext, msg: Record<string, unknown>): void {
  // 观众主动请求历史日志（面板「日志」页）：读落盘日志尾部回传
  const agentName = msg.agentName as string;
  if (!agentName) return;
  const text = readTerminalLogTail(agentName);
  ctx.sendWs({ type: "terminal:history", agentName, text });
}

export function handleTerminalUnwatch(ctx: HandlerContext, msg: Record<string, unknown>): void {
  const agentName = msg.agentName as string;
  const timer = ctx.terminalWatchers.get(agentName);
  if (timer) clearInterval(timer);
  ctx.terminalWatchers.delete(agentName);
  ctx.terminalLastFrame.delete(agentName);
  // B1：观察帧订阅一并退订（引用计数归零，停止传输）
  ctx.terminalObsUnsubs.get(agentName)?.();
  ctx.terminalObsUnsubs.delete(agentName);
}

export function handleTerminalResize(ctx: HandlerContext, msg: Record<string, unknown>): void {
  // 面板尺寸协商（真改比例）：浏览器按面板宽度算出期望 cols/rows 发过来，
  // 这里实时 resize 正在运行的 PTY（Claude Code 收 SIGWINCH 重排画面），
  // 并记住偏好尺寸供下次 spawn 直接用。
  const agentName = msg.agentName as string;
  const cols = Math.min(400, Math.max(20, Math.round(Number(msg.cols) || 0)));
  const rows = Math.min(100, Math.max(5, Math.round(Number(msg.rows) || 0)));
  if (!agentName || !cols || !rows) return;
  ctx.runtime.setPreferredTermSize(agentName, { cols, rows });
  const runId = ctx.runtime.__getRunId(agentName);
  if (runId) {
    ctx.runtime.__getAgentManager().resizeRun(runId, cols, rows);
  }
}
