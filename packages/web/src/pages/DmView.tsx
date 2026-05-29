export function DmView() {
  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-gray-700">
        <h2 className="text-white font-bold">私信</h2>
      </div>
      <div className="flex-1 p-4 overflow-y-auto">
        <p className="text-gray-400">私信消息 — 待实现</p>
      </div>
      <div className="p-4 border-t border-gray-700">
        <textarea placeholder="输入消息... (Enter 发送, Shift+Enter 换行)" rows={1}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); (e.target as any).form?.requestSubmit(); } }}
          onChange={e => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px"; }} className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600 resize-none" />
      </div>
    </div>
  );
}
