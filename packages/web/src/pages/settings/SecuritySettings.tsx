import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet, apiClient } from "../../api/client";
import { useAuthStore } from "../../stores";

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
  const os = s.includes("windows") ? "Windows" : s.includes("mac") ? "macOS" : s.includes("android") ? "Android" : s.includes("iphone") || s.includes("ipad") ? "iOS" : s.includes("linux") ? "Linux" : "其他";
  const br = s.includes("edg/") ? "Edge" : s.includes("chrome") ? "Chrome" : s.includes("firefox") ? "Firefox" : s.includes("safari") ? "Safari" : "浏览器";
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
  useEffect(() => { load(); }, []);

  const revoke = async (id: string) => {
    try { await apiClient(`/api/auth/sessions/${id}`, { method: "DELETE" }); load(); }
    catch (e: any) { alert(e?.message || "下线失败"); }
  };

  const logoutAll = async () => {
    if (!confirm("将退出所有设备（包括当前），确定？")) return;
    try { await apiClient("/api/auth/logout-all", { method: "POST" }); logout(); navigate("/login"); }
    catch (e: any) { alert(e?.message || "操作失败"); }
  };

  const exportData = async () => {
    try {
      const data = await apiGet<any>("/api/auth/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `collabagent-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) { alert(e?.message || "导出失败"); }
  };

  const deactivate = async () => {
    if (confirmText !== "注销") { alert('请在输入框中输入「注销」以确认'); return; }
    if (!pwd) { alert("请输入密码确认"); return; }
    setBusy(true);
    try {
      await apiClient("/api/auth/deactivate", { method: "POST", body: { password: pwd } });
      alert("账户已注销");
      logout();
      navigate("/login");
    } catch (e: any) {
      alert(e?.message || "注销失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-8">
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-gray-900 dark:text-white font-bold">登录设备</h3>
          <button onClick={logoutAll} className="text-xs text-red-500 hover:underline">退出所有设备</button>
        </div>
        {loading ? (
          <p className="text-gray-400 text-sm">加载中…</p>
        ) : sessions.length === 0 ? (
          <p className="text-gray-400 text-sm">没有活跃会话</p>
        ) : (
          <div className="space-y-2">
            {sessions.map((s) => (
              <div key={s.id} className="flex items-center justify-between p-3 rounded border border-gray-200 dark:border-gray-700">
                <div className="min-w-0">
                  <div className="text-sm text-gray-900 dark:text-white flex items-center gap-2">
                    {deviceLabel(s.user_agent)}
                    {s.current && <span className="text-[11px] px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-300">当前设备</span>}
                  </div>
                  <div className="text-xs text-gray-500 truncate">
                    {s.ip || "—"} · 最近活跃 {new Date(s.last_seen_at).toLocaleString("zh-CN")}
                  </div>
                </div>
                {!s.current && (
                  <button onClick={() => revoke(s.id)} className="text-xs text-red-500 hover:underline shrink-0 ml-3">下线</button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 className="text-gray-900 dark:text-white font-bold mb-3">数据导出</h3>
        <p className="text-gray-500 text-sm mb-2">导出你的资料、消息、频道成员关系、提醒与会话为 JSON 文件。</p>
        <button onClick={exportData} className="px-3 py-1.5 rounded text-sm bg-blue-600 text-white hover:bg-blue-500">导出我的数据</button>
      </section>

      <section className="border border-red-300 dark:border-red-900/50 rounded p-4">
        <h3 className="text-red-600 dark:text-red-400 font-bold mb-2">注销账户</h3>
        <p className="text-gray-500 text-sm mb-3">注销后将无法登录，个人信息会被清除（历史消息保留）。此操作不可轻易撤销。</p>
        <div className="space-y-2 max-w-sm">
          <input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} placeholder="输入密码确认"
            className="w-full p-2 rounded text-sm bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600" />
          <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder='输入「注销」二字确认'
            className="w-full p-2 rounded text-sm bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600" />
          <button onClick={deactivate} disabled={busy}
            className="px-3 py-1.5 rounded text-sm bg-red-600 text-white hover:bg-red-500 disabled:opacity-50">
            {busy ? "处理中…" : "确认注销账户"}
          </button>
        </div>
      </section>
    </div>
  );
}
