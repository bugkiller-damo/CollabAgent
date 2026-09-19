import { defineConfig } from "vitest/config";

// 黑盒集成测试：对运行中的 server 发 HTTP。
// 单进程串行执行，避免并发改 DB 互相干扰。
import "dotenv/config"; // 加载 packages/server/.env——helpers 直连库要的 DATABASE_URL 由此就位

// 限流规避：测试实例（pnpm test:server，NODE_ENV=test）不限流，默认打它；
// 实例不在线时回落 dev server :3001（大套件可能撞注册限流，属环境约束非断言失败）。
// 显式 SLOCK_TEST_BASE_URL 优先于探测结果。
async function resolveBaseUrl(): Promise<string> {
  const explicit = process.env.SLOCK_TEST_BASE_URL;
  if (explicit) return explicit;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    const r = await fetch("http://localhost:3011/api/health", { signal: ac.signal });
    clearTimeout(t);
    if (r.ok) return "http://localhost:3011";
  } catch {
    /* 测试实例不在线，回落 dev */
  }
  return "http://localhost:3001";
}

export default defineConfig(async () => ({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 30000,
    pool: "forks",
    fileParallelism: false,
    env: {
      SLOCK_TEST_BASE_URL: await resolveBaseUrl(),
    },
  },
}));
