import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const login = useAuthStore((s) => s.login);
  const navigate = useNavigate();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await login(email, password);
      navigate("/channels/general");
    } catch {
      setError("登录失败，请检查邮箱和密码");
    }
  };

  // 开发模式：跳过登录，直接进入
  const handleDevBypass = () => {
    useAuthStore.getState().loginWithToken("dev-token");
    navigate("/channels/general");
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900">
      <form onSubmit={handleLogin} className="bg-gray-800 p-8 rounded-lg w-96 space-y-4">
        <h1 className="text-white text-2xl font-bold text-center">CollabAgent</h1>
        <input
          type="email" placeholder="Email" value={email}
          onChange={(e) => setEmail(e.target.value)}
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
