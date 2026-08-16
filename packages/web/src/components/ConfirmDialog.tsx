import { Modal } from "./ui/Modal";

interface Props {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "确定",
  cancelLabel = "取消",
  danger,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Modal open onClose={onCancel}>
      <h3 className="text-base font-bold text-gray-900 dark:text-white">{title}</h3>
      {message && <p className="text-sm text-gray-600 dark:text-gray-400">{message}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="rounded-md bg-gray-200 px-4 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-300 active:scale-[0.98] dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
        >
          {cancelLabel}
        </button>
        <button
          onClick={onConfirm}
          className={[
            "rounded-md px-4 py-2 text-sm text-white transition-colors active:scale-[0.98]",
            danger ? "bg-red-600 hover:bg-red-500" : "bg-blue-600 hover:bg-blue-500",
          ].join(" ")}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
