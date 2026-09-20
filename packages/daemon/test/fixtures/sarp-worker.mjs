#!/usr/bin/env node
/**
 * sarp-worker.mjs — 可控 SARP/1（slock.agent-runtime v1）协议桩 worker。
 *
 * daemon Phase 2 测试夹具：给 PersistentJsonlWorkerSession 做真实进程级集成
 * 测试用。纯 Node ESM，零依赖。
 *
 * 两种模式：
 *   1. `--slock-probe`：打印单行 probe JSON 后 exit 0（Phase 1 entrypoint probe）。
 *   2. 服务模式：stdin 读 JSONL daemon→worker 帧，stdout 写 worker→daemon 帧。
 *      stdout 只承载协议帧（`{"literal"}` 指令除外——用于坏帧测试）；日志走 stderr。
 *
 * 环境变量控制面（全部 SLOCK_FX_ 前缀）：
 *   SLOCK_FX_RUNTIME_ID           ready/probe 的 runtime.id（默认 "langgraph"）
 *   SLOCK_FX_CAPABILITIES         JSON，深合并覆盖默认 capabilities
 *   SLOCK_FX_MODEL_SELECTED       ready/probe 的 model.selected（默认 "fx-model"）
 *   SLOCK_FX_MODEL_OVERRIDE       "false" → model.overrides=false（默认 true）
 *   SLOCK_FX_NO_READY=1           initialize 后不回任何握手帧
 *   SLOCK_FX_READY_DELAY_MS       延迟 ready/runtime.error 响应
 *   SLOCK_FX_READY_ERROR          initialize 后回 runtime.error{code:此值} 而非 ready
 *   SLOCK_FX_EXIT_AFTER_INIT=1    initialize 后 exit(42)
 *   SLOCK_FX_BAD_LINE_AFTER_INIT=1 initialize 后先写一行 "{not json" 再走 ready 流程
 *   SLOCK_FX_STARTUP_CRASH=1      进程起来即 exit(3)
 *   SLOCK_FX_SEQ_RESET=1          每发一帧后 outSeq 重置回 1（入向 seq 越序测试）
 *   SLOCK_FX_SCRIPT               JSON 数组，turn 脚本指令（见下）
 *   SLOCK_FX_TURN_DELAY_MS        turn 脚本开始前延迟
 *   SLOCK_FX_NO_TURN_END=1        脚本无自带终态时不补隐式 turn.end（silence 测试）
 *   SLOCK_FX_EMPTY_SUCCESS=1      等价脚本 [{"end":{"status":"success"}}]
 *   SLOCK_FX_ECHO_PROMPT=1        把 turn.start.prompt 作为 delta 回显 + success finalText
 *
 * SLOCK_FX_SCRIPT 指令（按序执行，每元素取第一个匹配的键）：
 *   {"delta":"s"}                          → assistant.delta{text:s}
 *   {"message":"s"}                        → assistant.message{text:s}
 *   {"progress":"s"}                       → assistant.progress{message:s}
 *   {"toolStart":{callId,name,provider?,operation?,input?}} → tool.start{callId,tool:{name,...},input?}
 *   {"toolEnd":{callId,ok,output?,error?,name?,provider?,operation?}} → tool.end{callId,tool:{...},ok,...}
 *   {"usage":{...}}                        → usage{usage:{...}}
 *   {"interrupt":{interruptId,resumeToken,prompt,payload?}} → turn.interrupt
 *   {"end":{status,finalText?,sessionRef?,usage?,interrupt?,error?}} → turn.end
 *   {"doubleEnd":{...同 end}}              → 连续两个 turn.end（重复终态测试）
 *   {"raw":{...}}                          → 原样对象加信封发出（不写 eventSeq/turnId 自动值）
 *   {"literal":"s"}                        → 原样写一行 stdout（坏帧测试）
 *   {"sleep":ms}                           → 延迟（可被 turn.cancel 打断）
 *   {"exit":code}                          → process.exit(code)
 *   {"eventSeqReset":true}                 → 后续回合帧 eventSeq 重新从 1 开始
 *   {"wrongTurnId":true}                   → 下一条回合帧 turnId 改为 "turn-other"
 *
 * 隐式终态：脚本跑完后若未发过 turn.end 且未开 NO_TURN_END，补一条
 *   turn.end{status:"success",finalText:<累计 delta 文本>,sessionRef:"fx-thread-1",
 *            usage:{inputTokens:10,outputTokens:5,totalTokens:15,durationMs:50,model:"fx"}}
 *   （finalText 为空时省略）。默认脚本因此等价于
 *   delta "hello " → delta "world" → usage → turn.end success "hello world"。
 */

