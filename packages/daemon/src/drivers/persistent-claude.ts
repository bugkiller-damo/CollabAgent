import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { applyAgentEnv } from "../agent-env-whitelist.js";
import { getClaudePermissionArgs } from "../command-presets.js";

// 复用 claude-print 的命令查找逻辑
function findClaudeCmd(): string {
  const appData = process.env.APPDATA || join("C:/Users", process.env.USERNAME || "Default", "AppData/Roaming");
  const candidates = [join(appData, "npm", "claude.cmd"), "C:/Program Files/Claude Code/claude.cmd", "claude.cmd"];
  for (const c of candidates) if (existsSync(c)) return c;
  return "claude.cmd";
}
function q(s: string): string {
  return /\s/.test(s) ? `"${s}"` : s;
}

export interface PersistentClaudeOpts {
  cwd: string;
  systemPromptFile?: string;
  env: Record<string, string>;
  label?: string; // 日志用
  turnTimeoutMs?: number; // 单回合卡死保护（默认 300s，SLOCK_PERSISTENT_TURN_MS 覆盖）
  startupDelayMs?: number; // 启动后等待时间（默认 1s）
  /**
   * B1：每个解析出的 stream-json 事件回调（观察帧数据源）。
   * 回调抛错由 driver 吞掉——观察是旁路，不能影响主链路。
   */
  onStreamEvent?: (ev: any) => void;
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
  private busy = false;
  private starting = false;
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

  constructor(private opts: PersistentClaudeOpts) {}

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
    const cmd = findClaudeCmd();
    // O12：显式工具白名单替代 --dangerously-skip-permissions（见 command-presets.ts）
    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      ...getClaudePermissionArgs(),
    ];
    if (this.opts.systemPromptFile && existsSync(this.opts.systemPromptFile)) {
      args.push("--append-system-prompt-file", this.opts.systemPromptFile);
    }
    const fullCmd = [q(cmd), ...args.map(q)].join(" ");
    this.procGen += 1;
    const gen = this.procGen;
    try {
      this.proc = spawn(fullCmd, {
        cwd: this.opts.cwd,
        shell: true,
        windowsHide: true,
        // A2 / P0.4：默认 whitelist；SLOCK_ENV_INHERIT=1 才全量继承。
        env: applyAgentEnv(this.opts.env, `Persistent${this.opts.label ? " " + this.opts.label : ""}`),
      });
    } catch (err: any) {
      console.error(`${this.tag()} spawn error:`, err?.message);
      this.proc = null;
      return false;
    }
    const proc = this.proc;
    this.alive = true;
    // 所有监听都闭包捕获本次 spawn 的 proc/gen：事件可能在 cleanup/kill 之后
    // 才从事件队列弹出（removeAllListeners 拦不住已入队的 emit）。
    proc.stdout?.on("data", (d) => {
      if (!this.isCurrent(proc, gen)) return;
      this.onStdout(d.toString());
    });
    proc.stderr?.on("data", (d) => {
      if (!this.isCurrent(proc, gen)) return;
      const t = d.toString().trim();
      if (t) console.error(`${this.tag()} stderr: ${t.slice(0, 160)}`);
    });
    proc.on("exit", (code) => this.handleProcExit(proc, gen, code));
    proc.on("error", (err) => this.handleProcError(proc, gen, err));
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
    const wasBusy = this.busy;
    console.log(`${this.tag()} exited code=${code}${wasBusy ? " (mid-turn, turn rejected for retry)" : ""}`);
    this.activeTurn = null;
    this.cleanup();
    if (wasBusy || turnForGen) {
      this.settleTurn(turnForGen, "reject", new Error(`persistent process exited mid-turn (code=${code})`));
    }
    try {
      this.opts.onExit?.();
    } catch {
      /* 回调失败不阻断退出处理 */
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
    const turn = this.activeTurn?.gen === gen ? this.activeTurn : null;
    this.activeTurn = null;
    this.settleTurn(turn, "reject", err);
    this.cleanup();
    try {
      this.opts.onExit?.();
    } catch {
      /* 回调失败不阻断错误处理 */
    }
    this.pump();
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
    const envTimeout = Number(process.env.SLOCK_PERSISTENT_TURN_MS);
    const timeout = this.opts.turnTimeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 300000);
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
        const ev = JSON.parse(line);
        // 不活跃超时续命：回合进行中任何事件到达都重置计时（见 armTurnTimer 注释）
        if (this.busy) this.armTurnTimer();
        if (this.opts.onStreamEvent) {
          try {
            this.opts.onStreamEvent(ev);
          } catch {
            /* 观察旁路抛错不影响主链路 */
          }
        }
        if (ev.type === "result") {
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
