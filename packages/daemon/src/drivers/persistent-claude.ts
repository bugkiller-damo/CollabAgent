import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { applyAgentEnv } from "../agent-env-whitelist.js";
import { isValidSessionId } from "../agent-sessions.js";
import { asClaudeStreamEvent, type ClaudeStreamEvent } from "../claude-stream.js";
import { getClaudePermissionArgs } from "../command-presets.js";
import { resolveClaudeBinary } from "../command-resolver.js";
import { loadDaemonEnv } from "../config.js";
import { errMessage } from "../errors.js";

// A1.2：Windows 的 .cmd/.bat shim 与裸命令名必须经 shell 启动；已解析到真实
// 可执行文件（或非 Windows）时直接 spawn，避开 cmd.exe 引号转义层（评估 2.4）。
const needsShell = (cmd: string): boolean =>
  process.platform === "win32" && (cmd === "claude" || /\.(cmd|bat)$/i.test(cmd));
function q(s: string): string {
  return /\s/.test(s) ? `"${s}"` : s;
}

/**
 * A2：stream-json 事件的 error 判定（resume 首事件探测用）。
 * 覆盖 `result.is_error` 与任何 `subtype` 含 error 的形态；
 * `system/permission_denied` 之类正常事件不误判。
 */
const isStreamErrorEvent = (ev: ClaudeStreamEvent): boolean => {
  const sub = (ev as { subtype?: unknown }).subtype;
  if (typeof sub === "string" && /error/i.test(sub)) return true;
  return (ev as { is_error?: unknown }).is_error === true;
};

export interface PersistentClaudeOpts {
  cwd: string;
  systemPromptFile?: string;
  env: Record<string, string>;
  label?: string; // 日志用
  /** A1.1：runtime_profile.model（web 端 sonnet/opus/haiku 选择）→ --model */
  model?: string;
  /**
   * A2：会话续接——首次 spawn 时带 `--resume <id>` 的 stream-json session_id
   *（来自 daemon-agent-sessions.json）。进程在 resumeGraceMs 内退出、或首个
   * 流事件为 error → 判 resume 失败：清 id、回调 onResumeFailed（上层清
   * store）、在途回合回队后由全新会话继续（不 reject 给 A1 重试）。
   * spawn 成功后 init 学到的 session_id 会更新内部值，同实例 crash/被杀后的
   * 下一次 spawn 也续接同一会话。
   */
  resumeSessionId?: string;
  /** A2：resume 判失败时回调（参数为被丢弃的 sessionId；上层应 forget store） */
  onResumeFailed?: (sessionId: string) => void;
  /** A2：resume 早退判定窗口（默认 SLOCK_RESUME_GRACE_MS=3000；测试可调小） */
  resumeGraceMs?: number;
  turnTimeoutMs?: number; // 单回合卡死保护（默认 300s，SLOCK_PERSISTENT_TURN_MS 覆盖）
  startupDelayMs?: number; // 启动后等待时间（默认 1s）
  /**
   * B1：每个解析出的 stream-json 事件回调（观察帧数据源）。
   * 回调抛错由 driver 吞掉——观察是旁路，不能影响主链路。
   */
  onStreamEvent?: (ev: ClaudeStreamEvent) => void;
  /**
   * 当前进程退出回调（崩溃 / OOM / 外部 kill）。headless 路径的回合边界靠
   * result 事件，但进程死了就不会有 result——上层靠这个回调把状态机从
   * working 解封（2026-08-18 真机：进程死后状态永久卡 working，STUCK 警告刷屏）。
   *
   * 仅当前进程退出时触发。沉默超时路径自己 settle 回合（dispatch catch 解封
   * 状态机），不走本回调；被替换的旧进程迟到 exit 也不得调用——否则会把新
   * 回合的状态机/进度条一并拆掉（P0.1）。
   */
  onExit?: () => void;
}

