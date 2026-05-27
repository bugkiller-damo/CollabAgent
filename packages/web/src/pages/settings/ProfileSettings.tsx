import { useState } from "react";
import { useAuthStore } from "../../stores";
import { apiPatch, apiPost } from "../../api/client";

export function ProfileSettings() {
  const user = useAuthStore((s) => s.user);
  const [displayName, setDisplayName] = useState(user?.displayName || "");
  const [description, setDescription] = useState(user?.description || "");
  const [msg, setMsg] = useState("");

  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [pwMsg, setPwMsg] = useState("");

  const handleSaveProfile = async () => {
    try {
      await apiPatch("/api/auth/profile", { displayName, description });
      setMsg("已保存");
      useAuthStore.setState({ user: { ...user, displayName, description } as any });
    } catch {
      setMsg("保存失败");
    }
  };

  const handleChangePassword = async () => {
    if (newPw.length < 6) { setPwMsg("新密码至少 6 位"); return; }
    try {
      await apiPost("/api/auth/change-password", { oldPassword: oldPw, newPassword: newPw });
      setPwMsg("密码已修改，其他设备需重新登录");
      setOldPw(""); setNewPw("");
    } catch (err: any) {
      setPwMsg(err.message || "修改失败");
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-white text-xl font-bold">个人资料</h2>

      <div className="bg-gray-800 rounded-lg p-6 max-w-lg space-y-4">
        <div>
          <label className="text-gray-400 text-sm block mb-1">用户名 (不可修改)</label>
          <input type="text" value={user?.handle || ""} disabled
            className="w-full p-2 rounded bg-gray-700 text-gray-500 border border-gray-600 cursor-not-allowed" />
        </div>
        <div>
          <label className="text-gray-400 text-sm block mb-1">显示名</label>
          <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)}
            className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600" />
        </div>
        <div>
          <label className="text-gray-400 text-sm block mb-1">简介</label>
          <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3}
            className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600" />
        </div>
        <button onClick={handleSaveProfile}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">保存</button>
        {msg && <p className="text-green-400 text-sm">{msg}</p>}
      </div>

      <div className="bg-gray-800 rounded-lg p-6 max-w-lg space-y-4">
        <h3 className="text-white font-semibold">修改密码</h3>
        <input type="password" value={oldPw} onChange={e => setOldPw(e.target.value)}
          placeholder="当前密码" className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600" />
        <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)}
          placeholder="新密码 (至少 6 位)" className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600" />
        <button onClick={handleChangePassword}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">修改密码</button>
        {pwMsg && <p className="text-sm text-green-400">{pwMsg}</p>}
      </div>
    </div>
  );
}
