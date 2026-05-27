export function AdminPanel() {
  return (
    <div className="p-6">
      <h2 className="text-white text-xl font-bold mb-4">管理后台</h2>
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-gray-800 p-4 rounded-lg">
          <h3 className="text-white font-semibold">频道管理</h3>
          <p className="text-gray-500 text-sm mt-2">创建、归档、删除频道</p>
        </div>
        <div className="bg-gray-800 p-4 rounded-lg">
          <h3 className="text-white font-semibold">Agent 管理</h3>
          <p className="text-gray-500 text-sm mt-2">注册、配置 AI Agent</p>
        </div>
        <div className="bg-gray-800 p-4 rounded-lg">
          <h3 className="text-white font-semibold">成员管理</h3>
          <p className="text-gray-500 text-sm mt-2">邀请、移除、角色分配</p>
        </div>
      </div>
    </div>
  );
}
