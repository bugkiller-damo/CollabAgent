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
   * 进程退出回调（含 turn timeout 主动 kill）。headless 路径的回合边界靠
   * result 事件，但进程死了就不会有 result——上层靠这个回调把状态机从
   // working 解封（2026-08-18 真机：turn timeout 杀进程后状态永久卡 working，
   // STUCK 警告刷屏、画面冻结）。
   */
  onExit?: () => void;
}

// 常驻的交互式 Claude 进程（--input-format stream-json）。
// 进程保持温热，逐条把用户消息写入 stdin，避免每条消息冷启动。串行执行（一回合结束再发下一条）。
interface QueuedTurn {
  text: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

export class PersistentClaude {
  private proc: ChildProcess | null = null;
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
  alive = false;

  constructor(private opts: PersistentClaudeOpts) {}

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
    try {
      this.proc = spawn(fullCmd, {
        cwd: this.opts.cwd,
        shell: true,
        windowsHide: true,
        // A2：env 白名单化（默认 warn-only，SLOCK_ENV_WHITELIST=1 收紧），
        // 见 agent-env-whitelist.ts
        env: applyAgentEnv(this.opts.env, `Persistent${this.opts.label ? " " + this.opts.label : ""}`),
      });
    } catch (err: any) {
      console.error(`[Persistent${this.opts.label ? " " + this.opts.label : ""}] spawn error:`, err?.message);
      this.proc = null;
      return false;
    }
    this.alive = true;
    this.proc.stdout?.on("data", (d) => this.onStdout(d.toString()));
    this.proc.stderr?.on("data", (d) => {
      const t = d.toString().trim();
      if (t) console.error(`[Persistent${this.opts.label ? " " + this.opts.label : ""}] stderr: ${t.slice(0, 160)}`);
    });
    this.proc.on("exit", (code) => {
      // busy=true 时退出 = 回合中途死亡（turn timeout kill / 崩溃 / OOM），
      // reject 活跃回合的 Promise——A1 派发队列据此退避重试（换 fresh 会话
      // 重投这条消息），不再静默吞消息。
      const wasBusy = this.busy;
      console.log(
        `[Persistent${this.opts.label ? " " + this.opts.label : ""}] exited code=${code}${wasBusy ? " (mid-turn, turn rejected for retry)" : ""}`,
      );
      const turn = this.activeTurn;
      this.activeTurn = null;
      this.cleanup();
      turn?.reject(new Error(`persistent process exited mid-turn (code=${code})`));
      try {
        this.opts.onExit?.();
      } catch {
        /* 回调失败不阻断退出处理 */
      }
      // 队列里还有消息则继续排空（会触发重新 spawn）
      this.pump();
    });
    this.proc.on("error", (err) => {
      console.error(`[Persistent${this.opts.label ? " " + this.opts.label : ""}] proc error:`, err.message);
      // error 后通常紧跟 exit（由 exit 统一 reject）；防御「只 error 不 exit」
      // 导致回合 Promise 永久挂起
      const turn = this.activeTurn;
      this.activeTurn = null;
      turn?.reject(err);
      this.cleanup();
    });
    return true;
  }

  private cleanup() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    this.proc = null;
    this.alive = false;
    this.busy = false;
    this.starting = false;
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
        console.error(`[Persistent${this.opts.label ? " " + this.opts.label : ""}] cannot spawn, rejecting turn`);
        next.reject(new Error("cannot spawn persistent claude process"));
        return;
      }
      this.starting = true;
      this.queue.unshift(next); // 放回队列，启动就绪后重试
      setTimeout(() => {
        this.starting = false;
        this.pump();
      }, this.opts.startupDelayMs ?? 1000);
      return;
    }
    const stdin = this.proc?.stdin;
    if (!stdin) {
      console.error(`[Persistent${this.opts.label ? " " + this.opts.label : ""}] no stdin`);
      next.reject(new Error("persistent process has no stdin"));
      return;
    }
    this.busy = true;
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
   */
  private armTurnTimer(): void {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    const envTimeout = Number(process.env.SLOCK_PERSISTENT_TURN_MS);
    const timeout = this.opts.turnTimeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 300000);
    this.turnTimer = setTimeout(() => {
      console.warn(
        `[Persistent${this.opts.label ? " " + this.opts.label : ""}] no stream events for ${timeout / 1000}s mid-turn, killing process`,
      );
      try {
        this.proc?.kill();
      } catch {
        /* ignore */
      }
      this.cleanup();
      this.pump();
    }, timeout);
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    // 防无换行异常输出无限增长，最多保留尾部 1MB
    const MAX_BUF = 1024 * 1024;
    if (this.buf.length > MAX_BUF) {
      console.warn(`[Persistent${this.opts.label ? " " + this.opts.label : ""}] stdout buffer >1MB, truncating`);
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
          turn?.resolve();
          this.pump();
        }
      } catch {
        /* 非 JSON 行忽略 */
      }
    }
  }

  stop(): void {
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    // 显式停止：活跃回合 + 排队消息全部 reject（调用方拿到明确的失败，不挂起）
    const err = new Error("persistent session stopped");
    this.activeTurn?.reject(err);
    this.activeTurn = null;
    for (const t of this.queue) t.reject(err);
    this.cleanup();
    this.queue = [];
  }
}
