import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BCRYPT_PATH_MAX_CONCURRENT,
  BCRYPT_PATH_QUEUE_LIMIT,
  BCRYPT_PATH_QUEUE_TIMEOUT_MS,
  BCRYPT_PATH_RATE_MAX,
  BCRYPT_PATH_RATE_WINDOW_MS,
  MachineTokenBcryptGuard,
} from "../src/lib/machine-token-guard.js";
import { api, cleanupTestData, closeSql, registerUser, type TestUser } from "./helpers.js";

/**
 * 评估报告 P1.14：sk_machine_ 的 bcrypt 兼容路径全局护栏
 * （lib/machine-token-guard.ts，HTTP index.ts / WS ws/handler.ts 共用单例）。
 *
 * 单测（离线）覆盖 per-IP 固定窗口速率、并发信号量（上限/排队交接/超时 busy/
 * 队列上限）、key 归一化与幂等 release；在线集成仅 1 例——未知假令牌经护栏
 * 放行后正常 401（不做压测：护栏预算按 IP 计，与其它测试文件共享 127.0.0.1）。
 */

describe("MachineTokenBcryptGuard（P1.14 单测，离线）", () => {
  it("per-IP 固定窗口：预算内放行，超出 rate_limited，换 IP 不受影响", async () => {
    // maxConcurrent 调高避免与并发维度耦合（并发行为由专测覆盖）
    const g = new MachineTokenBcryptGuard({ rateMax: 3, windowMs: 60_000, maxConcurrent: 10 });
    try {
      for (let i = 0; i < 3; i++) expect(await g.tryEnter("10.1.1.1")).toBe("allowed");
      g.release();
      g.release();
      g.release();
      expect(await g.tryEnter("10.1.1.1")).toBe("rate_limited");
      expect(await g.tryEnter("10.1.1.2")).toBe("allowed");
      g.release();
    } finally {
      g.dispose();
    }
  });

  it("窗口过期后重新计数（固定窗口语义）", async () => {
    const g = new MachineTokenBcryptGuard({ rateMax: 1, windowMs: 40 });
    try {
      expect(await g.tryEnter("10.2.1.1")).toBe("allowed");
      g.release();
      expect(await g.tryEnter("10.2.1.1")).toBe("rate_limited");
      await new Promise((r) => setTimeout(r, 70));
      expect(await g.tryEnter("10.2.1.1")).toBe("allowed");
      g.release();
    } finally {
      g.dispose();
    }
  });

  it("IP key 归一化：空 IP 落同一桶、超长截断 64", async () => {
    const g = new MachineTokenBcryptGuard({ rateMax: 2, windowMs: 60_000 });
    try {
      expect(await g.tryEnter("")).toBe("allowed");
      expect(await g.tryEnter("")).toBe("allowed");
      g.release();
      g.release();
      expect(await g.tryEnter("")).toBe("rate_limited");
      const long = "9.9.9.9-" + "x".repeat(100);
      expect(await g.tryEnter(long)).toBe("allowed");
      g.release();
      // 截断后与 64 字符前缀同桶
      expect(await g.tryEnter(long.slice(0, 64))).toBe("allowed");
      g.release();
    } finally {
      g.dispose();
    }
  });

  it("并发上限：打满后排队超时 → busy；释放后恢复放行", async () => {
    const g = new MachineTokenBcryptGuard({ maxConcurrent: 1, queueTimeoutMs: 20 });
    try {
      expect(await g.tryEnter("10.3.1.1")).toBe("allowed");
      expect(await g.tryEnter("10.3.1.2")).toBe("busy");
      g.release();
      expect(await g.tryEnter("10.3.1.3")).toBe("allowed");
      g.release();
    } finally {
      g.dispose();
    }
  });

  it("排队交接：等待中的申请在 release 后拿到额度（不等超时）", async () => {
    const g = new MachineTokenBcryptGuard({ maxConcurrent: 1, queueTimeoutMs: 5_000 });
    try {
      expect(await g.tryEnter("10.4.1.1")).toBe("allowed");
      const pending = g.tryEnter("10.4.1.2");
      g.release(); // 立即交接
      expect(await pending).toBe("allowed");
      g.release();
    } finally {
      g.dispose();
    }
  });

  it("队列上限：队列满时新申请立即 busy", async () => {
    const g = new MachineTokenBcryptGuard({ maxConcurrent: 1, queueLimit: 1, queueTimeoutMs: 60_000 });
    try {
      expect(await g.tryEnter("10.5.1.1")).toBe("allowed");
      const queued = g.tryEnter("10.5.1.2"); // 占住唯一队列位
      expect(await g.tryEnter("10.5.1.3")).toBe("busy");
      g.release();
      expect(await queued).toBe("allowed");
      g.release();
    } finally {
      g.dispose();
    }
  });

  it("多余 release 幂等无害；默认常量口径", () => {
    const g = new MachineTokenBcryptGuard();
    g.release();
    g.release();
    expect(BCRYPT_PATH_RATE_MAX).toBe(20);
    expect(BCRYPT_PATH_RATE_WINDOW_MS).toBe(60_000);
    expect(BCRYPT_PATH_MAX_CONCURRENT).toBe(2);
    expect(BCRYPT_PATH_QUEUE_LIMIT).toBe(16);
    expect(BCRYPT_PATH_QUEUE_TIMEOUT_MS).toBe(3_000);
    g.dispose();
  });
});

describe("bcrypt 兼容路径护栏（P1.14 集成）", () => {
  let u: TestUser;

  beforeAll(async () => {
    u = await registerUser();
  });

  afterAll(async () => {
    await cleanupTestData();
    await closeSql();
  });

  it("未知 sk_machine_ 假令牌：护栏放行首次进入，兼容路径扫无命中 → 401", { timeout: 30_000 }, async () => {
    // 首次进入预算充足（护栏默认 20/min/IP；本文件不做压测以免挤占共享 IP 预算）
    const r = await api("/api/profile/tokens", {
      headers: { Authorization: "Bearer sk_machine_p1_14_guard_probe" },
    });
    expect(r.status).toBe(401);
    // 新计数器已进 metrics 快照（被拒行为由单测覆盖；此处验证接线）
    const m = await api("/api/metrics", { cookie: u.cookie });
    expect(m.status).toBe(200);
    const counters = m.data.counters as Record<string, number>;
    expect(counters).toHaveProperty("machineAuthBcryptRejected");
    expect(counters).toHaveProperty("machineAuthBcryptScans");
  });
});
