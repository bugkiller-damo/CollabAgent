import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { apiPost } from "../api/client";

export function RegisterPage() {
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const data = await apiPost<{ token: string }>("/api/auth/register", {
        handle,
        password,
        displayName: handle,
      });
      localStorage.setItem("auth_token", data.token);
      navigate("/channels/general");
    } catch (err) {
      setError((err as Error).message || "注册失败");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900">
      <form onSubmit={handleRegister} className="bg-gray-800 p-8 rounded-lg w-96 space-y-4">
        <h1 className="text-white text-2xl font-bold text-center">注册</h1>
        <input
          type="text" placeholder="用户名" value={handle}
          onChange={(e) => setHandle(e.target.value)}
          className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600"
        />
        <input
          type="password" placeholder="密码" value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600"
        />
        <button type="submit" className="w-full p-2 rounded bg-blue-600 text-white hover:bg-blue-500">
          注册
        </button>
        {error && <p className="text-red-400 text-sm text-center">{error}</p>}
        <p className="text-gray-500 text-sm text-center">
          已有账号？<Link to="/login" className="text-blue-400">登录</Link>
        </p>
      </form>
    </div>
  );
}
