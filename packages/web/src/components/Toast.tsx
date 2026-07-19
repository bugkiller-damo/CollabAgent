import { useToastStore, type ToastKind } from "../stores/toastStore";

const kindStyles: Record<ToastKind, { bg: string; icon: string; border: string }> = {
  info: { bg: "bg-blue-600", icon: "ℹ️", border: "border-blue-500" },
  success: { bg: "bg-emerald-600", icon: "✅", border: "border-emerald-500" },
  warning: { bg: "bg-amber-500", icon: "⚠️", border: "border-amber-400" },
  error: { bg: "bg-red-600", icon: "❌", border: "border-red-500" },
};

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t, idx) => {
        const s = kindStyles[t.kind];
        const delay = idx * 60;
        return (
          <div
            key={t.id}
            style={{ animationDelay: t.exiting ? undefined : `${delay}ms` }}
            className={[
              "pointer-events-auto flex items-start gap-2 text-white px-4 py-3 rounded-lg shadow-lg max-w-md border-l-4",
              s.bg,
              s.border,
              t.exiting ? "animate-fade-out" : "animate-slide-in-right",
            ].join(" ")}
          >
            <span className="text-lg shrink-0">{s.icon}</span>
            <p className="text-sm flex-1 break-words">{t.message}</p>
            <button
              onClick={() => dismiss(t.id)}
              className="text-white/70 hover:text-white shrink-0"
              aria-label="关闭"
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