import * as readline from "node:readline";

const env = process.env;

const RUNTIME_ID = env.SLOCK_FX_RUNTIME_ID || "langgraph";
const MODEL_SELECTED = env.SLOCK_FX_MODEL_SELECTED || "fx-model";
const MODEL_OVERRIDE = env.SLOCK_FX_MODEL_OVERRIDE !== "false";
const SEQ_RESET = env.SLOCK_FX_SEQ_RESET === "1";
const NO_TURN_END = env.SLOCK_FX_NO_TURN_END === "1";

const DEFAULT_CAPABILITIES = {
  persistentProcess: true,
  streamingText: true,
  toolEvents: true,
  durableThreads: true,
  interrupts: true,
  mcp: true,
  usage: "tokens",
  pty: false,
  maxConcurrency: 1,
};

const DEFAULT_USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15, durationMs: 50, model: "fx" };

const stderr = (msg) => {
  process.stderr.write(`sarp-worker: ${msg}\n`);
};

const int = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** SLOCK_FX_CAPABILITIES：深合并覆盖（嵌套对象递归，标量/数组整体替换）。 */
const deepMerge = (base, over) => {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
};

const parseJsonEnv = (name) => {
  const raw = env[name];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (e) {
    stderr(`${name} is not valid JSON: ${e.message}`);
    return undefined;
  }
};

const CAPABILITIES = deepMerge(DEFAULT_CAPABILITIES, parseJsonEnv("SLOCK_FX_CAPABILITIES") ?? {});

/* ------------------------------ 出向帧 ------------------------------ */

let outSeq = 1;

const buildFrame = (fields) => ({
  protocol: "slock.agent-runtime",
  version: 1,
  seq: outSeq,
  timestamp: new Date().toISOString(),
  ...fields,
});

const writeLine = (line) => {
  process.stdout.write(`${line}\n`);
};

const sendFrame = (fields) => {
  writeLine(JSON.stringify(buildFrame(fields)));
  outSeq = SEQ_RESET ? 1 : outSeq + 1;
};

const sendRawLine = (text) => writeLine(text);

/* ------------------------------ 回合状态 ----------------------------- */

let currentTurn = null;

const sendTurnFrame = (turn, type, fields) => {
  const turnId = turn.wrongTurnIdOnce ? "turn-other" : turn.turnId;
  turn.wrongTurnIdOnce = false;
  sendFrame({ type, turnId, eventSeq: turn.nextEventSeq++, ...fields });
};

const sendTurnEnd = (turn, spec) => {
  sendTurnFrame(turn, "turn.end", { status: "success", ...spec });
  turn.ended = true;
};

/** 可被打断的回合内 sleep：turn.cancel / stdin 关闭时立即返回；timer unref 不拖住进程。 */
const turnSleep = (turn, ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    turn.wake.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });

const cancelTurn = (turn) => {
  turn.cancelled = true;
  turn.wakeResolve();
};

/* ------------------------------ 脚本 ------------------------------- */

const buildScript = (frame) => {
  if (env.SLOCK_FX_SCRIPT) {
    const parsed = parseJsonEnv("SLOCK_FX_SCRIPT");
    if (Array.isArray(parsed)) return parsed;
    stderr("SLOCK_FX_SCRIPT is not a JSON array, falling back to default script");
  }
  if (env.SLOCK_FX_ECHO_PROMPT === "1") {
    // 隐式终态负责把累计 delta（=prompt）写进 finalText。
    return [{ delta: String(frame.prompt ?? "") }];
  }
  if (env.SLOCK_FX_EMPTY_SUCCESS === "1") {
    return [{ end: { status: "success" } }];
  }
  return [{ delta: "hello " }, { delta: "world" }, { usage: { ...DEFAULT_USAGE } }];
};

