import { useState, useRef } from "react";
import { useAuthStore } from "../../stores";
import { apiPatch, apiPost, uploadAttachment } from "../../api/client";
import { PasswordStrength } from "../../components/PasswordStrength";

export function ProfileSettings() {
  const user = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);
  const [displayName, setDisplayName] = useState(user?.displayName || "");
  const [description, setDescription] = useState(user?.description || "");
  const [msg, setMsg] = useState("");

  const [avatarUrl, setAvatarUrl] = useState((user as any)?.avatarUrl || "");
  const [avatarUploading, setAvatarUploading] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [pwMsg, setPwMsg] = useState("");

  const handleAvatar = async (file: File) => {
    if (file.size > 10 * 1024 * 1024) { setMsg("头像不能超过 10MB"); return; }
    setAvatarUploading(true);
    setMsg("");
    try {
      const up = await uploadAttachment(file);
      await apiPatch("/api/auth/profile", { avatarUrl: up.url });
      setAvatarUrl(up.url);
      updateUser({ avatarUrl: up.url } as any);
      setMsg("头像已更新");
    } catch {
      setMsg("头像上传失败");
    } finally {
      setAvatarUploading(false);
    }
  };

  const handleSaveProfile = async () => {
    try {
      await apiPatch("/api/auth/profile", { displayName, description });
      setMsg("已保存");
      updateUser({ displayName, description });
    } catch {
      setMsg("保存失败");
    }
  };

  const handleChangePassword = async () => {
    if (newPw.length < 8) { setPwMsg("新密码至少 8 位"); return; }
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
      <h2 className="text-gray-900 dark:text-white text-xl font-bold">个人资料</h2>

      <div className="bg-gray-100 dark:bg-gray-800 rounded-lg p-6 max-w-lg space-y-4">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-full bg-gray-400 dark:bg-gray-600 overflow-hidden flex items-center justify-center text-white text-xl font-bold">
            {avatarUrl ? <img src={avatarUrl} alt="avatar" className="w-full h-full object-cover" /> : (user?.handle?.[0]?.toUpperCase() || "?")}
          </div>
          <div>
            <input ref={avatarInputRef} type="file" accept="image/*" className="hidden"
              onChange={(e) => { if (e.target.files?.[0]) handleAvatar(e.target.files[0]); e.target.value = ""; }} />
            <button type="button" onClick={() => avatarInputRef.current?.click()} disabled={avatarUploading}
              className="text-sm px-3 py-1.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50">
              {avatarUploading ? "上传中…" : "更换头像"}
            </button>
            <p className="text-gray-400 text-xs mt-1">支持 JPG/PNG，最大 10MB</p>
          </div>
        </div>
        <div>
          <label className="text-gray-600 dark:text-gray-400 text-sm block mb-1">用户名 (不可修改)</label>
          <input type="text" value={user?.handle || ""} disabled
            className="w-full p-2 rounded bg-gray-200 dark:bg-gray-700 text-gray-500 border border-gray-300 dark:border-gray-600 cursor-not-allowed" />
        </div>
        <div>
          <label className="text-gray-600 dark:text-gray-400 text-sm block mb-1">显示名</label>
          <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)}
            className="w-full p-2 rounded bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600" />
        </div>
        <div>
          <label className="text-gray-600 dark:text-gray-400 text-sm block mb-1">简介</label>
          <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3}
            className="w-full p-2 rounded bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600" />
        </div>
        <button onClick={handleSaveProfile}
          className="bg-blue-600 text-gray-900 dark:text-white px-4 py-2 rounded hover:bg-blue-700">保存</button>
        {msg && <p className="text-green-400 text-sm">{msg}</p>}
      </div>

      <div className="bg-gray-100 dark:bg-gray-800 rounded-lg p-6 max-w-lg space-y-4">
        <h3 className="text-gray-900 dark:text-white font-semibold">修改密码</h3>
        <input type={showPw ? "text" : "password"} value={oldPw} onChange={e => setOldPw(e.target.value)}
          placeholder="当前密码" className="w-full p-2 rounded bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600" />
        <div>
          <div className="relative">
            <input type={showPw ? "text" : "password"} value={newPw} onChange={e => setNewPw(e.target.value)}
              placeholder="新密码 (至少 8 位)" className="w-full p-2 pr-10 rounded bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600" />
            <button type="button" onClick={() => setShowPw((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
              {showPw ? "🙈" : "👁"}
            </button>
          </div>
          <PasswordStrength password={newPw} />
        </div>
        <button onClick={handleChangePassword}
          className="bg-blue-600 text-gray-900 dark:text-white px-4 py-2 rounded hover:bg-blue-700">修改密码</button>
        {pwMsg && <p className="text-sm text-green-400">{pwMsg}</p>}
      </div>
    </div>
  );
}
