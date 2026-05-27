import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";

export function LoginPage() {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState("");
  const authLogin = useAuthStore((s) => s.login);
  const navigate = useNavigate();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await authLogin(login, password, rememberMe);
      navigate("/channels/general");
    } catch (err: any) {
      setError(err.message || "登录失败");
    }
  };

  const handleDevBypass = () => {
    useAuthStore.getState().loginWithToken("dev-token");
    navigate("/channels/general");
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900">
      <form onSubmit={handleLogin} className="bg-gray-800 p-8 rounded-lg w-96 space-y-4">
        <h1 className="text-white text-2xl font-bold text-center">CollabAgent</h1>
        <input type="text" placeholder="用户名或邮箱" value={login}
          onChange={(e) => setLogin(e.target.value)}
          className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600" />
        <input type="password" placeholder="密码" value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600" />
        <label className="flex items-center gap-2 text-gray-400 text-sm">
          <input type="checkbox" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)} />
          记住我（30 天免登录）
        </label>
        <button type="submit" className="w-full p-2 rounded bg-blue-600 text-white hover:bg-blue-500">
          登录
        </button>
        {error && <p className="text-red-400 text-sm text-center">{error}</p>}
        <p className="text-gray-500 text-sm text-center">
          没有账号？<Link to="/register" className="text-blue-400">注册</Link>
        </p>
        <button type="button" onClick={handleDevBypass}
          className="w-full p-2 rounded bg-gray-600 text-gray-300 hover:bg-gray-500 text-sm">
          开发模式：跳过登录
        </button>
      </form>
    </div>
  );
}