const execInstruction = async (turn, instr) => {
  if (!isPlainObject(instr)) {
    stderr(`skipping non-object script instruction: ${JSON.stringify(instr)}`);
    return;
  }
  if ("literal" in instr) {
    sendRawLine(String(instr.literal));
    return;
  }
  if ("raw" in instr) {
    if (isPlainObject(instr.raw)) sendFrame(instr.raw);
    else stderr(`skipping non-object raw instruction: ${JSON.stringify(instr.raw)}`);
    return;
  }
  if ("sleep" in instr) {
    await turnSleep(turn, Math.max(0, int(instr.sleep)));
    return;
  }
  if ("exit" in instr) {
    process.exit(int(instr.exit));
  }
  if ("eventSeqReset" in instr) {
    if (instr.eventSeqReset) turn.nextEventSeq = 1;
    return;
  }
  if ("wrongTurnId" in instr) {
    turn.wrongTurnIdOnce = Boolean(instr.wrongTurnId);
    return;
  }
  if ("delta" in instr) {
    const text = String(instr.delta);
    turn.deltaText += text;
    sendTurnFrame(turn, "assistant.delta", { text });
    return;
  }
  if ("message" in instr) {
    sendTurnFrame(turn, "assistant.message", { text: String(instr.message) });
    return;
  }
  if ("progress" in instr) {
    sendTurnFrame(turn, "assistant.progress", { message: String(instr.progress) });
    return;
  }
  if ("toolStart" in instr) {
    // §8.5：callId / input 顶层字段，tool 内只有 name/provider/operation
    const spec = isPlainObject(instr.toolStart) ? instr.toolStart : {};
    const { callId, input, ...tool } = spec;
    const fields = { callId: callId ?? "call_fx", tool };
    if (input !== undefined) fields.input = input;
    sendTurnFrame(turn, "tool.start", fields);
    return;
  }
  if ("toolEnd" in instr) {
    const spec = isPlainObject(instr.toolEnd) ? instr.toolEnd : {};
    const tool = {};
    if (spec.name !== undefined) tool.name = spec.name;
    if (spec.provider !== undefined) tool.provider = spec.provider;
    if (spec.operation !== undefined) tool.operation = spec.operation;
    const fields = { callId: spec.callId, tool, ok: Boolean(spec.ok) };
    if (spec.output !== undefined) fields.output = spec.output;
    if (spec.error !== undefined) fields.error = spec.error;
    sendTurnFrame(turn, "tool.end", fields);
    return;
  }
  if ("usage" in instr) {
    sendTurnFrame(turn, "usage", { usage: isPlainObject(instr.usage) ? instr.usage : {} });
    return;
  }
  if ("interrupt" in instr) {
    const spec = isPlainObject(instr.interrupt) ? instr.interrupt : {};
    const fields = { interruptId: spec.interruptId, resumeToken: spec.resumeToken, prompt: spec.prompt };
    if (spec.payload !== undefined) fields.payload = spec.payload;
    sendTurnFrame(turn, "turn.interrupt", fields);
    return;
  }
  if ("doubleEnd" in instr) {
    const spec = isPlainObject(instr.doubleEnd) ? instr.doubleEnd : {};
    sendTurnEnd(turn, spec);
    sendTurnEnd(turn, spec);
    return;
  }
  if ("end" in instr) {
    sendTurnEnd(turn, isPlainObject(instr.end) ? instr.end : {});
    return;
  }
  stderr(`unknown script instruction: ${JSON.stringify(instr)}`);
};

const runTurnScript = async (turn, frame) => {
  try {
    const delayMs = int(env.SLOCK_FX_TURN_DELAY_MS);
    if (delayMs > 0) await turnSleep(turn, delayMs);
    for (const instr of buildScript(frame)) {
      if (turn.cancelled) return;
      await execInstruction(turn, instr);
    }
    if (!turn.cancelled && !turn.ended && !NO_TURN_END) {
      const end = { status: "success", sessionRef: "fx-thread-1", usage: { ...DEFAULT_USAGE } };
      if (turn.deltaText) end.finalText = turn.deltaText;
      sendTurnEnd(turn, end);
    }
  } finally {
    if (currentTurn === turn) currentTurn = null;
  }
};

/* ---------------------------- daemon → worker --------------------------- */

