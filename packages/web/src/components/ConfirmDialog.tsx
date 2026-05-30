interface Props {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ title, message, confirmLabel = "确定", cancelLabel = "取消", danger, onConfirm, onCancel }: Props) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-sm mx-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-gray-900 dark:text-white text-base font-bold">{title}</h3>
        {message && <p className="text-gray-600 dark:text-gray-400 text-sm">{message}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onCancel}
            className="px-4 py-2 rounded text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600">
            {cancelLabel}
          </button>
          <button onClick={onConfirm}
            className={"px-4 py-2 rounded text-sm text-white " + (danger ? "bg-red-600 hover:bg-red-500" : "bg-blue-600 hover:bg-blue-500")}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
