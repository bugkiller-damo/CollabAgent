import { useState, useEffect } from "react";
import { useNavigate, Link, useSearchParams } from "react-router-dom";
import { apiGet, apiPost } from "../api/client";
import { useAuthStore } from "../stores/authStore";
import { PasswordStrength } from "../components/PasswordStrength";
import { Card } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";

export function RegisterPage() {
  const [handle, setHandle] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const invite = params.get("invite") || "";
  const [inviteInfo, setInviteInfo] = useState<{ serverName?: string; error?: string } | null>(null);

  useEffect(() => {
    if (!invite) return;
    apiGet<{ valid: boolean; serverName: string }>(`/api/invites/${invite}`)
      .then((d) => setInviteInfo({ serverName: d.serverName }))
      .catch((e) => setInviteInfo({ error: e?.message || "邀请链接无效" }));
  }, [invite]);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPwd) {
      setError("两次密码不一致");
      return;
    }
    if (password.length < 8) {
      setError("密码至少 8 位");
      return;
    }
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      setError("密码需包含字母和数字");
      return;
    }

    setLoading(true);
    try {
      const data = await apiPost<{ token: string; user: { id: string; handle: string; displayName: string } }>(
        "/api/auth/register",
        { handle, password, email, displayName: handle, invite: invite || undefined }
      );
      localStorage.setItem("user", JSON.stringify(data.user));
      useAuthStore.setState({ user: data.user as any, isAuthenticated: true });
      navigate("/channels/general");
    } catch (err) {
      setError((err as Error).message || "注册失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4 dark:bg-gray-900">
      <Card padding="lg" className="w-full max-w-sm space-y-5">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">注册</h1>
        </div>

        {invite && inviteInfo?.serverName && (
          <div className="rounded-lg bg-green-50 p-3 text-center text-sm text-green-700 dark:bg-green-900/30 dark:text-green-300">
            你受邀加入工作区「{inviteInfo.serverName}」，注册后自动入组。
          </div>
        )}
        {invite && inviteInfo?.error && (
          <div className="rounded-lg bg-amber-50 p-3 text-center text-sm text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
            {inviteInfo.error}（仍可正常注册，但不会自动入组）
          </div>
        )}

        <form onSubmit={handleRegister} className="space-y-4">
          <Input
            type="text"
            placeholder="用户名"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            required
            minLength={2}
            maxLength={20}
          />
          <Input
            type="email"
            placeholder="邮箱（用于找回密码）"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <div>
            <div className="relative">
              <Input
                type={showPwd ? "text" : "password"}
                placeholder="密码（至少8位，含字母和数字）"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPwd((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              >
                {showPwd ? "🙈" : "👁"}
              </button>
            </div>
            <PasswordStrength password={password} />
          </div>
          <Input
            type={showPwd ? "text" : "password"}
            placeholder="确认密码"
            value={confirmPwd}
            onChange={(e) => setConfirmPwd(e.target.value)}
          />
          <Button type="submit" loading={loading} className="w-full">注册</Button>
          {error && <p className="text-center text-sm text-red-500">{error}</p>}
        </form>

        <p className="text-center text-sm text-gray-500 dark:text-gray-400">
          已有账号？<Link to="/login" className="text-blue-500 hover:underline">登录</Link>
        </p>
      </Card>
    </div>
  );
}