const onInitialize = (frame) => {
  if (env.SLOCK_FX_EXIT_AFTER_INIT === "1") process.exit(42);
  if (env.SLOCK_FX_BAD_LINE_AFTER_INIT === "1") sendRawLine("{not json");
  // §8.3：runtime.ready / runtime.error 回显 initialize.requestId
  const requestId = typeof frame.requestId === "string" ? frame.requestId : undefined;
  const respond = () => {
    if (env.SLOCK_FX_NO_READY === "1") return;
    if (env.SLOCK_FX_READY_ERROR) {
      sendFrame({
        type: "runtime.error",
        ...(requestId ? { requestId } : {}),
        error: { code: env.SLOCK_FX_READY_ERROR, message: "ready failed" },
      });
      return;
    }
    sendFrame({
      type: "runtime.ready",
      ...(requestId ? { requestId } : {}),
      runtime: { id: RUNTIME_ID },
      capabilities: CAPABILITIES,
      model: { selected: MODEL_SELECTED, overrides: MODEL_OVERRIDE },
    });
  };
  const delayMs = int(env.SLOCK_FX_READY_DELAY_MS);
  if (delayMs > 0) {
    const timer = setTimeout(respond, delayMs);
    timer.unref?.();
  } else {
    respond();
  }
};

const onTurnStart = (frame) => {
  // maxConcurrency=1：新 turn.start 到达时静默放弃还在跑的旧脚本。
  if (currentTurn) cancelTurn(currentTurn);
  let wakeResolve = () => {};
  const turn = {
    turnId: typeof frame.turnId === "string" && frame.turnId ? frame.turnId : "turn-unknown",
    conversationId: frame.conversationId,
    source: frame.source,
    resume: frame.resume,
    nextEventSeq: 1,
    deltaText: "",
    ended: false,
    cancelled: false,
    wrongTurnIdOnce: false,
    wake: new Promise((resolve) => {
      wakeResolve = resolve;
    }),
    wakeResolve: () => wakeResolve(),
  };
  currentTurn = turn;
  void runTurnScript(turn, frame);
};

const onTurnCancel = (frame) => {
  if (!currentTurn || frame.turnId !== currentTurn.turnId) return;
  const turn = currentTurn;
  turn.wrongTurnIdOnce = false; // 取消终态永远挂在真实 turnId 上
  cancelTurn(turn);
  if (!turn.ended) sendTurnEnd(turn, { status: "cancelled" });
};

const onShutdown = () => {
  const line = JSON.stringify(buildFrame({ type: "runtime.stopped", reason: "shutdown" }));
  // 等 stdout 真正写出去再退，避免 Windows pipe 上最后一帧被 process.exit 截断。
  process.stdout.write(`${line}\n`, () => process.exit(0));
};

const handleFrame = (frame) => {
  switch (frame.type) {
    case "initialize":
      return onInitialize(frame);
    case "turn.start":
      return onTurnStart(frame);
    case "turn.cancel":
      return onTurnCancel(frame);
    case "shutdown":
      return onShutdown(frame);
    default:
      return; // 未识别 type 静默忽略
  }
};

/* ------------------------------ 模式入口 ------------------------------ */

const runProbe = () => {
  // probe 是独立单行 JSON（非 runtime.ready 帧）。带 type:"probe.result" +
  // seq/timestamp 以满足 daemon probeRuntimeEntrypoints 的 frame 校验。
  const probe = {
    protocol: "slock.agent-runtime",
    version: 1,
    type: "probe.result",
    probe: true,
    seq: 1,
    timestamp: new Date().toISOString(),
    runtime: { id: RUNTIME_ID },
    capabilities: CAPABILITIES,
    model: { selected: MODEL_SELECTED, overrides: MODEL_OVERRIDE },
  };
  process.stdout.write(`${JSON.stringify(probe)}\n`, () => process.exit(0));
};

const runService = () => {
  stderr(`service mode (runtime=${RUNTIME_ID})`);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!text.trim()) return;
    let frame;
    try {
      frame = JSON.parse(text);
    } catch (e) {
      stderr(`ignoring invalid JSON line: ${e.message}`);
      return;
    }
    if (!isPlainObject(frame)) {
      stderr("ignoring non-object frame");
      return;
    }
    handleFrame(frame);
  });
  rl.on("close", () => {
    // stdin 关闭（daemon 走了）：停掉当前回合脚本，让进程自然退出，
    // 已写入 stdout 的帧随事件循环排空正常 flush。
    if (currentTurn) cancelTurn(currentTurn);
  });
};

if (env.SLOCK_FX_STARTUP_CRASH === "1") process.exit(3);
if (process.argv.includes("--slock-probe")) runProbe();
else runService();