// 常驻的交互式 Claude 进程（--input-format stream-json）。
// 进程保持温热，逐条把用户消息写入 stdin，避免每条消息冷启动。串行执行（一回合结束再发下一条）。
interface QueuedTurn {
  text: string;
  resolve: () => void;
  reject: (err: Error) => void;
  /** 回合进入 in-flight 时绑定的进程代次；排队中为 undefined。 */
  gen?: number;
  /** 防止 timeout / error / exit / result 多路径重复 settle。 */
  settled?: boolean;
}

export class PersistentClaude {
  private proc: ChildProcess | null = null;
  /**
   * 当前进程代次。每次 spawn 递增；exit/error/stdout 闭包捕获自己的 gen，
   * 与 this.procGen 不一致即视为已被替换的旧进程（P0.1 kill→exit 竞态）。
   */
  private procGen = 0;
  /**
   * P1.12：当前进程上我们挂的监听。cleanup 必须成对卸掉，否则每次
   * kill/超时都会留下一组闭包（高频率重启时内存累积）。
   * 已入队的 emit 仍可能在 off 之后弹出——isCurrent/gen 守卫继续有效。
   */
  private bound: {
    proc: ChildProcess;
    onStdout: (d: Buffer | string) => void;
    onStderr: (d: Buffer | string) => void;
    onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
    onError: (err: Error) => void;
  } | null = null;
  private busy = false;
  private starting = false;
  /** A2：下次 spawn 要 --resume 的会话 id（init 学到后更新；resume 失败清零） */
  private sessionId: string | undefined;
  /** A2：本次 spawn 实际带上的 --resume id（早退/首事件判定用）；undefined = 全新会话 */
  private spawnResumeId: string | undefined;
  private spawnedAt = 0;
  /** A2：本次 spawn 是否已见首个合法流事件（首事件 error 判定用） */
  private spawnSawEvent = false;
  private spawnResumeLogged = false;
  // 回合级交付（2026-08-18 真机修正）：send() 返回的 Promise 挂在回合上——
  // result 事件 resolve，进程 mid-turn 退出 reject。此前「写入 stdin 即返回」
  // 导致 A1 派发队列的 in-flight 窗口不覆盖真实回合：busy 检测/合并/重试全部
  // 失效，进程被杀后消息被静默吞掉（队列以为早 delivered 了）。
  private queue: QueuedTurn[] = [];
  private activeTurn: QueuedTurn | null = null;
  private buf = "";
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  alive = false;

  constructor(private opts: PersistentClaudeOpts) {
    this.sessionId = opts.resumeSessionId;
  }

  private tag(): string {
    return `[Persistent${this.opts.label ? " " + this.opts.label : ""}]`;
  }

  private isCurrent(proc: ChildProcess, gen: number): boolean {
    return this.proc === proc && this.procGen === gen;
  }

  private settleTurn(turn: QueuedTurn | null | undefined, action: "resolve" | "reject", err?: Error): void {
    if (!turn || turn.settled) return;
    turn.settled = true;
    if (action === "resolve") turn.resolve();
    else turn.reject(err ?? new Error("persistent turn failed"));
  }

