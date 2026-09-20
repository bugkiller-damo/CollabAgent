/**
 * Phase 2：SARP/1（slock.agent-runtime v1）JSONL bridge worker 的常驻会话。
 * 见 docs/2026-09-20/02-daemon-langchain-langgraph-runtime-design.md §8/§15。
 *
 * 职责边界：线格式 / 信封 / schema / 入向 seq 单调性在 sarp-protocol.ts
 * （SarpInbound）；本文件管进程生命周期与回合状态机：
 * - 构造即 spawn（shell:false + env 白名单）并写 initialize（outSeq=1）；
 *   startupMs 内等不到 runtime.ready → 杀进程，失败经 `ready` / send() 传播；
 * - 握手校验（§8.3/§15.3）：runtime id 一致、maxConcurrency ≤ 1、
 *   requireDurableThreads、model overrideSupported——失败一律杀进程；
 * - send() = 一回合 Promise：turn.start → 流事件 → 恰好一个 turn.end；
 *   turnId 匹配、eventSeq 严格递增、唯一终态、终态后无该 turn 帧、
 *   empty-success（§8.7.8）；
 * - silenceMs 沉默超时：回合中每收一帧合法 stdout 消息重置（含被忽略的
 *   optional 未知帧），超时杀进程 + reject runtime-silence-timeout；
 * - 协议违规 / fatal 一律杀进程——worker 不可信即不可复用（§15.3）；
 * - stop() 幂等：turn.cancel → 宽限（≤1.5s）→ shutdown → 等 runtime.stopped
 *   或 shutdownMs → SIGTERM → 2s 不 exit → SIGKILL。
 */

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { applyAgentEnv } from "../agent-env-whitelist.js";
import type { AgentRuntimeSession, AgentRuntimeTurnResult, AgentTurnRequest } from "../agent-runtime-driver.js";
import type { AgentRuntimeEvent, AgentRuntimeUsage } from "../agent-runtime-events.js";
import { DispatchError, errMessage } from "../errors.js";
import { redactSecrets } from "../redact.js";
import {
  encodeSarpFrame,
  mapWireError,
  SARP_MAX_FRAME_BYTES,
  type SarpDaemonFrame,
  SarpInbound,
  type SarpInitializeFields,
  type SarpMcpDescriptor,
  SarpProtocolError,
  type SarpUsage,
  type SarpWorkerMessage,
} from "../sarp-protocol.js";

export interface JsonlWorkerTimeouts {
  startupMs: number;
  silenceMs: number;
  shutdownMs: number;
}

export interface JsonlWorkerSessionOptions {
  agentName: string;
  agent?: { id: string; name: string; displayName?: string; description?: string };
  runtime: string; // "langchain" | "langgraph"
  entrypoint: string; // manifest entrypoint id
  model?: string; // resolved profile model
  platformPrompt?: string;
  serverUrl?: string;
  tokenFile?: string;
  workspace: string; // initialize.platform.workspace
  mcp?: SarpMcpDescriptor;
  requireDurableThreads?: boolean;
  spawnSpec: { command: string; args: string[]; cwd: string; env: Record<string, string> };
  timeouts: JsonlWorkerTimeouts;
  onEvent: (ev: AgentRuntimeEvent) => void;
  onExit?: () => void;
  /** 测试注入 spawn；默认 node:child_process spawn */
  spawn?: typeof nodeSpawn;
  /** 测试注入时钟（只用于出向帧 timestamp，定时器不经过它） */
  now?: () => number;
}

type SourceKind = AgentTurnRequest["source"]["kind"];
/** §8.7.8：这些 source.kind 的 success 必须有非空 finalText 或 slock send 证据 */
const EMPTY_SUCCESS_KINDS = new Set<SourceKind>(["message", "dispatch", "nudge"]);
/** §17.3：stderr 环形缓冲（按字符截断） */
const STDERR_RING_CHARS = 16 * 1024;
/** 进错误消息的 stderr 尾部上限 */
const STDERR_TAIL_CHARS = 300;
/** stop() 里 turn.cancel → 强制结算的宽限上限 */
const CANCEL_GRACE_MAX_MS = 1500;
/** SIGTERM 后等 exit 的宽限（§8.8 超时兜底转 SIGKILL） */
const SIGKILL_GRACE_MS = 2000;

