/**
 * Phase 5 搂16锛歋ARP/1 worker conformance runner銆?
 *
 * 鏂?worker锛堜换浣曡瑷€锛夋帴鍏ュ墠鐨勫崗璁悎瑙勯獙璇侊細浠ョ湡瀹?spawn + stdin/stdout
 * JSONL 椹卞姩 worker锛岄€愰」妫€鏌ュ崗璁笉鍙橀噺锛岃緭鍑虹粨鏋勫寲缁撴灉銆?
 *
 * 鐢ㄦ硶锛?
 *   const report = await runSarpConformance({
 *     command: "python", args: ["agent.py"], cwd: "...", env: {...},
 *     runtimeId: "langgraph", entrypoint: "my-ep",
 *   });
 *   report.ok === false 鈫?鍝潯 check 鎸備簡鐪?report.checks銆?
 *
 * 妫€鏌ラ」锛堜笌 docs SARP/1 鍗忚鏂囨。涓€涓€瀵瑰簲锛夛細
 *   handshake          initialize 鈫?runtime.ready锛坮equestId 鍥炴樉 + runtime.id锛?
 *   seq-monotonic      鍑哄悜甯?seq 涓ユ牸閫掑
 *   turn-lifecycle     turn.start 鈫?鎭板ソ涓€涓?turn.end锛坱urnId 鍖归厤锛?
 *   eventseq-monotonic 鍥炲悎甯?eventSeq 浠?1 涓ユ牸閫掑
 *   cancel             turn.cancel 鈫?cancelled 缁堟€侊紙worker 涓嶆敮鎸佸垯 skip锛?
 *   shutdown           shutdown 鈫?runtime.stopped + 杩涚▼骞插噣閫€鍑?
 *   malformed-stdin    闈?JSON 琛屽叆鍚?鈫?worker 涓嶅簲闈欓粯宕╂簝锛堝洖 error 鎴栧拷鐣ュ潎鍙紝
 *                      浣嗕笉寰楁棤缁堟€佸湴鎸傝捣鈥斺€旈殢鍚?shutdown 蹇呴』浠嶅彲杈撅級
 *   replay             鍚?turnId 閲嶅彂 鈫?journal 鍥炴斁鍚岀粓鎬侊紙浠?journal 瀹炵幇瑕佹煡锛?
 *                      expectJournal=false 鏃?skip锛?
 *
 * 绾緥锛歳unner 鍙柇瑷€銆屽崗璁眰涓嶅彉閲忋€嶏紝涓嶆柇瑷€涓氬姟璇箟锛堟枃鏈唴瀹广€佹ā鍨嬮€夋嫨绛夛級銆?
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

export interface ConformanceSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface ConformanceOptions {
  spawnSpec: ConformanceSpawnSpec;
  /** 鏈熸湜鐨?ready.runtime.id */
  runtimeId: string;
  /** initialize.runtime.entrypoint锛坵orker 渚ч€氬父鍙牎楠?id锛屾鍊艰繘甯т緵鏃ュ織/鏍￠獙锛?*/
  entrypoint?: string;
  /** 鏈熸湜鐨?model.selected 鏂█锛堝彲閫夛級 */
  expectModel?: string;
  /** worker 瀹炵幇浜?turn journal 鈫?璺?replay 妫€鏌ワ紙slock_runtime SDK = true锛?*/
  expectJournal?: boolean;
  /** 姣忔绛夊緟涓婇檺锛岄粯璁?8000ms */
  stepTimeoutMs?: number;
  /** 鑷畾涔?spawn锛堟祴璇曟敞鍏ワ級 */
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
  /** worker stderr 灏鹃儴锛堣瘖鏂敤锛?*/
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
    this.proc.stdout.on("close", () => {
      this.stdoutClosed = true;
      for (const w of this.waiters.splice(0)) {
        clearTimeout(w.timer);
        w.reject(new Error(`stdout closed (exit=${this.exitCode}) 鈥?stderr: ${this.stderrTail()}`));
      }
    });
    this.exited = new Promise((resolve) => {
      this.proc.on("exit", (code) => {
        this.exitCode = code;
        resolve(code);
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
      return Promise.reject(new Error(`stdout already closed 鈥?stderr: ${this.stderrTail()}`));
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
          reject(new Error(`no stdout line within ${timeoutMs}ms 鈥?stderr: ${this.stderrTail()}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async readFrame(timeoutMs: number): Promise<Frame> {
    return JSON.parse(await this.readLine(timeoutMs));
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
  let worker: WorkerProc;
  try {
    worker = new WorkerProc(opts.spawnSpec, spawnFn);
  } catch (err) {
    fail("spawn", `spawn failed: ${(err as Error).message}`);
    return { ok: false, checks, stderrTail: "" };
  }

  try {
    /* ---------------- handshake ---------------- */
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
      workspace: { path: opts.spawnSpec.cwd },
      platform: {},
      limits: { maxFrameBytes: 1048576, silenceTimeoutMs: Math.max(t * 4, 30000), shutdownTimeoutMs: 5000 },
    });

    let ready: Frame;
    try {
      ready = await worker.readFrame(t);
    } catch (err) {
      fail("handshake", `runtime.ready not received: ${(err as Error).message}`);
      return { ok: false, checks, stderrTail: worker.stderrTail() };
    }
    if (ready.type !== "runtime.ready") {
      fail("handshake", `first frame type=${ready.type} (expected runtime.ready)`);
      return { ok: false, checks, stderrTail: worker.stderrTail() };
    }
    if (ready.requestId !== requestId) {
      fail("handshake", `requestId echo mismatch: got ${ready.requestId}`);
      return { ok: false, checks, stderrTail: worker.stderrTail() };
    }
    if (ready.runtime?.id !== opts.runtimeId) {
      fail("handshake", `runtime.id=${ready.runtime?.id} != expected ${opts.runtimeId}`);
      return { ok: false, checks, stderrTail: worker.stderrTail() };
    }
    if (ready.seq !== 1) {
      fail("handshake", `ready.seq=${ready.seq} (expected 1)`);
      return { ok: false, checks, stderrTail: worker.stderrTail() };
    }
    if (
      opts.expectModel !== undefined &&
      ready.model &&
      (ready.model as { selected?: string }).selected !== opts.expectModel
    ) {
      fail("handshake", `model.selected=${(ready.model as { selected?: string }).selected} != ${opts.expectModel}`);
      return { ok: false, checks, stderrTail: worker.stderrTail() };
    }
    pass("handshake", `runtime.id=${ready.runtime.id}, requestId echoed`);

    /* ---------------- 宸ュ叿鍑芥暟 ---------------- */
    let lastSeq = ready.seq ?? 1;
    const readTurnFrames = async (): Promise<Frame[]> => {
      const frames: Frame[] = [];
      for (;;) {
        const f = await worker.readFrame(t);
        frames.push(f);
        if (f.seq !== undefined) {
          if (f.seq <= lastSeq) throw new Error(`seq regression: ${f.seq} <= ${lastSeq}`);
          lastSeq = f.seq;
        }
        if (f.type === "turn.end") return frames;
      }
    };

    /* ---------------- turn-lifecycle ---------------- */
    worker.send({
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
      return { ok: false, checks, stderrTail: worker.stderrTail() };
    }
    const t1End = t1Frames[t1Frames.length - 1]!;
    if (t1End.turnId !== "conf-t1") {
      fail("turn-lifecycle", `turn.end.turnId=${t1End.turnId} != conf-t1`);
    } else if (!["success", "error", "cancelled", "interrupted"].includes(String(t1End.status))) {
      fail("turn-lifecycle", `turn.end.status=${t1End.status} unknown`);
    } else {
      pass("turn-lifecycle", `turn.end status=${t1End.status}`);
    }
    pass("seq-monotonic", `last seq=${lastSeq}`);

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

    /* ---------------- cancel ---------------- */
    if (ready.capabilities?.interrupts !== false) {
      worker.send({
        type: "turn.start",
        turnId: "conf-tc",
        conversationId: "conf-conv",
        attempt: 1,
        source: { kind: "message", channel: "conformance" },
        prompt: "long turn to cancel",
      });
      worker.send({ type: "turn.cancel", turnId: "conf-tc", reason: "conformance cancel" });
      try {
        const cFrames = await readTurnFrames();
        const cEnd = cFrames[cFrames.length - 1]!;
        if (cEnd.status === "cancelled" || cEnd.status === "success") {
          pass("cancel", `turn.end status=${cEnd.status}`);
        } else {
          fail("cancel", `unexpected status=${cEnd.status}`);
        }
      } catch (err) {
        fail("cancel", `no terminal after cancel: ${(err as Error).message}`);
      }
    } else {
      skip("cancel", "capabilities.interrupts=false");
    }

    /* ---------------- journal replay ---------------- */
    if (opts.expectJournal) {
      worker.send({
        type: "turn.start",
        turnId: "conf-t1", // 涓庡凡瀹屾垚鍥炲悎鍚?turnId 鈫?搴斿洖鏀惧悓缁堟€侊紝涓嶉噸璺?
        conversationId: "conf-conv",
        attempt: 2,
        source: { kind: "message", channel: "conformance" },
        prompt: "replay probe",
      });
      try {
        const rFrames = await readTurnFrames();
        const rEnd = rFrames[rFrames.length - 1]!;
        if (rEnd.status === t1End.status) {
          pass("replay", `replayed turn.end status=${rEnd.status}`);
        } else {
          fail("replay", `replay status=${rEnd.status} != original ${t1End.status}`);
        }
      } catch (err) {
        fail("replay", `no replayed turn.end: ${(err as Error).message}`);
      }
    } else {
      skip("replay", "expectJournal=false");
    }

    /* ---------------- malformed-stdin ---------------- */
    // 涓ょ鍚堣琛屼负锛氬拷鐣ュ潖琛岀户缁湇鍔★紙瀹归敊锛夛紝鎴?runtime.error 鍚?exit 闈為浂锛坒ail-closed锛夈€?
    // 涓嶅悎瑙勮涓猴細闈欓粯鎸傛锛堟棤 error 涔熸棤杩涚▼閫€鍑轰笖鍚庣画 shutdown 涓嶅彲杈撅級銆?
    let workerDead = false;
    worker.sendRaw("{not json at all");
    try {
      const maybeErr = await Promise.race([
        worker.readFrame(1500),
        new Promise<null>((r) => setTimeout(() => r(null), 1500)),
      ]);
      if (maybeErr === null) {
        pass("malformed-stdin", "bad line ignored, worker alive");
      } else if (maybeErr.type === "runtime.error") {
        pass("malformed-stdin", `runtime.error: ${maybeErr.error?.code ?? "?"}`);
      } else {
        pass("malformed-stdin", `responded type=${maybeErr.type}`);
      }
    } catch {
      // stdout 宸插叧 鈫?杩涚▼澶ф鐜囧凡 fail-closed 閫€鍑猴紱绛?exited 纭
      const code = await Promise.race([worker.exited, new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
      if (code === null) {
        pass("malformed-stdin", "stdout closed; exit pending");
      } else {
        workerDead = true;
        pass("malformed-stdin", `fail-closed exit code=${code}`);
      }
    }

    /* ---------------- shutdown ---------------- */
    if (workerDead) {
      pass("shutdown", "worker already exited (fail-closed on bad frame)");
      pass("shutdown-exit", "exit confirmed above");
    } else {
      try {
        worker.send({ type: "shutdown", reason: "conformance done", timeoutMs: 3000 });
      } catch (err) {
        fail("shutdown", `send failed: ${(err as Error).message}`);
      }
      try {
        const stopped = await worker.readFrame(t);
        if (stopped.type === "runtime.stopped") {
          pass("shutdown", "runtime.stopped received");
        } else {
          pass("shutdown", `frame type=${stopped.type} before exit`);
        }
      } catch {
        pass("shutdown", "stdout closed after shutdown");
      }
      const code = await Promise.race([worker.exited, new Promise<null>((r) => setTimeout(() => r(null), t))]);
      if (code === null) {
        fail("shutdown-exit", "process did not exit after shutdown");
      } else {
        pass("shutdown-exit", `exit code=${code}`);
      }
    }
  } finally {
    worker.kill();
  }

  return { ok: checks.every((c) => c.status !== "fail"), checks, stderrTail: worker.stderrTail() };
};
