import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../../api/client";

interface Task { id: string; task_type: string; task_name: string; status: string; priority: string; progress_percent: number; total_targets: number; completed_targets: number; findings_summary: string; created_at: string }
interface Vuln { target: string; title: string; cvss_score: string; severity: string; vuln_type: string; attack_path: string; remediation: string }

const inp = "w-full px-2 py-1 border rounded text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white";
const sc = (s: string) => s === "CRITICAL" ? "bg-red-100 text-red-700" : s === "HIGH" ? "bg-orange-100 text-orange-700" : s === "MEDIUM" ? "bg-yellow-100 text-yellow-700" : "bg-gray-100 text-gray-600";
const st = (s: string) => s === "completed" ? "text-green-600" : s === "running" || s === "queued" ? "text-blue-600" : s === "failed" ? "text-red-600" : "text-gray-500";

export function TaskManagement() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<string | null>(null);
  const [results, setResults] = useState<Vuln[] | null>(null);
  const [graph, setGraph] = useState<any>(null);
  const [createMode, setCreateMode] = useState(false);
  const [taskType, setTaskType] = useState("vulnerability_scan"); const [taskName, setTaskName] = useState(""); const [targets, setTargets] = useState(""); const [priority, setPriority] = useState("MEDIUM");

  const load = async () => { setLoading(true); try { const d = await apiGet<{ tasks: Task[] }>("/api/v1/tasks"); setTasks(d.tasks || []); } catch {} setLoading(false); };
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);

  const createTask = async () => { if (!taskName || !targets) return; await apiPost("/api/v1/tasks", { taskType, taskName, targets: targets.split("\n").filter(Boolean).map((t: string) => ({ target: t.trim(), assetLevel: "general" })), scanProfile: "standard", priority }); setCreateMode(false); setTaskName(""); setTargets(""); await load(); };

  const showDetail = async (id: string) => {
    if (detail === id) { setDetail(null); setResults(null); setGraph(null); return; }
    setDetail(id); setResults(null); setGraph(null);
    try { const r = await apiGet<any>(`/api/v1/tasks/${id}/results`); setResults((r.vulnerabilities || []).map((v: any) => ({ ...v, attack_path: typeof v.attack_path === "string" ? v.attack_path : JSON.stringify(v.attack_path || "{}"), remediation: typeof v.remediation === "string" ? v.remediation : JSON.stringify(v.remediation || "{}") }))); } catch {}
    try { const g = await apiGet<any>(`/api/v1/tasks/${id}/attack-graph`); const nodes = typeof g.nodes === "string" ? JSON.parse(g.nodes || "[]") : (g.nodes || []); const edges = typeof g.edges === "string" ? JSON.parse(g.edges || "[]") : (g.edges || []); setGraph({ ...g, nodes, edges }); } catch {}
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-gray-900 dark:text-white text-lg font-bold">渗透任务</h1>
        <button onClick={() => setCreateMode(true)} className="px-3 py-1.5 bg-blue-500 text-white rounded text-sm">+ 新建任务</button>
      </div>
      {createMode && (
        <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded border space-y-2">
          <input placeholder="任务名称 *" value={taskName} onChange={(e) => setTaskName(e.target.value)} className={inp} />
          <select value={taskType} onChange={(e) => setTaskType(e.target.value)} className={inp}>
            <option value="vulnerability_scan">漏洞扫描</option><option value="full_penetration">全量渗透</option><option value="quick_scan">快速扫描</option><option value="re_test">复测</option></select>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} className={inp}>
            <option value="LOW">低</option><option value="MEDIUM">中</option><option value="HIGH">高</option><option value="CRITICAL">紧急</option></select>
          <textarea placeholder="目标（每行一个 IP/域名）" value={targets} onChange={(e) => setTargets(e.target.value)} rows={3} className={inp} />
          <div className="flex gap-2"><button onClick={createTask} className="px-3 py-1 bg-blue-500 text-white rounded text-sm">提交</button><button onClick={() => setCreateMode(false)} className="px-3 py-1 bg-gray-200 dark:bg-gray-700 rounded text-sm">取消</button></div>
        </div>
      )}
      {loading ? <p className="text-gray-400 text-sm">加载中...</p> : tasks.length === 0 ? <p className="text-gray-400 text-sm text-center py-8">暂无任务</p> : (<div className="space-y-2">
        {tasks.map((t) => { const f = (() => { try { return JSON.parse(t.findings_summary || "{}"); } catch { return {}; } })(); return (
          <div key={t.id} className="bg-white dark:bg-gray-800 p-3 rounded border">
            <div onClick={() => showDetail(t.id)} className="flex items-center justify-between cursor-pointer hover:opacity-80">
              <div className="flex items-center gap-2">
                <span className={"text-sm " + st(t.status)}>●</span>
                <span className="text-gray-900 dark:text-white font-medium text-sm">{t.task_name}</span>
                <span className={"text-xs px-1.5 py-0.5 rounded " + sc(t.priority)}>{t.priority}</span>
                {f.critical > 0 && <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded">{f.critical} C</span>}
                {f.high > 0 && <span className="text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded">{f.high} H</span>}
              </div>
              <span className="text-gray-400 text-xs">{t.progress_percent}%</span>
            </div>
            {detail === t.id && (<div className="mt-2 pt-2 border-t space-y-2">
              <div className="flex gap-2 text-xs text-gray-500">
                <span>类型：{t.task_type}</span><span>目标：{t.total_targets}</span><span>创建：{new Date(t.created_at).toLocaleString()}</span>
              </div>
              {results && results.length > 0 && (<div>
                <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">漏洞发现 ({results.length})</p>
                {results.map((v, i) => (<div key={i} className="text-xs text-gray-600 dark:text-gray-400 border-l-2 border-gray-300 dark:border-gray-600 pl-2 py-1 mb-1">
                  <div className="flex items-center gap-1">
                    <span className={"text-xs px-1 py-0.5 rounded " + sc(v.severity)}>{v.severity}</span>
                    <span className="font-medium text-gray-900 dark:text-white">{v.title}</span>
                    <span className="text-gray-400">{v.cvss_score}</span>
                  </div>
                  <p className="mt-0.5">目标：{v.target} | 类型：{v.vuln_type}</p>
                </div>))}
              </div>)}
              {graph && graph.nodes?.length > 0 && (<div>
                <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">攻击图</p>
                <div className="flex flex-wrap gap-2">
                  {graph.nodes.map((n: any, i: number) => (<div key={i} className={"flex items-center gap-1 px-2 py-1 rounded text-xs border " + (n.status === "breached" ? "bg-red-100 border-red-300 text-red-700" : "bg-green-100 border-green-300 text-green-700")}>
                    <span>●</span><span>{n.ip}</span><span className="text-gray-400">({n.status})</span>
                  </div>))}
                </div>
                {graph.edges?.length > 0 && <p className="text-xs text-gray-400 mt-1">路径：{graph.edges.map((e: any) => `${e.from}→${e.to}`).join("、")}</p>}
              </div>)}
            </div>)}
          </div>); })}
      </div>)}
    </div>
  );
}
