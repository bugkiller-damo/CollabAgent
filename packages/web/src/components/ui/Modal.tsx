import { useEffect, useState, type ReactNode } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  /** 内容区宽度类（默认 max-w-md；终端查看器等宽弹窗传 "max-w-4xl" 之类） */
  widthClass?: string;
}

export function Modal({ open, onClose, children, className = "", widthClass = "max-w-md" }: ModalProps) {
  const [render, setRender] = useState(open);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    if (open) {
      setExiting(false);
      setRender(true);
    } else {
      setExiting(true);
      const t = setTimeout(() => setRender(false), 150);
      return () => clearTimeout(t);
    }
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!render) return null;

  return (
    <div
      className={[
        "fixed inset-0 z-50 flex items-center justify-center",
        exiting ? "animate-fade-out" : "animate-fade-in",
        "bg-black/50",
      ].join(" ")}
      onClick={onClose}
    >
      <div
        className={[
          "mx-4 w-full transform rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800",
          widthClass,
          exiting ? "animate-scale-out" : "animate-scale-in",
          className,
        ].join(" ")}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
