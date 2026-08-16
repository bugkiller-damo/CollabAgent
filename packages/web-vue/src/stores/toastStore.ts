import { defineStore } from "pinia";
import { ref } from "vue";

export type ToastKind = "info" | "success" | "warning" | "error";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  exiting?: boolean;
}

let nextId = 1;

export const useToastStore = defineStore("toast", () => {
  const toasts = ref<ToastItem[]>([]);

  function push(kind: ToastKind, message: string, durationMs = 4000): void {
    const id = nextId++;
    toasts.value = [...toasts.value, { id, kind, message }];
    if (durationMs > 0) {
      setTimeout(() => dismiss(id), durationMs);
    }
  }

  function dismiss(id: number): void {
    // 标记为退出中，触发退场动画，动画结束后再移除
    toasts.value = toasts.value.map((t) => (t.id === id ? { ...t, exiting: true } : t));
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id);
    }, 180);
  }

  return { toasts, push, dismiss };
});

/**
 * 非组件环境的便捷入口（对齐 React 版 useToastStore.getState().push 的用法）。
 * 注意：pinia 版在调用时需要 active pinia（app.use(createPinia()) 之后的运行时
 * 调用都满足）；模块加载期/安装 pinia 前不可调用。
 */
export const toast = {
  info: (msg: string) => useToastStore().push("info", msg),
  success: (msg: string) => useToastStore().push("success", msg),
  warning: (msg: string) => useToastStore().push("warning", msg),
  error: (msg: string) => useToastStore().push("error", msg),
};
