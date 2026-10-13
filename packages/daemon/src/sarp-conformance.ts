/**
 * Phase 5 §16：SARP/1 worker conformance runner。
 *
 * 新 worker（任何语言）接入前的协议合规验证：以真实 spawn + stdin/stdout
 * JSONL 驱动 worker，逐项检查协议不变量，输出结构化结果。
 *
 * 用法：
 *   const report = await runSarpConformance({
 *     spawnSpec: { command: "python", args: ["agent.py"], cwd: "...", env: {...} },
 *     runtimeId: "bridge", entrypoint: "my-ep",
 *   });
 *   report.ok === false → 哪条 check 挂了看 report.checks。
 *
 * 双会话结构：malformed 测试是破坏性的（fail-closed worker 收到坏行会
 * exit），不能与优雅关停验证共用进程，故同一 spawnSpec 顺序起两个 worker——
 *   Session A：spawn → initialize/handshake → [turn-lifecycle → seq-monotonic
 *              → eventseq-monotonic → cancel → replay] → shutdown → shutdown-exit
 *   Session B：spawn → initialize → 等到 runtime.ready → malformed-stdin
 * 报告检查集固定为：handshake, turn-lifecycle, seq-monotonic,
 * eventseq-monotonic, cancel, replay, shutdown, shutdown-exit, malformed-stdin。
 *
 * 检查项（与 docs/2026-09-21/02-sarp1-protocol.md 一一对应）：
 *   handshake          initialize → runtime.ready（requestId 回显 + runtime.id）
 *   turn-lifecycle     turn.start → 恰好一个 turn.end（turnId 匹配）
 *   seq-monotonic      出向帧 seq 严格递增（读帧途中越序 → 该项与在跑的
 *                      回合检查一起 fail，不再无条件 pass）
 *   eventseq-monotonic 回合帧 eventSeq 从 1 严格递增
 *   cancel             turn.cancel → cancelled 终态。cancel 是基础协议帧，
 *                      不看 capabilities.interrupts（那是 LangGraph HITL
 *                      resume 能力，LangChain worker interrupts=false 照样
 *                      支持 cooperative cancel）。turn 先于 cancel 完成
 *                      （success/error/interrupted）→ skip「未验证」而非假 pass。
 *   replay             同 turnId 重发 → journal 只回放已存终态帧（§15.4）：
 *                      恰好一个 turn.end 且 status 一致 → pass；多发回合帧
 *                      = 重跑 handler → fail；expectJournal=false → skip。
 *   shutdown           shutdown → runtime.stopped → exit(0)（§6）：
 *                      容忍 stopped 前的 drain 帧（SDK 先排空 pending 回合）；
 *                      未发 stopped 就退 → fail；worker 在发 shutdown 前已死
 *                      → 双 skip（优雅关停未验证，不再假 pass）。
 *   shutdown-exit      进程退出码必须 0；不退/退非零 → fail。
 *   malformed-stdin    非 JSON 行入向（独立会话 B）：合规 = (a) 忽略继续服务
 *                      且 shutdown 仍可达，或 (b) runtime.error + exit(非零)
 *                      fail-closed；不合规 = 静默挂死（坏行后 shutdown 不可达）。
 *
 * 纪律：runner 只断言「协议层不变量」，不断言业务语义（文本内容、模型选择等）。
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { normalizeRuntimeId } from "@collabagent/shared";

export interface ConformanceSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface ConformanceOptions {
  spawnSpec: ConformanceSpawnSpec;
  /** 期望的 ready.runtime.id */
  runtimeId: string;
  /** initialize.runtime.entrypoint（worker 侧通常只校验 id，此值进帧供日志/校验） */
  entrypoint?: string;
  /** 期望的 model.selected 断言（可选） */
  expectModel?: string;
  /** worker 实现了 turn journal → 跑 replay 检查（slock_runtime SDK = true） */
  expectJournal?: boolean;
  /**
   * 批次 B：跳过所有真实回合检查（turn-lifecycle/seq/eventseq/cancel/replay
   * 全部 skip）——turn.start 会驱动 worker 业务逻辑，可能调真实 provider
   * 烧额度或产生第三方副作用；CLI `slock runtime check` 默认加此开关，
   * 显式 --run-turns 才跑完整回合面。handshake/malformed/shutdown 仍执行。
   */
  skipTurns?: boolean;
  /** initialize.workspace.path（缺省 = spawnSpec.cwd）——check CLI 传临时目录 */
  workspacePath?: string;
  /** 每步等待上限，默认 8000ms */
  stepTimeoutMs?: number;
  /** 自定义 spawn（测试注入） */
  spawn?: typeof import("node:child_process").spawn;
}

