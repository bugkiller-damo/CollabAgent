import { defineConfig } from "vitest/config";

// 黑盒集成测试：对运行中的 server 发 HTTP（默认 localhost:3001）。
// 单进程串行执行，避免并发改 DB 互相干扰。
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 30000,
    pool: "forks",
    fileParallelism: false,
  },
});
