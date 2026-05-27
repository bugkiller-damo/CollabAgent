import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { apiPost } from "../api/client";
import { useAuthStore } from "../stores/authStore";

export function RegisterPage() {
  const [handle, setHandle] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPwd) {
      setError("两次密码不一致");
      return;
    }
    if (password.length < 6) {
      setError("密码至少 6 位");
      return;
    }
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      setError("密码需包含字母和数字");
      return;
    }

    try {
      const data = await apiPost<{ token: string; user: { id: string; handle: string; displayName: string } }>(
        "/api/auth/register",
        { handle, password, email, displayName: handle }
      );
      localStorage.setItem("auth_token", data.token);
      useAuthStore.setState({ token: data.token, user: data.user as any, isAuthenticated: true });
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
          required minLength={2} maxLength={20}
          className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600 focus:outline-none focus:border-blue-500"
        />
        <input
          type="email" placeholder="邮箱（用于找回密码）" value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600 focus:outline-none focus:border-blue-500"
        />
        <input
          type="password" placeholder="密码（至少6位，含字母和数字）" value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600 focus:outline-none focus:border-blue-500"
        />
        <input
          type="password" placeholder="确认密码" value={confirmPwd}
          onChange={(e) => setConfirmPwd(e.target.value)}
          className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600 focus:outline-none focus:border-blue-500"
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
