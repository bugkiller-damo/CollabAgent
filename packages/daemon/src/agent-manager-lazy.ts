/**
 * P0.7（2026-08-25）：懒加载 IAgentManager。
 *
 * headless 是默认路径，但 agent-runtime.ts 此前无条件 `createAgentManager()`，
 * 而 agent-manager.ts 顶层 `import { spawn } from "node-pty"` 会立刻加载原生
 * 模块——原生依赖加载失败会连带拖垮 headless 启动，且白占内存。
 *
 * 本包装把真实 manager 的创建推迟到第一次 `startAgent`（即 PTY fallback
 * 真正要 spawn 时）经动态 import 完成；headless 全程不触发，node-pty
 * 不进内存。
 *
 * 语义约定：
 * - 同步方法在真实 manager 加载前是安全 no-op（getRun → undefined 等）——
 *   没有 startAgent 就不存在任何 run，这些调用本就查不到东西；
 * - `getOutputBus()` 加载前返回一个本地空 bus（createPtyOutputBus 不依赖
 *   node-pty），加载后转发真实 bus——spawn 路径在 startAgent 之后才订阅，
 *   不会订到空 bus 上；daemon-core 启动时的 wireAgentOutput 只拿 bus 打日志；
 * - 并发 startAgent 共享同一次加载；加载失败后下次重试。
 */
import { createPtyOutputBus } from "./pty-output-bus.js";
import type { AgentRunSnapshot, IAgentManager, PtyOutputBus, StartAgentInput } from "./types/index.js";

export interface ILazyAgentManager extends IAgentManager {
  /** 真实 manager（即 node-pty）是否已加载——测试断言用 */
  isLoaded(): boolean;
}

export const createLazyAgentManager = (
  loader: () => Promise<IAgentManager> = async () => (await import("./agent-manager.js")).createAgentManager(),
): ILazyAgentManager => {
  let real: IAgentManager | null = null;
  let loading: Promise<IAgentManager> | null = null;
  // 加载前的空 bus：没有 run 就没人会真正订阅到事件，仅保证接口可用。
  const idleBus: PtyOutputBus = createPtyOutputBus();

  const ensure = (): Promise<IAgentManager> => {
    if (real) return Promise.resolve(real);
    if (!loading) {
      console.log("[Runtime] loading PTY agent manager (node-pty) on first PTY spawn…");
      loading = loader().then(
        (m) => (real = m),
        (err) => {
          // 加载失败（如 node-pty 原生模块损坏）不缓存 rejection，下次 spawn 重试
          loading = null;
          throw err;
        },
      );
    }
    return loading;
  };

  return {
    isLoaded: () => real !== null,
    async startAgent(input: StartAgentInput): Promise<AgentRunSnapshot> {
      const m = await ensure();
      return m.startAgent(input);
    },
    stopRun: (runId) => real?.stopRun(runId),
    writeInput: (runId, input) => real?.writeInput(runId, input),
    resizeRun: (runId, cols, rows) => real?.resizeRun(runId, cols, rows),
    pauseRun: (runId) => real?.pauseRun(runId),
    resumeRun: (runId) => real?.resumeRun(runId),
    getRun: (runId) => real?.getRun(runId),
    getOutputBus: () => real?.getOutputBus() ?? idleBus,
    removeRun: (runId) => real?.removeRun(runId),
  };
};
