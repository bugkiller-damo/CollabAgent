import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiClient, apiGet } from "../../api/client";
import { PageHeader } from "../../components/layout/PageHeader";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { useAuthStore } from "../../stores";
import { toast } from "../../stores/toastStore";

interface Session {
  id: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_seen_at: string;
  current: boolean;
}

function deviceLabel(ua: string | null): string {
  if (!ua) return "未知设备";
  const s = ua.toLowerCase();
  const os = s.includes("windows")
    ? "Windows"
    : s.includes("mac")
      ? "macOS"
      : s.includes("android")
        ? "Android"
        : s.includes("iphone") || s.includes("ipad")
          ? "iOS"
          : s.includes("linux")
            ? "Linux"
            : "其他";
  const br = s.includes("edg/")
    ? "Edge"
    : s.includes("chrome")
      ? "Chrome"
      : s.includes("firefox")
        ? "Firefox"
        : s.includes("safari")
          ? "Safari"
          : "浏览器";
  return `${br} · ${os}`;
}

export function SecuritySettings() {
  const navigate = useNavigate();
  const logout = useAuthStore((s) => s.logout);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [pwd, setPwd] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoading(true);
    apiGet<{ sessions: Session[] }>("/api/auth/sessions")
      .then((d) => setSessions(d.sessions || []))
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, []);

  const revoke = async (id: string) => {
    try {
      await apiClient(`/api/auth/sessions/${id}`, { method: "DELETE" });
      load();
    } catch (e: any) {
      toast.error(e?.message || "下线失败");
    }
  };

  const logoutAll = async () => {
    if (!confirm("将退出所有设备（包括当前），确定？")) return;
    try {
      await apiClient("/api/auth/logout-all", { method: "POST" });
      logout();
      navigate("/login");
    } catch (e: any) {
      toast.error(e?.message || "操作失败");
    }
  };

  const exportData = async () => {
    try {
      const data = await apiGet<any>("/api/profile/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `collabagent-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast.error(e?.message || "导出失败");
    }
  };

  const deactivate = async () => {
    if (confirmText !== "注销") {
      toast.warning("请在输入框中输入「注销」以确认");
      return;
    }
    if (!pwd) {
      toast.warning("请输入密码确认");
      return;
    }
    setBusy(true);
    try {
      await apiClient("/api/profile/deactivate", { method: "POST", body: { password: pwd } });
      toast.success("账户已注销");
      logout();
      navigate("/login");
    } catch (e: any) {
      toast.error(e?.message || "注销失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full space-y-8">
      <PageHeader title="安全与账户" backTo="/settings" />

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-bold text-gray-900 dark:text-white">登录设备</h3>
          <Button onClick={logoutAll} variant="ghost" size="sm" className="text-red-500 hover:text-red-600">
            退出所有设备
          </Button>
        </div>
        {loading ? (
          <p className="text-sm text-gray-400">加载中…</p>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-gray-400">没有活跃会话</p>
        ) : (
          <div className="space-y-2">
            {sessions.map((s) => (
              <Card key={s.id} padding="sm" className="flex items-center justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm text-gray-900 dark:text-white">
                    {deviceLabel(s.user_agent)}
                    {s.current && (
                      <span className="rounded bg-green-100 px-1.5 py-0.5 text-[11px] text-green-600 dark:bg-green-900/40 dark:text-green-300">
                        当前设备
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs text-gray-500">
                    {s.ip || "—"} · 最近活跃 {new Date(s.last_seen_at).toLocaleString("zh-CN")}
                  </div>
                </div>
                {!s.current && (
                  <Button
                    onClick={() => revoke(s.id)}
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-red-500 hover:text-red-600"
                  >
                    下线
                  </Button>
                )}
              </Card>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-3 font-bold text-gray-900 dark:text-white">数据导出</h3>
        <p className="mb-3 text-sm text-gray-500">导出你的资料、消息、频道成员关系、提醒与会话为 JSON 文件。</p>
        <Button onClick={exportData} size="sm">
          导出我的数据
        </Button>
      </section>

      <section className="rounded-lg border border-red-300 p-4 dark:border-red-900/50">
        <h3 className="mb-2 font-bold text-red-600 dark:text-red-400">注销账户</h3>
        <p className="mb-3 text-sm text-gray-500">
          注销后将无法登录，个人信息会被清除（历史消息保留）。此操作不可轻易撤销。
        </p>
        <div className="max-w-sm space-y-2">
          <Input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} placeholder="输入密码确认" />
          <Input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="输入「注销」二字确认"
          />
          <Button onClick={deactivate} disabled={busy} variant="danger" size="sm">
            {busy ? "处理中…" : "确认注销账户"}
          </Button>
        </div>
      </section>
    </div>
  );
}