  private spawnProc(): boolean {
    const cmd = resolveClaudeBinary();
    // O12：显式工具白名单替代 --dangerously-skip-permissions（见 command-presets.ts）
    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      ...getClaudePermissionArgs(),
    ];
    // A1.1：沿用 agent-runtime-spawn.ts 的保守校验，防注入/坏值。
    const configuredModel = this.opts.model;
    if (configuredModel && /^[a-z0-9._-]+$/i.test(configuredModel)) {
      args.push("--model", configuredModel);
      console.log(`${this.tag()} spawning with --model ${configuredModel}`);
    } else if (configuredModel) {
      console.warn(`${this.tag()} ignoring invalid --model value: ${configuredModel}`);
    }
    // A2：温启动——恢复上次 stream-json 会话（空闲回收 / daemon 重启 / crash
    // 后不走全量失忆冷启动）。SLOCK_SESSION_RESUME=0 关闭（与 PTY 同语义）。
    // id 非法等同 resume 必失败，直接丢弃走全新会话（onResumeFailed 让上层清 store）。
    this.spawnedAt = Date.now();
    this.spawnResumeId = undefined;
    this.spawnSawEvent = false;
    this.spawnResumeLogged = false;
    const resumeId = this.sessionId;
    if (resumeId && loadDaemonEnv().sessionResume) {
      if (isValidSessionId(resumeId)) {
        args.push("--resume", resumeId);
        this.spawnResumeId = resumeId;
        console.log(`${this.tag()} spawning with --resume ${resumeId.slice(0, 8)}`);
      } else {
        console.warn(`${this.tag()} ignoring invalid resume session id: ${resumeId}`);
        this.sessionId = undefined;
        try {
          this.opts.onResumeFailed?.(resumeId);
        } catch {
          /* 上层清理是旁路 */
        }
      }
    }
    if (this.opts.systemPromptFile && existsSync(this.opts.systemPromptFile)) {
      args.push("--append-system-prompt-file", this.opts.systemPromptFile);
    }
    const env = applyAgentEnv(this.opts.env, `Persistent${this.opts.label ? " " + this.opts.label : ""}`);
    this.procGen += 1;
    const gen = this.procGen;
    try {
      this.proc = needsShell(cmd)
        ? spawn([q(cmd), ...args.map(q)].join(" "), {
            cwd: this.opts.cwd,
            shell: true,
            windowsHide: true,
            // A2 / P0.4：默认 whitelist；SLOCK_ENV_INHERIT=1 才全量继承。
            env,
          })
        : spawn(cmd, args, {
            cwd: this.opts.cwd,
            windowsHide: true,
            env,
          });
    } catch (err) {
      console.error(`${this.tag()} spawn error:`, errMessage(err));
      this.proc = null;
      return false;
    }
    const proc = this.proc;
    this.alive = true;
    // 换进程前卸掉上一组（正常路径 cleanup 已卸；这里是防御）。
    this.detachProcListeners();
    // 所有监听都闭包捕获本次 spawn 的 proc/gen：事件可能在 cleanup/kill 之后
    // 才从事件队列弹出（off 拦不住已入队的 emit）。
    const onStdout = (d: Buffer | string) => {
      if (!this.isCurrent(proc, gen)) return;
      this.onStdout(d.toString());
    };
    const onStderr = (d: Buffer | string) => {
      if (!this.isCurrent(proc, gen)) return;
      const t = d.toString().trim();
      if (t) console.error(`${this.tag()} stderr: ${t.slice(0, 160)}`);
    };
    const onExit = (code: number | null, _signal: NodeJS.Signals | null) => this.handleProcExit(proc, gen, code);
    const onError = (err: Error) => this.handleProcError(proc, gen, err);
    proc.stdout?.on("data", onStdout);
    proc.stderr?.on("data", onStderr);
    proc.on("exit", onExit);
    proc.on("error", onError);
    this.bound = { proc, onStdout, onStderr, onExit, onError };
    return true;
  }

  /**
   * P0.1：旧进程迟到的 exit 只结算绑定到该代次的回合，不得：
   * - reject 新进程上的 activeTurn
   * - cleanup 掉新进程
   * - 对仍在跑的新回合触发 onExit（会把状态机打回 idle、拆掉进度条）
   * - pump 打断新回合
   */
  private handleProcExit(proc: ChildProcess, gen: number, code: number | null): void {
    const turnForGen = this.activeTurn?.gen === gen ? this.activeTurn : null;
    if (!this.isCurrent(proc, gen)) {
      if (turnForGen) {
        this.activeTurn = null;
        this.settleTurn(turnForGen, "reject", new Error(`persistent process exited mid-turn (code=${code})`));
      }
      return;
    }
    // A2：带 --resume 的进程在宽限期内、且还没吐出任何合法流事件就退出 =
    // resume 失败（坏/过期 session id，Claude Code 打错误立即退出）。清 id +
    // 在途回合放回队首——随后的 pump 用全新会话重 spawn，用户消息不经 A1 重试
    // 照常送达；上层状态机/守卫/进度条无感（不触发 onExit，否则会把刚 arm 的
    // 回合守卫拆掉）。spawnSawEvent 已亮说明会话确实打开过——那是普通 crash，
    // 保留已学到的 sessionId 让下次 spawn 继续续接。
    const resumeFailed =
      this.spawnResumeId !== undefined && !this.spawnSawEvent && Date.now() - this.spawnedAt < this.resumeGraceMs();
    if (resumeFailed) this.discardFailedResume(`exited within ${this.resumeGraceMs()}ms (code=${code})`);
    const wasBusy = this.busy;
    console.log(
      `${this.tag()} exited code=${code}${wasBusy ? (resumeFailed ? " (mid-turn, requeued after failed resume)" : " (mid-turn, turn rejected for retry)") : ""}`,
    );
    this.activeTurn = null;
    this.cleanup();
    if (resumeFailed) {
      this.requeueTurn(turnForGen);
    } else {
      if (wasBusy || turnForGen) {
        this.settleTurn(turnForGen, "reject", new Error(`persistent process exited mid-turn (code=${code})`));
      }
      try {
        this.opts.onExit?.();
      } catch {
        /* 回调失败不阻断退出处理 */
      }
    }
    this.pump();
  }

  private handleProcError(proc: ChildProcess, gen: number, err: Error): void {
    if (!this.isCurrent(proc, gen)) {
      const turnForGen = this.activeTurn?.gen === gen ? this.activeTurn : null;
      if (turnForGen) {
        this.activeTurn = null;
        this.settleTurn(turnForGen, "reject", err);
      }
      return;
    }
    console.error(`${this.tag()} proc error:`, err.message);
    // 防御「只 error 不 exit」导致回合 Promise 永久挂起。先 cleanup 让随后
    // 的 exit 走 stale 分支，因此本路径必须自己 onExit + pump。
    // A2：resume 宽限期内的 error 视同 resume 失败（同 handleProcExit 早退
    // 路径）；已见合法流事件的按普通 crash 处理，保留 sessionId 续接。
    const resumeFailed =
      this.spawnResumeId !== undefined && !this.spawnSawEvent && Date.now() - this.spawnedAt < this.resumeGraceMs();
    if (resumeFailed) this.discardFailedResume(`proc error: ${err.message}`);
    const turn = this.activeTurn?.gen === gen ? this.activeTurn : null;
    this.activeTurn = null;
    this.cleanup();
    if (resumeFailed) {
      this.requeueTurn(turn);
    } else {
      this.settleTurn(turn, "reject", err);
      try {
        this.opts.onExit?.();
      } catch {
        /* 回调失败不阻断错误处理 */
      }
    }
    this.pump();
  }

  private resumeGraceMs(): number {
    return this.opts.resumeGraceMs ?? loadDaemonEnv().resumeGraceMs;
  }

  /**
   * A2：resume 失败判定收口——清本实例持有的 id 并通知上层清 store；
   * spawnResumeId 清零后下一次 spawnProc 自然落全新会话。
   */
  private discardFailedResume(why: string): void {
    const failed = this.spawnResumeId;
    this.spawnResumeId = undefined;
    if (!failed) return;
    if (this.sessionId === failed) this.sessionId = undefined;
    console.warn(
      `${this.tag()} resume of session ${failed.slice(0, 8)} failed (${why}); continuing with a fresh session`,
    );
    try {
      this.opts.onResumeFailed?.(failed);
    } catch {
      /* 上层清理是旁路 */
    }
  }

  /** A2：resume 失败时在途回合不放逐——放回队首，由 fresh spawn 继续送达。 */
  private requeueTurn(turn: QueuedTurn | null): void {
    if (turn && !turn.settled) this.queue.unshift(turn);
  }

  /** P1.12：卸掉当前进程上我们挂的监听。已入队 emit 仍靠 isCurrent/gen 忽略。 */
  private detachProcListeners(): void {
    const b = this.bound;
    if (!b) return;
    this.bound = null;
    b.proc.stdout?.off("data", b.onStdout);
    b.proc.stderr?.off("data", b.onStderr);
    b.proc.off("exit", b.onExit);
    b.proc.off("error", b.onError);
  }

  private cleanup() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    this.detachProcListeners();
    this.proc = null;
    this.alive = false;
    this.busy = false;
    this.starting = false;
    this.buf = "";
  }

  // 入队一条用户消息（串行执行）。返回回合级 Promise：
  // result 事件 → resolve；进程 mid-turn 退出 / spawn 失败 → reject（供 A1 队列重试）。
  send(userText: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ text: userText, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this.busy || this.starting) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    if (!this.proc || !this.alive) {
      if (!this.spawnProc()) {
        console.error(`${this.tag()} cannot spawn, rejecting turn`);
        this.settleTurn(next, "reject", new Error("cannot spawn persistent claude process"));
        return;
      }
      this.starting = true;
      this.queue.unshift(next); // 放回队列，启动就绪后重试
      if (this.startupTimer) clearTimeout(this.startupTimer);
      this.startupTimer = setTimeout(() => {
        this.startupTimer = null;
        this.starting = false;
        this.pump();
      }, this.opts.startupDelayMs ?? 1000);
      return;
    }
    const stdin = this.proc?.stdin;
    if (!stdin) {
      console.error(`${this.tag()} no stdin`);
      this.settleTurn(next, "reject", new Error("persistent process has no stdin"));
      return;
    }
    this.busy = true;
    next.gen = this.procGen;
    this.activeTurn = next;
    const payload = JSON.stringify({ type: "user", message: { role: "user", content: next.text } }) + "\n";
    stdin.write(payload);
    this.armTurnTimer();
  }

  /**
   * 不活跃超时（卡死保护）：默认 300s（SLOCK_PERSISTENT_TURN_MS 覆盖），
   * **每个 stream-json 事件到达都会重置**——语义是「沉默超时」而非「回合绝对
   // 时长上限」。理由（2026-08-18 真机两轮测试）：
   * - 绝对时长两头不讨好：正常多工具回合超阈值被误杀（第一轮 60s 的教训），
   *   而 curl 无 --max-time 挂死又要等满整个阈值才恢复（第二轮实测）。
   * - stream-json verbose 模式下干活的 agent 几乎持续有事件（assistant block /
   *   tool_result / result），沉默 N 秒 ≈ 工具调用挂死，是强卡死信号。
   * - Claude Code 2.1.274 在长 Bash 工具执行中约每 30s 发一次 `tool_progress`
   *   JSON 心跳（40s Bash 实测）；重置发生在 `asClaudeStreamEvent` 收窄之前，
   *   这类未知心跳类型同样能续命回合，300s 默认不变。
   * 已知边界：单个超大 thinking block 若超过阈值无输出会被误杀——真遇到了
   * 调大 SLOCK_PERSISTENT_TURN_MS，不要改回绝对时长。
   *
   * P0.1：超时只负责 settle 当前回合 + cleanup + kill。后续 pump 可以立刻换
   * 新进程；旧进程迟到的 exit/error/stdout 凭 gen 校验全部忽略。
   * 不在这里调 onExit——send() reject 后由 dispatch catch 解封状态机；若此时
   * 已有新回合 in-flight，onExit 会误伤它。
   */
  private armTurnTimer(): void {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    const timeout = this.opts.turnTimeoutMs ?? loadDaemonEnv().persistentTurnMs;
    const turn = this.activeTurn;
    const gen = this.procGen;
    this.turnTimer = setTimeout(() => {
      // 过期回调可能在 clearTimeout 之前已入队；必须仍是「同一回合 + 同一进程代次」。
      // 只比 gen 不够：同进程上下一回合也会绑同一个 gen。
      if (this.procGen !== gen || this.activeTurn !== turn) return;
      console.warn(`${this.tag()} no stream events for ${timeout / 1000}s mid-turn, killing process`);
      const proc = this.proc;
      this.activeTurn = null;
      this.settleTurn(turn, "reject", new Error("persistent process exited mid-turn (silence-timeout)"));
      // 先 cleanup（this.proc=null）再 kill：同步/同 tick 的 exit 走 stale 分支，
      // 不会 onExit / 不会误伤随后 pump 出来的新回合。
      this.cleanup();
      try {
        proc?.kill();
      } catch {
        /* ignore */
      }
      this.pump();
    }, timeout);
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    // 防无换行异常输出无限增长，最多保留尾部 1MB
    const MAX_BUF = 1024 * 1024;
    if (this.buf.length > MAX_BUF) {
      console.warn(`${this.tag()} stdout buffer >1MB, truncating`);
      this.buf = this.buf.slice(-MAX_BUF);
    }
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        // 不活跃超时续命：回合进行中任何合法 JSON 行都重置计时（见 armTurnTimer 注释）。
        // 重置刻意发生在 asClaudeStreamEvent 收窄之前——Claude Code 2.1.274 的
        // `tool_progress` 心跳（长 Bash 约 30s 一次）不在已知联合内，若先收窄
        // 再重置，长工具会被误判沉默而误杀。
        if (this.busy) this.armTurnTimer();
        const ev = asClaudeStreamEvent(parsed);
        if (ev) {
          // A2：resume 的进程首个流事件就是 error = 会话没打开（坏 --resume 的
          // 另一种失败形态，与「宽限期内退出」等价）。清 id、杀进程、在途回合
          // 回队——pump 换全新会话。该 error 事件不上抛：尤其 result 形 error
          // 会被当成回合边界误 resolve 在途回合。
          if (this.spawnResumeId && !this.spawnSawEvent && isStreamErrorEvent(ev)) {
            this.discardFailedResume("first stream event is an error");
            const turn = this.activeTurn;
            this.activeTurn = null;
            const proc = this.proc;
            this.cleanup();
            this.requeueTurn(turn);
            try {
              proc?.kill();
            } catch {
              /* ignore */
            }
            this.pump();
            return;
          }
          this.spawnSawEvent = true;
          // A2：学到本进程 session_id——之后若进程被杀（沉默超时 / crash），
          // 下一次 spawnProc 用 --resume 接回同一会话，不丢记忆。
          if (ev.type === "system" && typeof ev.session_id === "string" && ev.session_id) {
            // 每个 system 事件都带 session_id——确认日志只在首个 system 事件打一次。
            // 注意不能用 !this.sessionId 判首次：resume 合法时 sessionId 仍持有目标 id。
            if (this.spawnResumeId && !this.spawnResumeLogged) {
              this.spawnResumeLogged = true;
              if (ev.session_id === this.spawnResumeId) {
                console.log(`${this.tag()} resumed session ${ev.session_id.slice(0, 8)}`);
              } else {
                console.warn(
                  `${this.tag()} resume produced new session ${ev.session_id.slice(0, 8)} (expected ${this.spawnResumeId.slice(0, 8)})`,
                );
              }
            }
            this.sessionId = ev.session_id;
          }
          if (this.opts.onStreamEvent) {
            try {
              this.opts.onStreamEvent(ev);
            } catch {
              /* 观察旁路抛错不影响主链路 */
            }
          }
        }
        if (ev?.type === "result") {
          // 一个用户回合结束——resolve 回合 Promise（A1 队列的 in-flight 至此完结）
          if (this.turnTimer) {
            clearTimeout(this.turnTimer);
            this.turnTimer = null;
          }
          const turn = this.activeTurn;
          this.activeTurn = null;
          this.busy = false;
          this.settleTurn(turn, "resolve");
          this.pump();
        }
      } catch {
        /* 非 JSON 行忽略 */
      }
    }
  }

  stop(): void {
    const proc = this.proc;
    const err = new Error("persistent session stopped");
    this.settleTurn(this.activeTurn, "reject", err);
    this.activeTurn = null;
    for (const t of this.queue) this.settleTurn(t, "reject", err);
    this.queue = [];
    this.cleanup();
    try {
      proc?.kill();
    } catch {
      /* ignore */
    }
  }
}
