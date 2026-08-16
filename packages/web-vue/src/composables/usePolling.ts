import { onMounted, onUnmounted } from "vue";

/**
 * 组件级轮询：onMounted 启动 setInterval，onUnmounted 自动清理。
 * 返回 { stop } 供提前停止（幂等）。
 */
export function usePolling(fn: () => void | Promise<void>, ms: number): { stop: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  onMounted(() => {
    timer = setInterval(() => { void fn(); }, ms);
  });
  onUnmounted(stop);

  return { stop };
}
