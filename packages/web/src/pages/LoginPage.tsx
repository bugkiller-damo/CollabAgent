import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";

export function LoginPage() {
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const login = useAuthStore((s) => s.login);
  const navigate = useNavigate();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await login(handle, password);
      navigate("/channels/general");
    } catch {
      setError("登录失败，请检查用户名和密码");
    }
  };

  // 开发模式：跳过登录，注册 demo 用户后直接进入
  const handleDevBypass = async () => {
    try {
      await login("demo", "password123");
      navigate("/channels/general");
    } catch {
      // demo 用户可能不存在，先用 dev-token 进入
      useAuthStore.getState().loginWithToken("dev-token");
      navigate("/channels/general");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900">
      <form onSubmit={handleLogin} className="bg-gray-800 p-8 rounded-lg w-96 space-y-4">
        <h1 className="text-white text-2xl font-bold text-center">CollabAgent</h1>
        <input
          type="text" placeholder="用户名" value={handle}
          onChange={(e) => setHandle(e.target.value)}
          className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600"
        />
        <input
          type="password" placeholder="Password" value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600"
        />
        <button type="submit" className="w-full p-2 rounded bg-blue-600 text-white hover:bg-blue-500">
          Login
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
