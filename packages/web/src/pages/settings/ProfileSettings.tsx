import { useRef, useState } from "react";
import { apiPatch, apiPost, uploadAttachment } from "../../api/client";
import { PageHeader } from "../../components/layout/PageHeader";
import { PasswordStrength } from "../../components/PasswordStrength";
import { Avatar } from "../../components/ui/Avatar";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { Textarea } from "../../components/ui/Textarea";
import { useAuthStore } from "../../stores";

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
    if (file.size > 10 * 1024 * 1024) {
      setMsg("头像不能超过 10MB");
      return;
    }
    setAvatarUploading(true);
    setMsg("");
    try {
      const up = await uploadAttachment(file);
      await apiPatch("/api/profile", { avatarUrl: up.url });
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
      await apiPatch("/api/profile", { displayName, description });
      setMsg("已保存");
      updateUser({ displayName, description });
    } catch {
      setMsg("保存失败");
    }
  };

  const handleChangePassword = async () => {
    if (newPw.length < 8) {
      setPwMsg("新密码至少 8 位");
      return;
    }
    try {
      await apiPost("/api/profile/change-password", { oldPassword: oldPw, newPassword: newPw });
      setPwMsg("密码已修改，其他设备需重新登录");
      setOldPw("");
      setNewPw("");
    } catch (err: any) {
      setPwMsg(err.message || "修改失败");
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="个人资料" backTo="/settings" />

      <Card className="w-full">
        <div className="mx-auto max-w-lg space-y-4">
          <div className="flex items-center gap-4">
            <Avatar name={user?.handle || "?"} src={avatarUrl} size="xl" />
            <div>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.[0]) handleAvatar(e.target.files[0]);
                  e.target.value = "";
                }}
              />
              <Button
                onClick={() => avatarInputRef.current?.click()}
                disabled={avatarUploading}
                size="sm"
                variant="secondary"
              >
                {avatarUploading ? "上传中…" : "更换头像"}
              </Button>
              <p className="mt-1 text-xs text-gray-400">支持 JPG/PNG，最大 10MB</p>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-600 dark:text-gray-400">用户名 (不可修改)</label>
            <Input type="text" value={user?.handle || ""} disabled />
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-600 dark:text-gray-400">显示名</label>
            <Input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-600 dark:text-gray-400">简介</label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </div>
          <Button onClick={handleSaveProfile} size="sm">
            保存
          </Button>
          {msg && <p className="text-sm text-green-600 dark:text-green-400">{msg}</p>}
        </div>
      </Card>

      <Card className="w-full">
        <div className="mx-auto max-w-lg space-y-4">
          <h3 className="font-semibold text-gray-900 dark:text-white">修改密码</h3>
          <Input
            type={showPw ? "text" : "password"}
            value={oldPw}
            onChange={(e) => setOldPw(e.target.value)}
            placeholder="当前密码"
          />
          <div>
            <div className="relative">
              <Input
                type={showPw ? "text" : "password"}
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                placeholder="新密码 (至少 8 位)"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              >
                {showPw ? "🙈" : "👁"}
              </button>
            </div>
            <PasswordStrength password={newPw} />
          </div>
          <Button onClick={handleChangePassword} size="sm">
            修改密码
          </Button>
          {pwMsg && <p className="text-sm text-green-600 dark:text-green-400">{pwMsg}</p>}
        </div>
      </Card>
    </div>
  );
}
