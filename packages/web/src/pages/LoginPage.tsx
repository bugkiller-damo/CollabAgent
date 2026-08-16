import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { useAuthStore } from "../stores/authStore";

export function LoginPage() {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const authLogin = useAuthStore((s) => s.login);
  const navigate = useNavigate();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await authLogin(login, password, rememberMe);
      navigate("/channels/general");
    } catch (err: any) {
      setError(err.message || "登录失败");
    } finally {
      setLoading(false);
    }
  };

  const handleDevBypass = () => {
    fetch("/api/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "dev", password: "dev", remember: true }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.user) {
          localStorage.setItem("user", JSON.stringify(d.user));
          useAuthStore.setState({ user: d.user as any, isAuthenticated: true });
          navigate("/channels/general");
        }
      })
      .catch(() => {});
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4 dark:bg-gray-900">
      <Card padding="lg" className="w-full max-w-sm space-y-5">
        <div className="text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-blue-600 text-white">
            <span className="font-bold">C</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">CollabAgent</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">登录到工作区</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <Input
            type="text"
            placeholder="用户名或邮箱"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            autoComplete="username"
          />
          <Input
            type="password"
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600"
            />
            记住我（30 天免登录）
          </label>
          <Button type="submit" loading={loading} className="w-full">
            登录
          </Button>
          {error && <p className="text-center text-sm text-red-500">{error}</p>}
        </form>

        <p className="text-center text-sm text-gray-500 dark:text-gray-400">
          <Link to="/forgot-password" className="text-blue-500 hover:underline">
            忘记密码
          </Link>
          <span className="mx-2">·</span>
          <Link to="/register" className="text-blue-500 hover:underline">
            注册
          </Link>
        </p>

        <Button type="button" variant="secondary" onClick={handleDevBypass} className="w-full">
          开发模式：跳过登录
        </Button>
      </Card>
    </div>
  );
}
