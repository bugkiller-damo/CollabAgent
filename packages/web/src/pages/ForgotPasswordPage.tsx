import { useState } from "react";
import { Link } from "react-router-dom";
import { apiPost } from "../api/client";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPw, setNewPw] = useState("");
  const [step, setStep] = useState<"email" | "reset">("email");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const handleSendCode = async () => {
    setErr(""); setMsg("");
    if (!email.includes("@")) { setErr("请输入有效邮箱"); return; }
    try {
      const data = await apiPost<{ message: string; devCode?: string }>("/api/auth/forgot-password", { email });
      setMsg(data.devCode ? `验证码（开发模式）: ${data.devCode}` : data.message);
      setStep("reset");
    } catch (e: any) { setErr(e.message || "发送失败"); }
  };

  const handleReset = async () => {
    setErr(""); setMsg("");
    if (newPw.length < 6) { setErr("新密码至少 6 位"); return; }
    try {
      await apiPost("/api/auth/reset-password", { email, code, password: newPw });
      setMsg("密码已重置！去登录吧。");
      setStep("email");
    } catch (e: any) { setErr(e.message || "重置失败"); }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900">
      <div className="bg-gray-800 p-8 rounded-lg w-96 space-y-4">
        <h1 className="text-white text-2xl font-bold text-center">找回密码</h1>

        {step === "email" ? (
          <>
            <input type="email" placeholder="注册邮箱" value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600" />
            <button onClick={handleSendCode}
              className="w-full p-2 rounded bg-blue-600 text-white hover:bg-blue-500">
              发送验证码
            </button>
          </>
        ) : (
          <>
            <input type="text" placeholder="6 位验证码" value={code}
              onChange={e => setCode(e.target.value)}
              maxLength={6} className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600" />
            <input type="password" placeholder="新密码（至少6位）" value={newPw}
              onChange={e => setNewPw(e.target.value)}
              className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600" />
            <button onClick={handleReset}
              className="w-full p-2 rounded bg-green-600 text-white hover:bg-green-500">
              重置密码
            </button>
          </>
        )}

        {msg && <p className="text-green-400 text-sm text-center">{msg}</p>}
        {err && <p className="text-red-400 text-sm text-center">{err}</p>}
        <p className="text-gray-500 text-sm text-center">
          <Link to="/login" className="text-blue-400 hover:underline">返回登录</Link>
        </p>
      </div>
    </div>
  );
}
