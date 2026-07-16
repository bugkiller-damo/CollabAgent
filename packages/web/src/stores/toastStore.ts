import { create } from "zustand";

// 极简 toast 系统：4 种 severity，4 秒自动消失
// 用法：import { toast } from "@/stores/toastStore"; toast.error("保存失败");

export type ToastKind = "info" | "success" | "warning" | "error";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastState {
  toasts: ToastItem[];
  push: (kind: ToastKind, message: string, durationMs?: number) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, message, durationMs = 4000) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    if (durationMs > 0) {
      setTimeout(() => get().dismiss(id), durationMs);
    }
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

// 便捷方法（直接调用，不必订阅 store）
export const toast = {
  info: (msg: string) => useToastStore.getState().push("info", msg),
  success: (msg: string) => useToastStore.getState().push("success", msg),
  warning: (msg: string) => useToastStore.getState().push("warning", msg),
  error: (msg: string) => useToastStore.getState().push("error", msg),
};
