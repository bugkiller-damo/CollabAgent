export function ChannelView() {
  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-gray-700">
        <h2 className="text-white font-bold"># general</h2>
      </div>
      <div className="flex-1 p-4 overflow-y-auto">
        <p className="text-gray-400">消息区域 — 待实现</p>
      </div>
      <div className="p-4 border-t border-gray-700">
        <input
          type="text" placeholder="输入消息..."
          className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600"
        />
      </div>
    </div>
  );
}
