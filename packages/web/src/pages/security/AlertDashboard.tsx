import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../../api/client";

interface Alert { id: string; severity: string; title: string; detail: string; status: string; created_at: string }
interface Rule { id: string; name: string; severity: string; metric: string; enabled: boolean }

export function AlertDashboard() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"alerts" | "rules">("alerts");

  const la = async () => { try { const d = await apiGet<{ alerts: Alert[] }>("/api/v1/alerts/history"); setAlerts(d.alerts || []); } catch {} };
  const lr = async () => { try { const d = await apiGet<{ rules: Rule[] }>("/api/v1/alerts/rules"); setRules(d.rules || []); } catch {} };
  useEffect(() => { Promise.all([la(), lr()]).then(() => setLoading(false)); }, []);
  const ack = async (id: string) => { try { await apiPost(`/api/v1/alerts/${id}/acknowledge`); await la(); } catch {} };

  const sc = (s: string) => s === "CRITICAL" ? "bg-red-100 text-red-700" : s === "HIGH" ? "bg-orange-100 text-orange-700" : s === "MEDIUM" ? "bg-yellow-100 text-yellow-700" : "bg-blue-100 text-blue-700";

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-gray-900 dark:text-white text-lg font-bold">告警中心</h1>
      <div className="flex gap-2 border-b pb-2">
        <button onClick={() => setTab("alerts")} className={"px-3 py-1 text-sm rounded " + (tab === "alerts" ? "bg-gray-200 dark:bg-gray-700" : "")}>告警 ({alerts.filter(a => a.status === "unacknowledged").length})</button>
        <button onClick={() => setTab("rules")} className={"px-3 py-1 text-sm rounded " + (tab === "rules" ? "bg-gray-200 dark:bg-gray-700" : "")}>规则 ({rules.length})</button>
      </div>
      {loading ? <p className="text-gray-400 text-sm">加载中...</p> : tab === "alerts" ? (
        alerts.length === 0 ? <p className="text-gray-400 text-sm text-center py-8">暂无告警</p> : alerts.map((a) => (<div key={a.id} className={"p-3 rounded border mb-2 " + (a.status === "unacknowledged" ? "bg-red-50 dark:bg-red-900/20 border-red-200" : "bg-white dark:bg-gray-800")}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2"><span className={"text-xs px-1.5 py-0.5 rounded " + sc(a.severity)}>{a.severity}</span><span className="text-gray-900 dark:text-white font-medium text-sm">{a.title}</span><span className={"text-xs " + (a.status === "unacknowledged" ? "text-red-500" : "text-gray-400")}>{a.status}</span></div>
            <div className="flex items-center gap-2"><span className="text-gray-400 text-xs">{new Date(a.created_at).toLocaleString()}</span>{a.status === "unacknowledged" && <button onClick={() => ack(a.id)} className="px-2 py-0.5 bg-blue-500 text-white rounded text-xs">确认</button>}</div>
          </div>
          {a.detail && <p className="text-xs text-gray-500 mt-1">{a.detail}</p>}
        </div>))
      ) : (
        rules.length === 0 ? <p className="text-gray-400 text-sm text-center py-8">暂无规则</p> : rules.map((r) => (<div key={r.id} className="bg-white dark:bg-gray-800 p-3 rounded border mb-2">
          <div className="flex items-center gap-2"><span className={"text-xs px-1.5 py-0.5 rounded " + sc(r.severity)}>{r.severity}</span><span className="text-gray-900 dark:text-white font-medium text-sm">{r.name}</span><span className="text-gray-400 text-xs">{r.metric}</span><span className={"text-xs px-1.5 py-0.5 rounded " + (r.enabled ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600")}>{r.enabled ? "启用" : "禁用"}</span></div>
        </div>))
      )}
    </div>
  );
}
