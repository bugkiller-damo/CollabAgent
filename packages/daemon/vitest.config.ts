// 不从 "vitest/config" import defineConfig——vitest 在这个workspace 里不是
// packages/daemon 自己声明的依赖（只是 pnpm store 里恰好存在的间接依赖，靠
// `node ../../node_modules/.pnpm/node_modules/vitest/vitest.mjs` 这种直接路径
// 调用的），从这个包的 node_modules 解析 "vitest/config" 会失败。config 对象
// 本身不需要这个 helper 才能生效，纯对象导出就够。
export default {
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
};
