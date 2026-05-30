import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// 复用 claude-print 的命令查找逻辑
function findClaudeCmd(): string {
  const appData = process.env.APPDATA || join("C:/Users", process.env.USERNAME || "Default", "AppData/Roaming");
  const candidates = [join(appData, "npm", "claude.cmd"), "C:/Program Files/Claude Code/claude.cmd", "claude.cmd"];
  for (const c of candidates) if (existsSync(c)) return c;
  return "claude.cmd";
}
function q(s: string): string { return /\s/.test(s) ? `"${s}"` : s; }

export interface PersistentClaudeOpts {
  cwd: string;
  systemPromptFile?: string;
  env: Record<string, string>;
  label?: string;        // 日志用
  turnTimeoutMs?: number; // 单回合卡死保护
}

// 常驻的交互式 Claude 进程（--input-format stream-json）。
// 进程保持温热，逐条把用户消息写入 stdin，避免每条消息冷启动。串行执行（一回合结束再发下一条）。
export class PersistentClaude {
  private proc: ChildProcess | null = null;
  private busy = false;
  private queue: string[] = [];
  private buf = "";
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  alive = false;

  constructor(private opts: PersistentClaudeOpts) {}

  private spawnProc(): boolean {
    const cmd = findClaudeCmd();
    const args = [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose", "--dangerously-skip-permissions",
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
        env: { ...process.env, ...this.opts.env },
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
      console.log(`[Persistent${this.opts.label ? " " + this.opts.label : ""}] exited code=${code}`);
      this.cleanup();
    });
    this.proc.on("error", (err) => {
      console.error(`[Persistent${this.opts.label ? " " + this.opts.label : ""}] proc error:`, err.message);
      this.cleanup();
    });
    return true;
  }

  private cleanup() {
    if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; }
    this.proc = null;
    this.alive = false;
    this.busy = false;
  }

  // 入队一条用户消息（线程安全的串行执行）
  send(userText: string): void {
    this.queue.push(userText);
    this.pump();
  }

  private pump(): void {
    if (this.busy) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    if (!this.proc || !this.alive) {
      if (!this.spawnProc()) { console.error(`[Persistent${this.opts.label ? " " + this.opts.label : ""}] cannot spawn, dropping turn`); return; }
    }
    const stdin = this.proc?.stdin;
    if (!stdin) { console.error(`[Persistent${this.opts.label ? " " + this.opts.label : ""}] no stdin`); return; }
    this.busy = true;
    const payload = JSON.stringify({ type: "user", message: { role: "user", content: next } }) + "\n";
    stdin.write(payload);
    // 卡死保护：超时则结束本回合，继续后续
    const timeout = this.opts.turnTimeoutMs ?? 180000;
    this.turnTimer = setTimeout(() => {
      console.warn(`[Persistent${this.opts.label ? " " + this.opts.label : ""}] turn timeout, moving on`);
      this.busy = false;
      this.pump();
    }, timeout);
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "result") {
          // 一个用户回合结束
          if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; }
          this.busy = false;
          this.pump();
        }
      } catch { /* 非 JSON 行忽略 */ }
    }
  }

  stop(): void {
    try { this.proc?.kill(); } catch { /* ignore */ }
    this.cleanup();
    this.queue = [];
  }
}