export type CheckStatus = "pass" | "fail" | "skip";

export interface ConformanceCheck {
  name: string;
  status: CheckStatus;
  detail?: string;
}

export interface ConformanceReport {
  ok: boolean;
  checks: ConformanceCheck[];
  /** worker stderr 尾部（诊断用） */
  stderrTail: string;
}

interface Frame {
  type?: string;
  seq?: number;
  turnId?: string;
  eventSeq?: number;
  requestId?: string;
  status?: string;
  runtime?: { id?: string };
  capabilities?: Record<string, unknown>;
  error?: { code?: string; message?: string };
  [k: string]: unknown;
}

const PROTOCOL = "slock.agent-runtime";
const VERSION = 1;

/** nextEvent 的三态观察结果：帧 / 进程退出 / 窗口内无任何动静。 */
type WorkerEvent = { kind: "frame"; frame: Frame } | { kind: "exit"; code: number | null } | { kind: "timeout" };

class WorkerProc {
  readonly proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private stderrBuf = "";
  private outSeq = 0;
  private lines: string[] = [];
  private waiters: {
    resolve: (l: string) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  private exitCode: number | null = null;
  private stdoutClosed = false;
  readonly exited: Promise<number | null>;

  constructor(spec: ConformanceSpawnSpec, spawnFn: typeof spawn = spawn) {
    this.proc = spawnFn(spec.command, spec.args, {
      cwd: spec.cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...(spec.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString("utf-8");
      let idx: number;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx).replace(/\r$/, "");
        this.buf = this.buf.slice(idx + 1);
        const w = this.waiters.shift();
        if (w) {
          clearTimeout(w.timer);
          w.resolve(line);
        } else {
          this.lines.push(line);
        }
      }
    });
    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuf += chunk.toString("utf-8");
    });
    // worker 先死时写 stdin 的 EPIPE——忽略，退出状态由 exit/close 事件反映。
    this.proc.stdin.on("error", () => {});
    this.proc.stdout.on("close", () => {
      this.stdoutClosed = true;
      for (const w of this.waiters.splice(0)) {
        clearTimeout(w.timer);
        w.reject(new Error(`stdout closed (exit=${this.exitCode}) — stderr: ${this.stderrTail()}`));
      }
    });
    this.exited = new Promise((resolve) => {
      this.proc.on("exit", (code) => {
        this.exitCode = code;
        resolve(code);
      });
      // spawn 失败（ENOENT/EACCES）没有 exit 事件——按 exitCode=-1 终结并释放 waiter。
      this.proc.on("error", (err) => {
        if (this.exitCode === null) this.exitCode = -1;
        this.stdoutClosed = true;
        for (const w of this.waiters.splice(0)) {
          clearTimeout(w.timer);
          w.reject(new Error(`worker spawn error: ${err.message}`));
        }
        resolve(this.exitCode);
      });
    });
  }

  stderrTail(): string {
    const tail = this.stderrBuf.trim().split("\n");
    return tail.slice(-8).join("\n");
  }

  send(fields: Record<string, unknown>): void {
    this.proc.stdin.write(
      `${JSON.stringify({ protocol: PROTOCOL, version: VERSION, seq: ++this.outSeq, timestamp: new Date().toISOString(), ...fields })}\n`,
    );
  }

  sendRaw(line: string): void {
    this.proc.stdin.write(`${line}\n`);
  }

  readLine(timeoutMs: number): Promise<string> {
    if (this.lines.length) return Promise.resolve(this.lines.shift()!);
    if (this.stdoutClosed) {
      return Promise.reject(new Error(`stdout already closed — stderr: ${this.stderrTail()}`));
    }
    return new Promise<string>((resolve, reject) => {
      const waiter = {
        resolve: (l: string) => {
          clearTimeout(waiter.timer);
          resolve(l);
        },
        reject,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error(`no stdout line within ${timeoutMs}ms — stderr: ${this.stderrTail()}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async readFrame(timeoutMs: number): Promise<Frame> {
    return JSON.parse(await this.readLine(timeoutMs));
  }

  /** 已退出进程的退出码；未退出 → null（不等待）。 */
  exitCodeSync(): number | null {
    return this.exitCode;
  }

  /** 解析不了的 stdout 行当 __garbage__ 帧吐给调用方——runner 不得因 worker
   *  乱写 stdout 而崩掉（那本身就是待逮的违例）。 */
  private static parseFrame(line: string): Frame {
    try {
      return JSON.parse(line) as Frame;
    } catch {
      return { type: "__garbage__" };
    }
  }

  /** stdout 关闭后的退出码等待：给 exit 事件 1s 宽限，缺席报 timeout——
   *  worker 可以关流续跑，runner 不得跟着挂死。 */
  private exitEvent(): Promise<WorkerEvent> {
    return Promise.race([
      this.exited.then((code) => ({ kind: "exit", code }) as WorkerEvent),
      new Promise<WorkerEvent>((r) => setTimeout(() => r({ kind: "timeout" }), 1000)),
    ]);
  }

  /**
   * 竞速观察下一个事件：frame / exit / timeout 三选一。
   * malformed/shutdown 检查靠它区分「worker 回应」「fail-closed 退出」「静默挂死」。
   * 缓冲里还有未读行时永远先吐帧（进程退出前排空的帧优先于退出码）。
   */
  nextEvent(timeoutMs: number): Promise<WorkerEvent> {
    if (this.lines.length) {
      return Promise.resolve({ kind: "frame", frame: WorkerProc.parseFrame(this.lines.shift()!) });
    }
    if (this.stdoutClosed) {
      // stdout 已关 = 帧流终结；exit 事件可能差一拍，等它落地拿真实退出码（有界）。
      return this.exitEvent();
    }
    return new Promise<WorkerEvent>((resolve) => {
      const cleanup = () => {
        clearTimeout(waiter.timer);
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        this.proc.off("exit", onExit);
      };
      const onExit = (code: number | null) => {
        cleanup();
        resolve({ kind: "exit", code });
      };
      const waiter = {
        resolve: (l: string) => {
          cleanup();
          resolve({ kind: "frame", frame: WorkerProc.parseFrame(l) });
        },
        reject: (_e: Error) => {
          // stdout 关闭但 exit 事件未到/缺席 → 竞速真实退出码与短宽限。
          cleanup();
          void this.exitEvent().then(resolve);
        },
        timer: setTimeout(() => {
          cleanup();
          resolve({ kind: "timeout" });
        }, timeoutMs),
      };
      this.proc.on("exit", onExit);
      this.waiters.push(waiter);
    });
  }

  kill(): void {
    try {
      this.proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

export const runSarpConformance = async (opts: ConformanceOptions): Promise<ConformanceReport> => {
  const t = opts.stepTimeoutMs ?? 8000;
  const checks: ConformanceCheck[] = [];
  const check = (name: string, status: CheckStatus, detail?: string): void => {
    checks.push({ name, status, ...(detail !== undefined ? { detail } : {}) });
  };
  const pass = (name: string, detail?: string) => check(name, "pass", detail);
  const fail = (name: string, detail?: string) => check(name, "fail", detail);
  const skip = (name: string, detail?: string) => check(name, "skip", detail);

  const spawnFn = (opts.spawn ?? spawn) as typeof spawn;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /**
   * 会话共用起手：发 initialize 并等首帧。Session A 拿首帧做完整字段校验
   * （handshake 检查）；Session B 只要求首帧是 runtime.ready 即可继续。
   */
  const sendInitialize = async (worker: WorkerProc): Promise<{ requestId: string; first: Frame }> => {
    const requestId = `conf-${Math.random().toString(36).slice(2, 10)}`;
    worker.send({
      type: "initialize",
      requestId,
      agent: { id: "conformance", name: "conformance" },
      runtime: {
        id: opts.runtimeId,
        entrypoint: opts.entrypoint ?? "conformance",
        ...(opts.expectModel !== undefined ? { model: opts.expectModel } : {}),
      },
      workspace: { path: opts.workspacePath ?? opts.spawnSpec.cwd },
      platform: {},
      limits: { maxFrameBytes: 1048576, silenceTimeoutMs: Math.max(t * 4, 30000), shutdownTimeoutMs: 5000 },
    });
    return { requestId, first: await worker.readFrame(t) };
  };

  /** shutdown 可达性探针：发 shutdown，等 runtime.stopped 或进程退出（上限 t）。 */
  const probeShutdown = async (worker: WorkerProc): Promise<boolean> => {
    try {
      worker.send({ type: "shutdown", reason: "conformance done", timeoutMs: 3000 });
    } catch {
      /* 写失败 → 进程多半刚死；继续看退出事件 */
    }
    const deadline = Date.now() + t;
    for (;;) {
      const ev = await worker.nextEvent(Math.max(1, deadline - Date.now()));
      if (ev.kind === "frame") {
        if (ev.frame.type === "runtime.stopped") return true;
        continue; // drain 帧（pending 回合终态/usage 等）继续等
      }
      return ev.kind === "exit";
    }
  };

  /* ==================== Session A：握手 + 回合面 + 优雅关停 ==================== */
  let workerA: WorkerProc;
  try {
    workerA = new WorkerProc(opts.spawnSpec, spawnFn);
  } catch (err) {
    fail("handshake", `spawn failed: ${(err as Error).message}`);
    return { ok: false, checks, stderrTail: "" };
  }

  let tailA = "";
  try {
    /* ---------------- handshake ---------------- */
    let requestId: string;
    let ready: Frame;
    try {
      ({ requestId, first: ready } = await sendInitialize(workerA));
    } catch (err) {
      fail("handshake", `runtime.ready not received: ${(err as Error).message}`);
      return { ok: false, checks, stderrTail: workerA.stderrTail() };
    }
    if (ready.type !== "runtime.ready") {
      fail("handshake", `first frame type=${ready.type} (expected runtime.ready)`);
      return { ok: false, checks, stderrTail: workerA.stderrTail() };
    }
    if (ready.requestId !== requestId) {
      fail("handshake", `requestId echo mismatch: got ${ready.requestId}`);
      return { ok: false, checks, stderrTail: workerA.stderrTail() };
    }
    // WP6：runtime.id 归一比较——旧 SDK worker 收到 declared 别名后回显该别名
    // （init.runtime_id 严格比对实现），与期望的规范/别名值归一后等价即通过。
    const readyRuntimeId = ready.runtime?.id;
    if (normalizeRuntimeId(readyRuntimeId) !== normalizeRuntimeId(opts.runtimeId)) {
      fail("handshake", `runtime.id=${readyRuntimeId} != expected ${opts.runtimeId}`);
      return { ok: false, checks, stderrTail: workerA.stderrTail() };
    }
    if (ready.seq !== 1) {
      fail("handshake", `ready.seq=${ready.seq} (expected 1)`);
      return { ok: false, checks, stderrTail: workerA.stderrTail() };
    }
    if (
      opts.expectModel !== undefined &&
      ready.model &&
      (ready.model as { selected?: string }).selected !== opts.expectModel
    ) {
      fail("handshake", `model.selected=${(ready.model as { selected?: string }).selected} != ${opts.expectModel}`);
      return { ok: false, checks, stderrTail: workerA.stderrTail() };
    }
    pass("handshake", `runtime.id=${readyRuntimeId}, requestId echoed`);

    /* ---------------- 工具函数 ---------------- */
    let lastSeq = ready.seq ?? 1;
    // seq 越序发生在回合读帧途中：错误先归到在跑的检查，flag 留给 seq-monotonic 判 fail。
    let seqViolation: string | null = null;
    const readTurnFrames = async (): Promise<Frame[]> => {
      const frames: Frame[] = [];
      for (;;) {
        const f = await workerA.readFrame(t);
        frames.push(f);
        if (f.seq !== undefined) {
          if (f.seq <= lastSeq) {
            seqViolation = `seq regression: ${f.seq} <= ${lastSeq}`;
            throw new Error(seqViolation);
          }
          lastSeq = f.seq;
        }
        if (f.type === "turn.end") return frames;
      }
    };

    /* ---------------- turn-lifecycle / seq / eventseq / cancel / replay ----------------
     * skipTurns：真实回合会驱动 worker 业务逻辑（可能调 provider/副作用）——
     * CLI check 默认不跑；整段标 skip 保持报告形状完整。 */
    if (opts.skipTurns) {
      skip("turn-lifecycle", "skipTurns (no real turn started)");
      skip("seq-monotonic", "skipTurns");
      skip("eventseq-monotonic", "skipTurns");
      skip("cancel", "skipTurns");
      skip("replay", "skipTurns");
    } else {
      /* ---------------- turn-lifecycle ---------------- */
      workerA.send({
        type: "turn.start",
        turnId: "conf-t1",
        conversationId: "conf-conv",
        attempt: 1,
        source: { kind: "message", channel: "conformance" },
        prompt: "conformance check",
      });
      let t1Frames: Frame[];
      try {
        t1Frames = await readTurnFrames();
      } catch (err) {
        fail("turn-lifecycle", `no turn.end: ${(err as Error).message}`);
        // seq 越序归到 seq-monotonic 名下一起 fail——越序才是根因。
        if (seqViolation) fail("seq-monotonic", seqViolation);
        return { ok: false, checks, stderrTail: workerA.stderrTail() };
      }
      const t1End = t1Frames[t1Frames.length - 1]!;
      if (t1End.turnId !== "conf-t1") {
        fail("turn-lifecycle", `turn.end.turnId=${t1End.turnId} != conf-t1`);
        return { ok: false, checks, stderrTail: workerA.stderrTail() };
      }
      if (!["success", "error", "cancelled", "interrupted"].includes(String(t1End.status))) {
        fail("turn-lifecycle", `turn.end.status=${t1End.status} unknown`);
        return { ok: false, checks, stderrTail: workerA.stderrTail() };
      }
      pass("turn-lifecycle", `turn.end status=${t1End.status}`);
      if (seqViolation) {
        fail("seq-monotonic", seqViolation);
      } else {
        pass("seq-monotonic", `last seq=${lastSeq}`);
      }

      const turnScoped = t1Frames.filter((f) => f.turnId === "conf-t1" && f.eventSeq !== undefined);
      const eventSeqs = turnScoped.map((f) => f.eventSeq as number);
      const monotonic = eventSeqs.every((v, i) => i === 0 || v > eventSeqs[i - 1]!);
      if (eventSeqs.length === 0) {
        fail("eventseq-monotonic", "no turn-scoped frames with eventSeq");
      } else if (!monotonic || eventSeqs[0] !== 1) {
        fail("eventseq-monotonic", `eventSeq not strictly increasing from 1: ${eventSeqs.join(",")}`);
      } else {
        pass("eventseq-monotonic", `${eventSeqs.length} frames, 1..${eventSeqs[eventSeqs.length - 1]}`);
      }

      /* ---------------- cancel ----------------
       * turn.cancel 是基础协议帧——不做 capabilities 门（interrupts 是 HITL
       * resume 能力，LangChain worker interrupts=false 也支持 cooperative
       * cancel）。turn 先于 cancel 落地（success/error/interrupted）→ skip
       * 「cancel 未被验证」，不假装 pass。 */
      workerA.send({
        type: "turn.start",
        turnId: "conf-tc",
        conversationId: "conf-conv",
        attempt: 1,
        source: { kind: "message", channel: "conformance" },
        prompt: "long turn to cancel",
      });
      workerA.send({ type: "turn.cancel", turnId: "conf-tc", reason: "conformance cancel" });
      try {
        const cFrames = await readTurnFrames();
        const cEnd = cFrames[cFrames.length - 1]!;
        if (cEnd.turnId !== "conf-tc") {
          fail("cancel", `turn.end.turnId=${cEnd.turnId} != conf-tc`);
        } else if (cEnd.status === "cancelled") {
          pass("cancel", "turn.end status=cancelled");
        } else if (["success", "error", "interrupted"].includes(String(cEnd.status))) {
          skip("cancel", `turn ended status=${cEnd.status} before cancel took effect — cancel path unverified`);
        } else {
          fail("cancel", `unexpected status=${cEnd.status}`);
        }
      } catch (err) {
        fail("cancel", `no turn.end after cancel — cancel ignored? (${(err as Error).message})`);
      }

      /* ---------------- journal replay（§15.4）----------------
       * journaled worker 对重复 turnId 只回放已存的终态帧，不重跑 handler：
       * 恰好一个 turn.end 且 status 一致 → pass；多出回合帧 = 重跑 → fail。 */
      if (opts.expectJournal) {
        workerA.send({
          type: "turn.start",
          turnId: "conf-t1", // 与已完成回合同 turnId → 应回放同终态，不重跑
          conversationId: "conf-conv",
          attempt: 2,
          source: { kind: "message", channel: "conformance" },
          prompt: "replay probe",
        });
        try {
          const rFrames = await readTurnFrames();
          const rEnd = rFrames[rFrames.length - 1]!;
          if (rFrames.length > 1) {
            fail("replay", `turn re-executed (${rFrames.length} frames) — expected stored-terminal replay`);
          } else if (rEnd.status !== t1End.status) {
            fail("replay", `replay status=${rEnd.status} != original ${t1End.status}`);
          } else {
            pass("replay", `replayed turn.end status=${rEnd.status} (single stored terminal)`);
          }
        } catch (err) {
          fail("replay", `no replayed turn.end: ${(err as Error).message}`);
        }
      } else {
        skip("replay", "expectJournal=false");
      }
    }

    /* ---------------- shutdown（Session A，skipTurns 也照跑）----------------
     * §6 正常退出纪律：shutdown → runtime.stopped{reason} → exit(0)。
     * worker 在发 shutdown 前已死 → 优雅关停根本没被验证 → 双 skip，不假 pass。 */
    const preCode = workerA.exitCodeSync();
    if (preCode !== null) {
      skip("shutdown", `worker already exited (code=${preCode}) — graceful shutdown not exercised`);
      skip("shutdown-exit", `worker already exited (code=${preCode}) — graceful shutdown not exercised`);
    } else {
      try {
        workerA.send({ type: "shutdown", reason: "conformance done", timeoutMs: 3000 });
      } catch {
        /* 写失败 → 进程多半刚死；下面的 nextEvent 会拿到 exit */
      }
      // 等 runtime.stopped：容忍其前的 drain 帧（SDK 先排空 pending 回合）。
      const deadline = Date.now() + t;
      for (;;) {
        const ev = await workerA.nextEvent(Math.max(1, deadline - Date.now()));
        if (ev.kind === "frame") {
          if (ev.frame.type === "runtime.stopped") {
            pass("shutdown", "runtime.stopped received");
            break;
          }
          continue; // drain 帧
        }
        if (ev.kind === "exit") {
          fail("shutdown", `exited (code=${ev.code}) without runtime.stopped (§6 requires stopped before exit)`);
          break;
        }
        fail("shutdown", `no runtime.stopped within ${t}ms`);
        break;
      }
      // §6：正常退出必须是 exit(0)；任何非零（含 fail-closed 的 2）都不算干净关停。
      await Promise.race([workerA.exited, sleep(t)]);
      const code = workerA.exitCodeSync();
      if (code === null) {
        fail("shutdown-exit", "did not exit after shutdown");
      } else if (code === 0) {
        pass("shutdown-exit", "exit code=0");
      } else {
        fail("shutdown-exit", `exit code=${code}`);
      }
    }
  } finally {
    tailA = workerA.stderrTail();
    workerA.kill();
  }

  /* ==================== Session B：malformed-stdin（破坏性，独立 worker） ====================
   * §6 入向坏行纪律：合规 = (a) 忽略坏行继续服务且 shutdown 仍可达，或
   * (b) runtime.error 后 exit(非零) fail-closed；不合规 = 静默挂死。
   * 因为 (b) 会直接杀死进程，本检查必须在独立会话里跑（Session A 已先完成
   * 优雅关停验证，报告里它仍排最后）。 */
  let tailB = "";
  let workerB: WorkerProc | null = null;
  try {
    workerB = new WorkerProc(opts.spawnSpec, spawnFn);
    const { first } = await sendInitialize(workerB);
    if (first.type !== "runtime.ready") {
      skip("malformed-stdin", `worker did not reach ready in malformed session: first frame type=${first.type}`);
    } else {
      try {
        workerB.sendRaw("{not json at all");
      } catch {
        /* 写失败 → 进程多半刚死；nextEvent 会拿到 exit */
      }
      // 首个可观察事件窗口约 2s：帧 / 退出 / 静默三态分流。
      const firstEv = await workerB.nextEvent(Math.min(2000, t));
      if (firstEv.kind === "frame" && firstEv.frame.type === "runtime.error") {
        // (b) 候选：runtime.error 后应 fail-closed exit(非零)。
        await Promise.race([workerB.exited, sleep(t)]);
        const code = workerB.exitCodeSync();
        if (code !== null) {
          if (code !== 0) {
            pass("malformed-stdin", `runtime.error + fail-closed exit code=${code}`);
          } else {
            fail("malformed-stdin", "exited 0 after runtime.error (§6 expects non-zero)");
          }
        } else if (await probeShutdown(workerB)) {
          // 报错但继续服务（容错实现）：shutdown 仍可达即合规。
          pass("malformed-stdin", "runtime.error reported; worker continues (shutdown reachable)");
        } else {
          fail("malformed-stdin", "runtime.error then hang — shutdown unreachable");
        }
      } else if (firstEv.kind === "exit") {
        if (firstEv.code !== 0 && firstEv.code !== null) {
          pass("malformed-stdin", `fail-closed exit code=${firstEv.code} (no runtime.error emitted)`);
        } else {
          fail(
            "malformed-stdin",
            `silent exit(${firstEv.code}) — §6 allows ignore-continue or runtime.error+non-zero exit`,
          );
        }
      } else if (firstEv.kind === "frame") {
        // 其他帧回应：worker 活着——但仍须验证 shutdown 可达。
        if (await probeShutdown(workerB)) {
          pass("malformed-stdin", `responded type=${firstEv.frame.type}; shutdown reachable`);
        } else {
          fail("malformed-stdin", `responded type=${firstEv.frame.type} but shutdown unreachable`);
        }
      } else if (await probeShutdown(workerB)) {
        // (a)：静默忽略坏行且 shutdown 仍可达 → 合规容错。
        pass("malformed-stdin", "bad line ignored; shutdown reachable");
      } else {
        fail("malformed-stdin", "ignored bad line but shutdown unreachable (silent hang)");
      }
    }
  } catch (err) {
    // session B 起不来（spawn/initialize/ready 失败）→ malformed 无法验证 → skip
    if (!checks.some((c) => c.name === "malformed-stdin")) {
      skip("malformed-stdin", `worker did not reach ready in malformed session: ${(err as Error).message}`);
    }
  } finally {
    if (workerB) {
      tailB = workerB.stderrTail();
      workerB.kill();
    }
  }

  return {
    ok: checks.every((c) => c.status !== "fail"),
    checks,
    stderrTail: [tailA, tailB].filter((s) => s !== "").join("\n"),
  };
};
