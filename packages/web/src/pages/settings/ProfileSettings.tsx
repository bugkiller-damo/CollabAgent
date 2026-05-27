import { useAuthStore } from "../../stores";

export function ProfileSettings() {
  const user = useAuthStore((s) => s.user);

  return (
    <div>
      <h2 className="text-white text-xl font-bold mb-6">个人资料</h2>
      <div className="bg-gray-800 rounded-lg p-6 max-w-lg">
        <div className="space-y-4">
          <div>
            <label className="text-gray-400 text-sm block mb-1">用户名</label>
            <input type="text" defaultValue={user?.displayName || ""} className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600" />
          </div>
          <div>
            <label className="text-gray-400 text-sm block mb-1">简介</label>
            <textarea defaultValue={user?.description || ""} rows={3} className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600" />
          </div>
          <button className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">保存</button>
        </div>
      </div>
    </div>
  );
}
