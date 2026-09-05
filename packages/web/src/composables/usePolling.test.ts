import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPolling } from "./usePolling";

// #18 抽取：usePolling 的 onMounted/onUnmounted 生命周期接线需组件挂载设施（node 无），
// 计时器核心抽为 startPolling 后在此直测；生命周期接线本身行为等价保持不变。
describe("startPolling（usePolling 的计时核心）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("按 ms 周期重复执行 fn", () => {
    const fn = vi.fn();
    const { stop } = startPolling(fn, 100);

    vi.advanceTimersByTime(350); // t=100/200/300 共 3 次
    expect(fn).toHaveBeenCalledTimes(3);
    stop();
  });

  it("stop 幂等，且停止后不再触发", () => {
    const fn = vi.fn();
    const { stop } = startPolling(fn, 100);

    vi.advanceTimersByTime(250); // 2 次
    stop();
    expect(() => stop()).not.toThrow(); // 幂等
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(2); // 停止后零触发
  });
});
