export interface PendingItem {
  tempId: string;
  content: string;
  status: "sending" | "failed" | "queued";
}

export function PendingRow({ item, onRetry, onDiscard }: {
  item: PendingItem;
  onRetry: (tempId: string) => void;
  onDiscard: (tempId: string) => void;
}) {
  return (
    <div className="flex gap-3 p-2 rounded">
      <div className="w-8 h-8 rounded bg-blue-600 shrink-0 flex items-center justify-center text-xs text-white">我</div>
      <div className="min-w-0 flex-1">
        <p className={"text-sm whitespace-pre-wrap " + (item.status === "failed" ? "text-gray-500" : "text-gray-700 dark:text-gray-300")}>{item.content}</p>
        <div className="text-xs mt-0.5">
          {item.status === "sending" && <span className="text-gray-400">发送中…</span>}
          {item.status === "queued" && (
            <span className="text-amber-500">
              ⏳ 离线，恢复网络后自动发送
              <button onClick={() => onDiscard(item.tempId)} className="ml-2 underline text-gray-400 hover:text-gray-300">删除</button>
            </span>
          )}
          {item.status === "failed" && (
            <span className="text-red-500">
              ⚠️ 发送失败
              <button onClick={() => onRetry(item.tempId)} className="ml-2 underline hover:text-red-400">重试</button>
              <button onClick={() => onDiscard(item.tempId)} className="ml-2 underline text-gray-400 hover:text-gray-300">删除</button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
