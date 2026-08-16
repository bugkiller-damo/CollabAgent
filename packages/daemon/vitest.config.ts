// vitest 已作为 packages/daemon 的正式 devDependency 声明（见 package.json），
// 这里用标准的 defineConfig 获取类型提示。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 这套测试里有几个文件会真的 spawn 子进程（mcp-server.test.ts 真的 spawn
    // 打包出来的 MCP server；session-resume.test.ts 用真实定时器等宽限期/
    // bootstrap 就绪）。在核数较少的机器上，vitest 默认的按文件并行调度会让
    // 这些测试互相抢 OS 级资源，导致 mcp-server.test.ts 的子进程 stdio 偶发
    // 迟迟收不到响应而超时——实测过：单独跑或关掉文件级并行都能稳定通过，开着
    // 并行跑全量测试则会偶发超时，不是逻辑 bug。这里牺牲一点总耗时换稳定性
    // （这个项目一贯的取舍，见 docs/2026-07-16/11-daemon-test-coverage-plan.md
    // 执行记录里"先保证正确性，测试跑得慢一点可以接受"）。
    fileParallelism: false,
  },
});
