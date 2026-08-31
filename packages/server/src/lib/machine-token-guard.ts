// 评估报告 P1.14：sk_machine_ 令牌校验的 bcrypt 兼容路径（HTTP index.ts / WS
// ws/handler.ts 两处）此前「无熔断」——任何未知 sk_machine_ token 都会触发
// 全表拉取 + 逐行 bcrypt.compare（12 轮），无效 token 可稳定打出 O(N×12) CPU，
// 是 DoS 放大面。本文件给该路径加进程级护栏：
//
// 1. per-IP 固定窗口速率限制：同 IP 每窗口最多进入该路径 RATE_MAX 次
//    （默认 20/min）——合法存量 bcrypt 令牌的 daemon 重连/请求远低于此；
//    攻击者即使无凭据也只能按预算烧 CPU，超限直接拒绝（HTTP 429 / WS 4001），
//    不再触达 DB 与 bcrypt。
// 2. 全局并发信号量：最多 MAX_CONCURRENT 个扫描+比对同时在跑（默认 2），
//    超出进有界队列（QUEUE_LIMIT）等待，排队超时（QUEUE_TIMEOUT_MS）即拒绝
//    ——防止并发请求把长耗时比对堆叠放大尾延迟。
//
// 语义与既有组件对齐：速率/并发均为进程内实现（多实例各算各的预算，与
// metrics.ts 计数器同口径）；护栏内部故障 fail-open（与 login-lock/rate-limit
// 一致，且全局限流 hook 仍在兜底）。P1.15 抽 lib/auth-token.ts 收敛校验时一并迁入。

export type BcryptGuardVerdict = "allowed" | "rate_limited" | "busy";

/** 同一 IP 每窗口最多进入兼容路径的次数（合法存量令牌重连远低于此） */
export const BCRYPT_PATH_RATE_MAX = 20;
/** 速率窗口（毫秒） */
export const BCRYPT_PATH_RATE_WINDOW_MS = 60_000;
/** 同时在跑的「全表扫描 + 逐行 bcrypt」上限（bcryptjs 单进程 CPU 密集） */
export const BCRYPT_PATH_MAX_CONCURRENT = 2;
/** 并发打满时的排队上限；队列满立即拒绝 */
export const BCRYPT_PATH_QUEUE_LIMIT = 16;
/** 排队等待超时；超时按 busy 拒绝 */
export const BCRYPT_PATH_QUEUE_TIMEOUT_MS = 3_000;

interface GuardOptions {
  rateMax?: number;
  windowMs?: number;
  maxConcurrent?: number;
  queueLimit?: number;
  queueTimeoutMs?: number;
}

interface Waiter {
  done: boolean;
  resolve: (granted: boolean) => void;
  timer: NodeJS.Timeout;
}

export class MachineTokenBcryptGuard {
  private readonly rateMax: number;
  private readonly windowMs: number;
  private readonly maxConcurrent: number;
  private readonly queueLimit: number;
  private readonly queueTimeoutMs: number;

  /** 固定窗口速率计数：ip -> { count, resetAt } */
  private rate = new Map<string, { count: number; resetAt: number }>();
  private active = 0;
  private waiters: Waiter[] = [];
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(opts: GuardOptions = {}) {
    this.rateMax = opts.rateMax ?? BCRYPT_PATH_RATE_MAX;
    this.windowMs = opts.windowMs ?? BCRYPT_PATH_RATE_WINDOW_MS;
    this.maxConcurrent = opts.maxConcurrent ?? BCRYPT_PATH_MAX_CONCURRENT;
    this.queueLimit = opts.queueLimit ?? BCRYPT_PATH_QUEUE_LIMIT;
    this.queueTimeoutMs = opts.queueTimeoutMs ?? BCRYPT_PATH_QUEUE_TIMEOUT_MS;
    // 惰性过期 + 定时清扫，防僵尸 key 堆积（unref：不阻止进程退出）
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.rate) if (v.resetAt < now) this.rate.delete(k);
    }, 60_000);
    this.cleanupTimer.unref?.();
  }

  /**
   * 申请进入 bcrypt 兼容路径。返回 "allowed" 时调用方必须在完成后调 `release()`
   * （无论扫描成功失败）；"rate_limited" = 同 IP 超出窗口预算；"busy" = 并发打满
   * 且排队超时/队列满。注意：rate 检查先于并发检查，busy 也消耗窗口预算
   * （预算口径 = 进入路径的尝试次数）。
   */
  async tryEnter(clientIp: string): Promise<BcryptGuardVerdict> {
    try {
      const key = String(clientIp || "").slice(0, 64);
      const now = Date.now();
      const rec = this.rate.get(key);
      if (!rec || rec.resetAt < now) {
        this.rate.set(key, { count: 1, resetAt: now + this.windowMs });
      } else {
        rec.count += 1;
        if (rec.count > this.rateMax) return "rate_limited";
      }
      if (this.active < this.maxConcurrent) {
        this.active += 1;
        return "allowed";
      }
      if (this.waiters.length >= this.queueLimit) return "busy";
      const granted = await new Promise<boolean>((resolve) => {
        const waiter: Waiter = {
          done: false,
          resolve: (g) => {
            waiter.done = true;
            resolve(g);
          },
          timer: setTimeout(() => {
            // 排队超时：出队并拒绝（若已交接则 done=true，此处为空操作）
            if (waiter.done) return;
            const i = this.waiters.indexOf(waiter);
            if (i >= 0) this.waiters.splice(i, 1);
            resolve(false);
          }, this.queueTimeoutMs),
        };
        this.waiters.push(waiter);
      });
      return granted ? "allowed" : "busy";
    } catch {
      // 护栏内部异常 fail-open：放行（全局限流 hook 与 DB 本身仍是兜底），
      // 不因护栏故障打断存量令牌的兼容认证。
      return "allowed";
    }
  }

  /** 释放一次并发额度（与 "allowed" 一一对应；多余调用安全无害）。 */
  release(): void {
    if (this.active <= 0) return;
    this.active -= 1;
    // 交接：把额度直接转给队首等待者，不经过 0
    const next = this.waiters.shift();
    if (next && !next.done) {
      this.active += 1;
      clearTimeout(next.timer);
      next.resolve(true);
    }
  }

  /** 测试用：停掉清扫定时器并清空状态。 */
  dispose(): void {
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    this.rate.clear();
    this.active = 0;
    for (const w of this.waiters.splice(0)) {
      if (!w.done) w.resolve(false);
    }
  }
}

/** HTTP（index.ts）与 WS（ws/handler.ts）共用的进程级单例——两侧共用同一份速率/并发预算。 */
export const machineTokenBcryptGuard = new MachineTokenBcryptGuard();
