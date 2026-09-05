import { onMounted, onUnmounted } from "vue";

/**
 * 组件级轮询：onMounted 启动 setInterval，onUnmounted 自动清理。
 * 返回 { stop } 供提前停止（幂等）。
 */

/**
 * 生命周期无关的轮询计时器（#18 抽取：使 node 测试可直测计时/幂等 stop 逻辑，
 * usePolling 只保留 onMounted/onUnmounted 的生命周期接线）。
 */
export function startPolling(fn: () => void | Promise<void>, ms: number): { stop: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  timer = setInterval(() => {
    void fn();
  }, ms);

  return { stop };
}

export function usePolling(fn: () => void | Promise<void>, ms: number): { stop: () => void } {
  let handle: { stop: () => void } | null = null;

  onMounted(() => {
    handle = startPolling(fn, ms);
  });
  onUnmounted(() => {
    handle?.stop();
  });

  return {
    stop: () => {
      handle?.stop();
    },
  };
}