/** SARP usage → 规范化 usage（缺省 null，不填 0 冒充已计量） */
const mapUsage = (u?: SarpUsage): AgentRuntimeUsage => ({
  costUsd: u?.costUsd ?? null,
  durationMs: u?.durationMs ?? null,
  numTurns: u?.numTurns ?? null,
  inputTokens: u?.inputTokens ?? null,
  outputTokens: u?.outputTokens ?? null,
  totalTokens: u?.totalTokens ?? null,
  ...(u?.model !== undefined ? { model: u.model } : {}),
});

/** turn-scoped 帧（带 turnId/eventSeq 的那一组） */
type TurnScoped = Extract<SarpWorkerMessage, { turnId: string }>;
type TurnEndMsg = Extract<SarpWorkerMessage, { type: "turn.end" }>;
type ReadyMsg = Extract<SarpWorkerMessage, { type: "runtime.ready" }>;

interface ActiveTurn {
  turnId: string;
  sourceKind: SourceKind;
  lastEventSeq: number;
  /** §8.7.8：本回合是否观察到 slock send_message 工具成功（empty-success 豁免） */
  sawSlockSend: boolean;
  /** tool.start 登记的 callId → {name,provider,operation}（tool.end 配对 + slock send 判定） */
  tools: Map<string, { name: string; provider?: string; operation?: string }>;
  /**
   * §8.6：turn.interrupt 预览帧——若 worker 随后发 turn.end interrupted，
   * 规范 interrupt 的 interruptId/resumeToken/prompt 必须与预览一致。
   */
  previewInterrupt?: { interruptId: string; resumeToken: string; prompt: string };
  resolve: (r: AgentRuntimeTurnResult) => void;
  reject: (e: Error) => void;
  settled: boolean;
}

export class PersistentJsonlWorkerSession implements AgentRuntimeSession {
  private proc: ChildProcess | null = null;
  /**
   * 进程代次。本实现只 spawn 一次，gen 守卫的意义是「kill/cleanup 后迟到的
   * emit 不得再进 handler」——off 拦不住已入队的 emit（同 PersistentClaude）。
   */
  private procGen = 0;
  /** 挂在当前进程上的监听——cleanup 成对卸除。 */
  private bound: {
    proc: ChildProcess;
    onStdout: (d: Buffer | string) => void;
    onStderr: (d: Buffer | string) => void;
    onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
    onError: (err: Error) => void;
  } | null = null;
  private readonly inbound = new SarpInbound();
  private outSeq = 0;
  private lineBuf = "";
  private stderrBuf = "";
  private activeTurn: ActiveTurn | null = null;
  private readyState: "pending" | "ready" | "failed" = "pending";
  private stopped = false; // stop() 已调用（幂等闸 + onExit 抑制）
  private shutdownSent = false; // stop 流程的 shutdown 帧已写
  private sigtermSent = false; // SIGTERM 已发（SIGKILL 兜底只 arm 一次）
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  /** §8.2/§8.3：握手关联 id——initialize 下发，runtime.ready 必须原样回显 */
  private readonly initRequestId: string;
  private readonly now: () => number;
  /** 首个 send 等待的握手 Promise；openSession 同步返回即握手开始（§8.3） */
  readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (e: Error) => void;

  constructor(private opts: JsonlWorkerSessionOptions) {
    this.now = opts.now ?? Date.now;
    this.initRequestId = `init_${opts.agentName}_${Math.random().toString(36).slice(2, 10)}`;
    this.ready = new Promise<void>((res, rej) => {
      this.readyResolve = res;
      this.readyReject = rej;
    });
    // 预挂 handler：handshake 失败但尚无 send/await 时不触 unhandledRejection；
    // await 方拿到的仍是同一个 rejected promise。
    this.ready.catch(() => {});
    this.spawnWorker();
  }

  get alive(): boolean {
    return this.proc !== null && !this.stopped;
  }

  private tag(): string {
    return `[JsonlWorker ${this.opts.agentName}]`;
  }

  private isCurrent(proc: ChildProcess, gen: number): boolean {
    return this.proc === proc && this.procGen === gen;
  }

  /** 观察是旁路——onEvent 抛错吞掉，不影响主链路（同 PersistentClaude） */
  private emit(ev: AgentRuntimeEvent): void {
    try {
      this.opts.onEvent(ev);
    } catch {
      /* 观察旁路抛错不影响主链路 */
    }
  }

