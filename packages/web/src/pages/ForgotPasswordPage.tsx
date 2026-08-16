import { useState } from "react";
import { Link } from "react-router-dom";
import { apiPost } from "../api/client";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Input } from "../components/ui/Input";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPw, setNewPw] = useState("");
  const [step, setStep] = useState<"email" | "reset">("email");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSendCode = async () => {
    setErr("");
    setMsg("");
    if (!email.includes("@")) {
      setErr("请输入有效邮箱");
      return;
    }
    setLoading(true);
    try {
      const data = await apiPost<{ message: string; devCode?: string }>("/api/auth/forgot-password", { email });
      setMsg(data.devCode ? `验证码（开发模式）: ${data.devCode}` : data.message);
      setStep("reset");
    } catch (e: any) {
      setErr(e.message || "发送失败");
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async () => {
    setErr("");
    setMsg("");
    if (newPw.length < 6) {
      setErr("新密码至少 6 位");
      return;
    }
    setLoading(true);
    try {
      await apiPost("/api/auth/reset-password", { email, code, password: newPw });
      setMsg("密码已重置！去登录吧。");
      setStep("email");
    } catch (e: any) {
      setErr(e.message || "重置失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4 dark:bg-gray-900">
      <Card padding="lg" className="w-full max-w-sm space-y-5">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">找回密码</h1>
        </div>

        {step === "email" ? (
          <div className="space-y-4">
            <Input type="email" placeholder="注册邮箱" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Button onClick={handleSendCode} loading={loading} className="w-full">
              发送验证码
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <Input
              type="text"
              placeholder="6 位验证码"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={6}
            />
            <Input
              type="password"
              placeholder="新密码（至少6位）"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
            />
            <Button onClick={handleReset} loading={loading} className="w-full">
              重置密码
            </Button>
          </div>
        )}

        {msg && <p className="text-center text-sm text-green-600 dark:text-green-400">{msg}</p>}
        {err && <p className="text-center text-sm text-red-500">{err}</p>}
        <p className="text-center text-sm text-gray-500 dark:text-gray-400">
          <Link to="/login" className="text-blue-500 hover:underline">
            返回登录
          </Link>
        </p>
      </Card>
    </div>
  );
}
