import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimitHook } from "../src/lib/rate-limit.js";

// P1.28：全局限流 hook 回归网（评估零覆盖清单 ⑤，此前无任何测试）。
// 离线直测：hook 是纯 (request, reply) 函数，用假 req/reply 驱动，无需起 server。
// 注意：vitest 进程 NODE_ENV=test，hook 会整体跳过——限流语义用例临时改写 NODE_ENV
// 并在 afterEach 恢复（pool:forks 文件间进程隔离，不外溢）。
// 本机 .env 未配 VALKEY_URL → 单例 backend 是 MemoryBackend（无外部依赖）。

interface FakeReply {
  statusCode?: number;
  body?: unknown;
  status(code: number): FakeReply;
  send(b: unknown): void;
}

function fakeReply(): FakeReply {
  const r: FakeReply = {
    status(code: number) {
      r.statusCode = code;
      return r;
    },
    send(b: unknown) {
      r.body = b;
    },
  };
  return r;
}

function req(url: string, ip: string, method = "GET"): { url: string; ip: string; method: string } {
  return { url, ip, method };
}

/** 用唯一 ip 连打 n 次同一 URL，返回最后一次的 reply */
async function flood(url: string, ip: string, times: number, method = "GET"): Promise<FakeReply> {
  let reply: FakeReply = fakeReply();
  for (let i = 0; i < times; i++) {
    reply = fakeReply();
    await rateLimitHook(req(url, ip, method), reply as any);
  }
  return reply;
}

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development"; // 打开限流路径
});

afterEach(() => {
  process.env.NODE_ENV = savedEnv;
  vi.useRealTimers();
});

describe("rate-limit hook", () => {
  it("NODE_ENV=test 整体跳过（黑盒测试套件依赖此前提）", async () => {
    process.env.NODE_ENV = "test";
    const reply = await flood("/api/whatever", "10.9.9.1", 500); // 远超任何桶上限
    expect(reply.statusCode).toBeUndefined();
  });

  it("/api/health 恒放行", async () => {
    const reply = await flood("/api/health", "10.9.9.2", 50);
    expect(reply.statusCode).toBeUndefined();
  });

  it("query string 不参与分桶：同路径不同 query 共享同一桶", async () => {
    // api 桶 max=100：先打 100 次 /api/preview?a=1，再打 /api/preview?b=2 应已超限
    await flood("/api/preview?a=1", "10.9.9.3", 100);
    const reply = fakeReply();
    await rateLimitHook(req("/api/preview?b=2", "10.9.9.3"), reply as any);
    expect(reply.statusCode).toBe(429);
    expect((reply.body as any).error).toContain("请求过于频繁");
  });

  it("桶按 (ip, method, path) 隔离", async () => {
    await flood("/api/preview", "10.9.9.4", 100); // 打满 GET api 桶
    const otherIp = fakeReply();
    await rateLimitHook(req("/api/preview", "10.9.9.5"), otherIp as any);
    expect(otherIp.statusCode).toBeUndefined();
    const otherMethod = fakeReply();
    await rateLimitHook(req("/api/preview", "10.9.9.4", "POST"), otherMethod as any);
    expect(otherMethod.statusCode).toBeUndefined();
  });

  it("auth 桶 max=20（/api/auth/login 第 21 次 429）", async () => {
    const reply = await flood("/api/auth/login", "10.9.9.6", 21, "POST");
    expect(reply.statusCode).toBe(429);
  });

  it("sensitive 桶 max=5（/api/profile/change-password 第 6 次 429）", async () => {
    const reply = await flood("/api/profile/change-password", "10.9.9.7", 6, "POST");
    expect(reply.statusCode).toBe(429);
  });

  it("窗口过期后桶重置（假时钟推进 windowMs）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await flood("/api/auth/login", "10.9.9.8", 20, "POST"); // 打满
    vi.setSystemTime(Date.now() + 61_000); // 越过 60s 窗口
    const reply = fakeReply();
    await rateLimitHook(req("/api/auth/login", "10.9.9.8", "POST"), reply as any);
    expect(reply.statusCode).toBeUndefined(); // 新窗口重新计数
  });
});