  /** onExit：仅当前进程自退触发；stop 流程 / 主动 kill 路径不调（P0.1 语义） */
  private notifyExit(): void {
    if (this.stopped) return;
    try {
      this.opts.onExit?.();
    } catch {
      /* 回调失败不阻断退出处理 */
    }
  }

  /* ------------------------------ spawn ------------------------------ */

  private spawnWorker(): void {
    const spec = this.opts.spawnSpec;
    const env = applyAgentEnv(spec.env, `JsonlWorker ${this.opts.agentName}`);
    const spawnFn = this.opts.spawn ?? nodeSpawn;
    this.procGen += 1;
    const gen = this.procGen;
    try {
      this.proc = spawnFn(spec.command, spec.args, {
        cwd: spec.cwd,
        shell: false,
        windowsHide: true,
        env,
      });
    } catch (err) {
      // spawn 同步抛（命令解析失败等）→ 会话不可用；send 经 ready 拿到 command-not-found
      this.proc = null;
      this.readyState = "failed";
      this.readyReject(new DispatchError("command-not-found", `${this.tag()} spawn failed: ${errMessage(err)}`));
      return;
    }
    const proc = this.proc;
    // 所有监听闭包捕获本次 spawn 的 proc/gen：kill 之后迟到的 emit 不得影响。
    const onStdout = (d: Buffer | string) => {
      if (this.isCurrent(proc, gen)) this.onStdoutData(d.toString());
    };
    const onStderr = (d: Buffer | string) => {
      if (this.isCurrent(proc, gen)) this.onStderrData(d.toString());
    };
    const onExit = (code: number | null, _signal: NodeJS.Signals | null) => this.handleProcExit(proc, gen, code);
    const onError = (err: Error) => this.handleProcError(proc, gen, err);
    proc.stdout?.on("data", onStdout);
    proc.stderr?.on("data", onStderr);
    proc.on("exit", onExit);
    proc.on("error", onError);
    this.bound = { proc, onStdout, onStderr, onExit, onError };

    // initialize（outSeq=1）——写不进去等同进程不可用
    if (!this.writeFrame({ type: "initialize", fields: this.initFields() })) {
      this.readyState = "failed";
      this.readyReject(new DispatchError("worker-exited", `${this.tag()} stdin write failed at initialize`));
      this.killProcess();
      return;
    }
    const timeout = this.opts.timeouts.startupMs;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      if (this.readyState !== "pending") return;
      this.failHandshake(new DispatchError("runtime-start-timeout", `runtime.ready not received within ${timeout}ms`));
    }, timeout);
  }

  /** undefined 字段不写入（JSON.stringify 会丢 undefined，这里显式构 fields） */
  private initFields(): SarpInitializeFields {
    const o = this.opts;
    return {
      requestId: this.initRequestId,
      agent: o.agent ?? { id: "", name: o.agentName },
      runtime: { id: o.runtime, entrypoint: o.entrypoint, ...(o.model !== undefined ? { model: o.model } : {}) },
      workspace: { path: o.workspace },
      platform: {
        ...(o.platformPrompt !== undefined ? { systemPrompt: o.platformPrompt } : {}),
        ...(o.serverUrl !== undefined ? { serverUrl: o.serverUrl } : {}),
        ...(o.tokenFile !== undefined ? { tokenFile: o.tokenFile } : {}),
        ...(o.mcp !== undefined ? { mcp: o.mcp } : {}),
      },
      limits: {
        maxFrameBytes: SARP_MAX_FRAME_BYTES,
        silenceTimeoutMs: o.timeouts.silenceMs,
        shutdownTimeoutMs: o.timeouts.shutdownMs,
      },
    };
  }

  /** 写一帧 daemon→worker（失败返回 false：EPIPE / stdin 已死） */
  private writeFrame(frame: SarpDaemonFrame): boolean {
    const stdin = this.proc?.stdin;
    if (!stdin) return false;
    try {
      stdin.write(encodeSarpFrame(frame, ++this.outSeq, { timestamp: new Date(this.now()).toISOString() }));
      return true;
    } catch {
      return false;
    }
  }

  /* ------------------------------ stdout/stderr ------------------------------ */

  private onStdoutData(chunk: string): void {
    this.lineBuf += chunk;
    // 无换行的半截行超过帧上限 = 注定违规，不必等换行（§8.1.3）
    if (Buffer.byteLength(this.lineBuf, "utf-8") > SARP_MAX_FRAME_BYTES) {
      this.violate(`stdout frame exceeds ${SARP_MAX_FRAME_BYTES} bytes`);
      return;
    }
    let idx: number;
    while ((idx = this.lineBuf.indexOf("\n")) >= 0) {
      const line = this.lineBuf.slice(0, idx);
      this.lineBuf = this.lineBuf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: SarpWorkerMessage | null;
      try {
        msg = this.inbound.next(line);
      } catch (err) {
        if (err instanceof SarpProtocolError) {
          this.violate(`inbound rejected (${err.reason}): ${err.message}`);
          return;
        }
        throw err;
      }
      // 沉默续命：任何合法帧都重置（含被忽略的 optional 未知帧——解码返回 null）
      if (this.activeTurn) this.armSilence();
      if (msg === null) continue; // §8.1.5：optional:true 未知帧忽略
      this.handleMessage(msg);
      // 处理过程可能已杀进程（违规/超时/fatal）——剩余行直接丢弃
      if (this.proc === null) return;
    }
  }

  private onStderrData(chunk: string): void {
    // §17.3：只记环形缓冲，不逐行刷 console——worker 自己的日志走 stderr，
    // daemon 不被打爆；进程级失败时取尾部进错误消息。
    this.stderrBuf = (this.stderrBuf + chunk).slice(-STDERR_RING_CHARS);
  }

  private stderrTail(): string {
    const t = redactSecrets(this.stderrBuf.trim());
    return t ? ` stderr: ${t.slice(-STDERR_TAIL_CHARS)}` : "";
  }

  /* ------------------------------ 消息路由 ------------------------------ */

  private handleMessage(msg: SarpWorkerMessage): void {
    if (this.stopped) {
      // stop 流程中：runtime.stopped 是 shutdown 应答 → 提前 SIGTERM；
      // turn-scoped 帧仍正常路由（cancel 宽限内的 turn.end 要让 send() 收口）。
      if (msg.type === "runtime.stopped") {
        const t = this.activeTurn;
        if (t) {
          this.activeTurn = null;
          this.rejectTurn(t, new DispatchError("agent-stopped", "worker stopped mid-turn"));
        }
        this.sigtermPhase();
        return;
      }
      if (this.activeTurn && "turnId" in msg) {
        this.handleTurnMessage(msg);
        return;
      }
      return;
    }
    if (this.readyState === "pending") {
      this.handleHandshakeMessage(msg);
      return;
    }
    switch (msg.type) {
      case "runtime.ready":
        this.violate("duplicate runtime.ready");
        return;
      case "runtime.stopped":
        // §8.8：worker 不该在回合中自行停止
        if (this.activeTurn) {
          this.violate("runtime.stopped mid-turn");
          return;
        }
        // 空闲自停 = 进程级退出语义
        this.killProcess();
        this.notifyExit();
        return;
      case "runtime.error": {
        const derr = mapWireError(msg.error);
        const turn = this.activeTurn;
        if (turn) {
          // 回合内 fatal：reject turn + 杀进程（worker 报进程级错误视同不可信继续）
          this.activeTurn = null;
          this.rejectTurn(turn, derr);
          this.killProcess();
        } else {
          // §8.3：无 active turn 的 runtime.error = fatal runtime 故障，不复用
          this.emit({ type: "warning", code: msg.error.code, message: `fatal runtime.error: ${msg.error.message}` });
          this.killProcess();
          this.notifyExit();
        }
        return;
      }
      case "runtime.warning":
        this.emit({ type: "warning", turnId: this.activeTurn?.turnId, code: msg.code, message: msg.message });
        return;
      default:
        this.handleTurnMessage(msg);
        return;
    }
  }

  private handleHandshakeMessage(msg: SarpWorkerMessage): void {
    switch (msg.type) {
      case "runtime.ready": {
        const err = this.validateReady(msg);
        if (err) {
          this.failHandshake(err);
          return;
        }
        this.readyState = "ready";
        if (this.startupTimer) {
          clearTimeout(this.startupTimer);
          this.startupTimer = null;
        }
        this.readyResolve();
        return;
      }
      case "runtime.error":
        this.failHandshake(mapWireError(msg.error));
        return;
      case "runtime.warning":
        this.emit({ type: "warning", code: msg.code, message: msg.message });
        return;
      case "runtime.stopped":
        this.failHandshake(
          new DispatchError("worker-exited", `worker stopped before runtime.ready${this.stderrTail()}`),
        );
        return;
      default:
        // §15.3：未 ready 就收到 turn-scoped 帧
        this.violate(`${msg.type} before runtime.ready`);
        return;
    }
  }

  /** 握手校验（§8.3/§15.3）：返回 null = 通过；否则握手失败须杀进程。 */
  private validateReady(msg: ReadyMsg): DispatchError | null {
    // §8.3：requestId 必须原样回显——对不上说明 ready 应答的不是本次握手
    if (msg.requestId !== this.initRequestId) {
      return new DispatchError(
        "protocol-violation",
        `runtime.ready requestId "${msg.requestId ?? ""}" != initialize.requestId "${this.initRequestId}"`,
      );
    }
    if (msg.runtime.id !== this.opts.runtime) {
      return new DispatchError(
        "runtime-id-mismatch",
        `worker runtime "${msg.runtime.id}" != expected "${this.opts.runtime}"`,
      );
    }
    const mc = msg.capabilities.maxConcurrency ?? 1;
    if (mc > 1) {
      return new DispatchError("protocol-violation", `worker declared maxConcurrency=${mc}, only serial supported`);
    }
    if (this.opts.requireDurableThreads && msg.capabilities.durableThreads !== true) {
      return new DispatchError("durable-threads-required", "profile requires durableThreads but worker declined it");
    }
    if (this.opts.model && msg.model?.overrides === false) {
      return new DispatchError("model-not-allowed", `worker rejected model override "${this.opts.model}"`);
    }
    return null;
  }

  /** 握手失败收口：reject ready + 杀进程（所有 handshake 失败均不可复用 worker） */
  private failHandshake(err: DispatchError): void {
    if (this.readyState !== "pending") return;
    this.readyState = "failed";
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    this.readyReject(err);
    this.killProcess();
  }

  /* ------------------------------ 回合状态机 ------------------------------ */

  private handleTurnMessage(msg: TurnScoped): void {
    const turn = this.activeTurn;
    // 无回合 / turnId 不符（含终态后同 turnId 的迟到帧、重复 turn.end）→ 违规
    if (!turn || msg.turnId !== turn.turnId) {
      this.violate(`${msg.type} for turnId ${msg.turnId} with no matching active turn`);
      return;
    }
    if (msg.eventSeq <= turn.lastEventSeq) {
      this.violate(`eventSeq regression on turn ${turn.turnId}: ${msg.eventSeq} <= ${turn.lastEventSeq}`);
      return;
    }
    turn.lastEventSeq = msg.eventSeq;
    switch (msg.type) {
      case "assistant.delta":
      case "assistant.message":
        this.emit({ type: "text", turnId: turn.turnId, text: msg.text });
        return;
      case "assistant.progress":
        this.emit({ type: "progress", turnId: turn.turnId, message: msg.message });
        return;
      case "tool.start":
        turn.tools.set(msg.callId, {
          name: msg.tool.name,
          provider: msg.tool.provider,
          operation: msg.tool.operation,
        });
        this.emit({
          type: "tool.start",
          turnId: turn.turnId,
          toolName: msg.tool.name,
          toolUseId: msg.callId,
          input: msg.input,
          provider: msg.tool.provider,
          operation: msg.tool.operation,
        });
        return;
      case "tool.end": {
        const paired = turn.tools.get(msg.callId) ?? msg.tool;
        // §8.7.8：slock send_message 成功 = 回复已发出，empty-success 豁免
        if (paired?.provider === "slock" && paired.operation === "send_message" && msg.ok === true) {
          turn.sawSlockSend = true;
        }
        this.emit({
          type: "tool.end",
          turnId: turn.turnId,
          toolName: paired?.name,
          toolUseId: msg.callId,
          output: typeof msg.output === "string" ? msg.output : JSON.stringify(msg.output ?? ""),
          ok: msg.ok,
          error: msg.error,
        });
        return;
      }
      case "usage":
        this.emit({ type: "usage", turnId: turn.turnId, usage: mapUsage(msg.usage) });
        return;
      case "turn.interrupt":
        // 预览帧（§8.6）：规范记录以 turn.end.interrupt 为准——存下三字段
        // 供终态一致性校验（双发时不一致 = protocol violation）。
        turn.previewInterrupt = {
          interruptId: msg.interruptId,
          resumeToken: msg.resumeToken,
          prompt: msg.prompt,
        };
        this.emit({
          type: "interrupt",
          turnId: turn.turnId,
          interrupt: {
            interruptId: msg.interruptId,
            resumeToken: msg.resumeToken,
            prompt: msg.prompt,
            payload: msg.payload,
          },
        });
        return;
      case "turn.end":
        this.handleTurnEnd(turn, msg);
        return;
      default:
        this.violate(`unexpected turn-scoped message ${(msg as { type: string }).type}`);
        return;
    }
  }

  /**
   * turn.end 终态结算：先 emit normalized turn.end，再 settle send() Promise。
   * 每个 turn 恰一个终态——clearActiveTurn 后同 turnId 的任何帧都是违规。
   */
  private handleTurnEnd(turn: ActiveTurn, msg: TurnEndMsg): void {
    // §8.6/§8.7.6 前置校验：必须在 clearActiveTurn 之前——violate 靠
    // activeTurn 槽位 reject 当前回合，先清槽会让 send() 永远挂起。
    if (msg.status === "interrupted") {
      if (!msg.interrupt) {
        this.emit({ type: "turn.end", status: "interrupted", usage: mapUsage(msg.usage) });
        this.violate(`turn.end interrupted without interrupt payload on ${turn.turnId}`);
        return;
      }
      const preview = turn.previewInterrupt;
      if (
        preview &&
        (preview.interruptId !== msg.interrupt.interruptId ||
          preview.resumeToken !== msg.interrupt.resumeToken ||
          preview.prompt !== msg.interrupt.prompt)
      ) {
        // §8.6：预览与规范记录不一致 = worker 自相矛盾，不可信
        this.emit({ type: "turn.end", status: "interrupted", interrupt: msg.interrupt, usage: mapUsage(msg.usage) });
        this.violate(`turn.end interrupt mismatches turn.interrupt preview on ${turn.turnId}`);
        return;
      }
    }
    this.clearActiveTurn(turn);
    const usage = mapUsage(msg.usage);
    switch (msg.status) {
      case "success": {
        this.emit({ type: "turn.end", status: "success", result: msg.finalText, usage });
        // §8.7.8 empty-success：reply-guard kind 且无文本且无 slock send 证据
        if (EMPTY_SUCCESS_KINDS.has(turn.sourceKind) && !msg.finalText?.trim() && !turn.sawSlockSend) {
          this.rejectTurn(
            turn,
            new DispatchError(
              "empty-success",
              `turn ${turn.turnId} (${turn.sourceKind}) succeeded with empty finalText and no slock send`,
            ),
          );
        } else {
          this.resolveTurn(turn, {
            status: "success",
            finalText: msg.finalText,
            usage,
            sessionRef: msg.sessionRef,
          });
        }
        return;
      }
      case "interrupted": {
        // 缺 interrupt / 与预览不一致已在进入 switch 前拦截（见上）
        this.emit({ type: "turn.end", status: "interrupted", interrupt: msg.interrupt, usage });
        this.resolveTurn(turn, {
          status: "interrupted",
          finalText: msg.finalText,
          usage,
          interrupt: msg.interrupt,
        });
        return;
      }
      case "cancelled":
        this.emit({ type: "turn.end", status: "cancelled", usage });
        this.resolveTurn(turn, { status: "cancelled" });
        return;
      case "error":
        this.emit({
          type: "turn.end",
          status: "error",
          subtype: msg.error?.code,
          result: msg.error?.message ?? "turn.end error",
          usage,
        });
        this.rejectTurn(
          turn,
          mapWireError(msg.error ?? { code: "TURN_FAILED", message: "turn.end error without error payload" }),
        );
        return;
    }
  }

  private resolveTurn(turn: ActiveTurn | null | undefined, result: AgentRuntimeTurnResult): void {
    if (!turn || turn.settled) return;
    turn.settled = true;
    turn.resolve(result);
  }

  private rejectTurn(turn: ActiveTurn | null | undefined, err: Error): void {
    if (!turn || turn.settled) return;
    turn.settled = true;
    turn.reject(err);
  }

  /** 回合脱离 active 槽位：停沉默计时；stop 流程中等回合结算以继续 shutdown。 */
  private clearActiveTurn(turn: ActiveTurn): void {
    if (this.activeTurn === turn) this.activeTurn = null;
    this.clearSilence();
    if (this.stopped) this.proceedShutdown();
  }

  /* ------------------------------ 沉默超时 ------------------------------ */

  /**
   * 沉默超时（卡死保护）：回合中每收到一帧合法 stdout 消息重置——语义是
   * 「沉默超时」而非回合绝对时长（同 PersistentClaude armTurnTimer 注释）。
   * 超时只 settle 当前回合 + 杀进程，不触发 onExit（send() reject 已由
   * dispatch catch 解封状态机）。
   */
  private armSilence(): void {
    this.clearSilence();
    const turn = this.activeTurn;
    if (!turn) return;
    const gen = this.procGen;
    const ms = this.opts.timeouts.silenceMs;
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      // 过期回调可能在 clearTimeout 前已入队：必须仍是同一进程代次 + 同一回合
      if (this.procGen !== gen || this.activeTurn !== turn) return;
      this.activeTurn = null;
      this.rejectTurn(turn, new DispatchError("runtime-silence-timeout", `no worker frame for ${ms}ms mid-turn`));
      this.killProcess();
    }, ms);
  }

  private clearSilence(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  /* ------------------------------ 违规与进程清理 ------------------------------ */

  /** 协议违规（§15.3）：warning 旁路 → reject 握手/回合 → 杀进程。 */
  private violate(reason: string): void {
    this.emit({ type: "warning", message: `protocol violation: ${reason}` });
    const err = new DispatchError("protocol-violation", reason);
    if (this.readyState === "pending") {
      this.readyState = "failed";
      this.readyReject(err);
    }
    const turn = this.activeTurn;
    if (turn) {
      this.activeTurn = null;
      this.rejectTurn(turn, err);
    }
    this.killProcess();
  }

  /** 杀进程路径：卸监听 + 清计时 + proc=null——迟到的 exit/stdout 全部落空。 */
  private killProcess(): void {
    const proc = this.proc;
    this.proc = null;
    this.clearAllTimers();
    this.detachProcListeners();
    this.lineBuf = "";
    if (proc) {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }
  }

  private detachProcListeners(): void {
    const b = this.bound;
    if (!b) return;
    this.bound = null;
    b.proc.stdout?.off("data", b.onStdout);
    b.proc.stderr?.off("data", b.onStderr);
    b.proc.off("exit", b.onExit);
    b.proc.off("error", b.onError);
  }

  private clearAllTimers(): void {
    this.clearSilence();
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
  }

  /** 进程真的死了之后的清理（exit/error 路径共用）。 */
  private cleanupDeadProc(): void {
    this.clearAllTimers();
    this.detachProcListeners();
    this.proc = null;
    this.lineBuf = "";
  }

  private handleProcExit(proc: ChildProcess, gen: number, code: number | null): void {
    if (!this.isCurrent(proc, gen)) return; // 旧进程迟到 exit：不得影响当前状态
    const tail = this.stderrTail();
    if (!this.stopped) console.error(`${this.tag()} worker exited code=${code}${tail}`);
    if (this.readyState === "pending") {
      this.readyState = "failed";
      this.readyReject(new DispatchError("worker-exited", `worker exited before runtime.ready (code=${code})${tail}`));
    }
    const turn = this.activeTurn;
    if (turn) {
      this.activeTurn = null;
      this.rejectTurn(turn, new DispatchError("worker-exited", `worker exited mid-turn (code=${code})${tail}`));
    }
    this.cleanupDeadProc();
    this.notifyExit();
  }

  private handleProcError(proc: ChildProcess, gen: number, err: Error): void {
    if (!this.isCurrent(proc, gen)) return;
    // spawn 级失败（命令不存在）与运行期进程错误分流
    const derr =
      (err as NodeJS.ErrnoException).code === "ENOENT"
        ? new DispatchError("command-not-found", `spawn failed: ${redactSecrets(errMessage(err))}`)
        : new DispatchError(
            "worker-exited",
            `worker process error: ${redactSecrets(errMessage(err))}${this.stderrTail()}`,
          );
    console.error(`${this.tag()} proc error: ${redactSecrets(errMessage(err))}`);
    if (this.readyState === "pending") {
      this.readyState = "failed";
      this.readyReject(derr);
    }
    const turn = this.activeTurn;
    if (turn) {
      this.activeTurn = null;
      this.rejectTurn(turn, derr);
    }
    this.cleanupDeadProc();
    this.notifyExit();
  }

  /* ------------------------------ send / stop ------------------------------ */

  send(request: AgentTurnRequest): Promise<AgentRuntimeTurnResult> {
    if (this.stopped) {
      return Promise.reject(new DispatchError("agent-stopped", `worker session for ${this.opts.agentName} stopped`));
    }
    return this.doSend(request);
  }

  private async doSend(request: AgentTurnRequest): Promise<AgentRuntimeTurnResult> {
    await this.ready; // handshake 失败（含 spawn 失败）原样传播
    if (this.stopped) throw new DispatchError("agent-stopped", `worker session for ${this.opts.agentName} stopped`);
    if (this.activeTurn) {
      // 防御性：正常串行派发不会触发（maxConcurrency=1）
      throw new DispatchError("protocol-violation", "concurrent turn on maxConcurrency=1 worker");
    }
    if (!this.proc) throw new DispatchError("worker-exited", `worker process not running${this.stderrTail()}`);
    return new Promise<AgentRuntimeTurnResult>((resolve, reject) => {
      const turn: ActiveTurn = {
        turnId: request.turnId,
        sourceKind: request.source.kind,
        lastEventSeq: 0,
        sawSlockSend: false,
        tools: new Map(),
        resolve,
        reject,
        settled: false,
      };
      this.activeTurn = turn;
      const ok = this.writeFrame({
        type: "turn.start",
        fields: {
          turnId: request.turnId,
          conversationId: request.conversationId,
          attempt: request.attempt,
          source: {
            kind: request.source.kind,
            channel: request.source.channel,
            threadId: request.source.threadId,
            sender: request.source.sender,
          },
          prompt: request.prompt,
          ...(request.resume ? { resume: request.resume } : {}),
        },
      });
      if (!ok) {
        // stdin EPIPE / 进程已死 → kill 路径（不挂起）
        this.activeTurn = null;
        this.rejectTurn(
          turn,
          new DispatchError("worker-exited", `worker stdin write failed (EPIPE)${this.stderrTail()}`),
        );
        this.killProcess();
        return;
      }
      this.armSilence();
    });
  }

  /**
   * 幂等停止。流程（§8.8）：turn.cancel → ≤1.5s 宽限 → 无 turn.end 则强制
   * 结算（agent-stopped）→ shutdown → 等 runtime.stopped 或 shutdownMs →
   * SIGTERM → 2s 不 exit → SIGKILL。stdin 写失败直接进 kill 路径。
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.readyState === "pending") {
      this.readyState = "failed";
      this.readyReject(new DispatchError("agent-stopped", "session stopped before runtime.ready"));
    }
    const proc = this.proc;
    const turn = this.activeTurn;
    if (!proc) {
      if (turn) {
        this.activeTurn = null;
        this.rejectTurn(turn, new DispatchError("agent-stopped", "session stopped"));
      }
      this.clearAllTimers();
      return;
    }
    if (turn && !turn.settled) {
      if (this.writeFrame({ type: "turn.cancel", fields: { turnId: turn.turnId, reason: "agent stopped" } })) {
        const grace = Math.min(CANCEL_GRACE_MAX_MS, this.opts.timeouts.shutdownMs);
        this.stopTimer = setTimeout(() => {
          this.stopTimer = null;
          const t = this.activeTurn;
          if (t) {
            this.rejectTurn(t, new DispatchError("agent-stopped", "turn force-settled on session stop"));
            this.clearActiveTurn(t); // → proceedShutdown
          } else {
            this.proceedShutdown();
          }
        }, grace);
        return;
      }
      // stdin 写失败 → 直接走 kill 路径（proceedShutdown 的 shutdown 写也会失败 → SIGTERM）
    }
    this.proceedShutdown();
  }

  /** stop 流程第二步：shutdown 帧 → 等 runtime.stopped 或 shutdownMs → SIGTERM。 */
  private proceedShutdown(): void {
    if (!this.stopped || this.shutdownSent) return;
    this.shutdownSent = true;
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    const proc = this.proc;
    if (!proc) return;
    if (
      !this.writeFrame({
        type: "shutdown",
        fields: { reason: "agent stopped", timeoutMs: this.opts.timeouts.shutdownMs },
      })
    ) {
      this.sigtermPhase();
      return;
    }
    this.stopTimer = setTimeout(() => this.sigtermPhase(), this.opts.timeouts.shutdownMs);
  }

  /** stop 流程末段：SIGTERM → 2s 不 exit → SIGKILL + 强制清理。 */
  private sigtermPhase(): void {
    if (this.sigtermSent) return;
    this.sigtermSent = true;
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    const proc = this.proc;
    if (!proc) return;
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      if (this.proc !== proc) return;
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      this.cleanupDeadProc();
    }, SIGKILL_GRACE_MS);
  }
}
