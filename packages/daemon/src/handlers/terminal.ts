import type { WsToDaemonMessage } from "@collabagent/shared";
import { readTerminalLogTail } from "../terminal-log.js";
import type { HandlerContext } from "./types.js";

type WatchMsg = Extract<WsToDaemonMessage, { type: "terminal:watch" }>;
type HistoryMsg = Extract<WsToDaemonMessage, { type: "terminal:history" }>;
type UnwatchMsg = Extract<WsToDaemonMessage, { type: "terminal:unwatch" }>;
type ResizeMsg = Extract<WsToDaemonMessage, { type: "terminal:resize" }>;

export function handleTerminalWatch(ctx: HandlerContext, msg: WatchMsg): void {
  // 浏览器观众上线：开始按 400ms 节拍推这个 agent 的终端帧（G3）。
  // 帧内容直接取终端模拟器渲染好的当前屏（screenText），无变化不推。
  // B1：headless（persistent）路径没有 PTY 屏——用观察帧 replay buffer 渲染
  // 的 transcript 作为 screen 推同一条 terminal:frame 通道，web 侧零改动。
  const agentName = msg.agentName;
  if (!agentName) return;
  // 观众补发回放：obs replay buffer（事件流面板历史）+ scrollback/日志尾（live/log 页）。
  // server 对每位观众上线都转发一次 watch（观众可以是频道同事，不只 owner）——
  // 重复 watch 只补发回放，不重启推帧节拍。
  const sendBackfill = () => {
    const replay = ctx.runtime.__getObservationBus().replay(agentName);
    if (replay.length > 0) {
      ctx.sendWs({ type: "terminal:obs-history", agentName, frames: replay });
    }
    // 运行中的 run 发 scrollback（观众能看到打开终端前发生的事）；没有运行中的 run
    // 则发观察帧 transcript（headless）或落盘日志的尾部（agent 已被回收也能回看）。
    const runId = ctx.runtime.__getRunId(agentName);
    const run = runId ? ctx.runtime.__getAgentManager().getRun(runId) : undefined;
    const obsTranscript = ctx.runtime.__getObservationBus().transcript(agentName, 60_000);
    const historyText = run?.historyText || obsTranscript || readTerminalLogTail(agentName, 60_000);
    if (historyText.trim()) {
      ctx.sendWs({ type: "terminal:history", agentName, text: historyText });
    }
  };
  // 当前屏计算：PTY run 的 screenText，headless 用观察帧 transcript（两者同一条
  // terminal:frame 通道）。headless 下有观察帧内容就不算 offline（没有 PTY run 但 agent 活着）
  const computeFrame = (): { status: string; screen: string } => {
    const runId = ctx.runtime.__getRunId(agentName);
    const run = runId ? ctx.runtime.__getAgentManager().getRun(runId) : undefined;
    const state = ctx.runtime.getAgentState(agentName) ?? "unknown";
    const obsScreen = run ? "" : ctx.runtime.__getObservationBus().transcript(agentName, 60_000);
    const status = run ? state : obsScreen ? state : "offline";
    return { status, screen: run?.screenText ?? obsScreen };
  };
  // 无条件推一帧当前屏（绕过 tick 的「内容没变就不推」去重）：新观众/重开面板的观众
  // 立刻拿到当前状态与画面，不必等下一次内容变化（web 侧 pinia store 会留旧帧，
  // 不推新帧的话重开面板会一直渲染上次的「空闲」直到下一次变化——实测秒级~十秒级滞后）
  const pushCurrentFrame = () => {
    const { status, screen } = computeFrame();
    ctx.terminalLastFrame.set(agentName, status + "|" + screen); // 保持节拍去重基线一致
    ctx.sendWs({ type: "terminal:frame", agentName, screen, status, time: new Date().toISOString() });
  };
  if (ctx.terminalWatchers.has(agentName)) {
    // 已有观众在播：新观众只补回放，推帧节拍/观察帧订阅不动
    sendBackfill();
    pushCurrentFrame();
    return;
  }
  // B1 web 结构化视图：观看期间把观察帧原样推给浏览器（事件流面板消费），
  // 先补 replay buffer 作历史。PTY 路径无观察帧（bus 为空），订阅零开销；
  // 引用计数纪律与 terminal:frame 一致（无人观看不传输）。
  {
    sendBackfill();
    const obsBus = ctx.runtime.__getObservationBus();
    const unsub = obsBus.subscribe(agentName, (f) => {
      ctx.sendWs({ type: "terminal:obs-frame", agentName, frame: f });
    });
    ctx.terminalObsUnsubs.set(agentName, unsub);
  }
  const tick = () => {
    const { status, screen } = computeFrame();
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
  pushCurrentFrame(); // 立即推一帧（强制，不走去重），观众打开就能看到当前屏
  ctx.terminalWatchers.set(agentName, setInterval(tick, 400));
  console.log(`[Daemon] Terminal watch started for @${agentName}`);
}

export function handleTerminalHistory(ctx: HandlerContext, msg: HistoryMsg): void {
  // 观众主动请求历史日志（面板「日志」页）：读落盘日志尾部回传
  const agentName = msg.agentName;
  if (!agentName) return;
  const text = readTerminalLogTail(agentName);
  ctx.sendWs({ type: "terminal:history", agentName, text });
}

export function handleTerminalUnwatch(ctx: HandlerContext, msg: UnwatchMsg): void {
  const agentName = msg.agentName;
  const timer = ctx.terminalWatchers.get(agentName);
  if (timer) clearInterval(timer);
  ctx.terminalWatchers.delete(agentName);
  ctx.terminalLastFrame.delete(agentName);
  // B1：观察帧订阅一并退订（引用计数归零，停止传输）
  ctx.terminalObsUnsubs.get(agentName)?.();
  ctx.terminalObsUnsubs.delete(agentName);
}

export function handleTerminalResize(ctx: HandlerContext, msg: ResizeMsg): void {
  // 面板尺寸协商（真改比例）：浏览器按面板宽度算出期望 cols/rows 发过来，
  // 这里实时 resize 正在运行的 PTY（Claude Code 收 SIGWINCH 重排画面），
  // 并记住偏好尺寸供下次 spawn 直接用。
  const agentName = msg.agentName;
  const cols = Math.min(400, Math.max(20, Math.round(msg.cols || 0)));
  const rows = Math.min(100, Math.max(5, Math.round(msg.rows || 0)));
  if (!agentName || !cols || !rows) return;
  ctx.runtime.setPreferredTermSize(agentName, { cols, rows });
  const runId = ctx.runtime.__getRunId(agentName);
  if (runId) {
    ctx.runtime.__getAgentManager().resizeRun(runId, cols, rows);
  }
}
