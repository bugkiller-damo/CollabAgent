import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../../api/client";

interface Task { id: string; task_type: string; task_name: string; status: string; priority: string; progress_percent: number; total_targets: number; completed_targets: number; findings_summary: string; created_at: string }

export function TaskManagement() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<string | null>(null);
  const [detailData, setDetailData] = useState<any>(null);
  const [createMode, setCreateMode] = useState(false);
  const [taskType, setTaskType] = useState("vulnerability_scan"); const [taskName, setTaskName] = useState(""); const [targets, setTargets] = useState(""); const [priority, setPriority] = useState("MEDIUM");

  const load = async () => { setLoading(true); try { const d = await apiGet<{ tasks: Task[] }>("/api/v1/tasks"); setTasks(d.tasks || []); } catch {} setLoading(false); };
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);

  const createTask = async () => { if (!taskName || !targets) return; await apiPost("/api/v1/tasks", { taskType, taskName, targets: targets.split("\n").filter(Boolean).map((t: string) => ({ target: t.trim(), assetLevel: "general" })), scanProfile: "standard", priority }); setCreateMode(false); setTaskName(""); setTargets(""); await load(); };

  const showDetail = async (id: string) => { if (detail === id) { setDetail(null); setDetailData(null); return; } setDetail(id); setDetailData(null); try { const r = await apiGet<any>(`/api/v1/tasks/${id}`); setDetailData(r.task); } catch {} };

  const sc = (s: string) => s === "CRITICAL" ? "bg-red-100 text-red-700" : s === "HIGH" ? "bg-orange-100 text-orange-700" : s === "MEDIUM" ? "bg-yellow-100 text-yellow-700" : "bg-gray-100 text-gray-600";
  const st = (s: string) => s === "completed" ? "text-green-600" : s === "running" || s === "queued" ? "text-blue-600" : s === "failed" ? "text-red-600" : "text-gray-500";

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-gray-900 dark:text-white text-lg font-bold">渗透任务</h1>
        <button onClick={() => setCreateMode(true)} className="px-3 py-1.5 bg-blue-500 text-white rounded text-sm">+ 新建任务</button>
      </div>
      {createMode && (
        <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded border space-y-2">
          <input placeholder="任务名称 *" value={taskName} onChange={(e) => setTaskName(e.target.value)} className="w-full px-2 py-1 border rounded text-sm" />
          <select value={taskType} onChange={(e) => setTaskType(e.target.value)} className="w-full px-2 py-1 border rounded text-sm">
            <option value="vulnerability_scan">漏洞扫描</option><option value="full_penetration">全量渗透</option><option value="quick_scan">快速扫描</option><option value="re_test">复测</option>
          </select>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} className="w-full px-2 py-1 border rounded text-sm">
            <option value="LOW">低</option><option value="MEDIUM">中</option><option value="HIGH">高</option><option value="CRITICAL">紧急</option>
          </select>
          <textarea placeholder="目标（每行一个 IP/域名）" value={targets} onChange={(e) => setTargets(e.target.value)} rows={3} className="w-full px-2 py-1 border rounded text-sm" />
          <div className="flex gap-2"><button onClick={createTask} className="px-3 py-1 bg-blue-500 text-white rounded text-sm">提交</button><button onClick={() => setCreateMode(false)} className="px-3 py-1 bg-gray-200 rounded text-sm">取消</button></div>
        </div>
      )}
      {loading ? <p className="text-gray-400 text-sm">加载中...</p> : tasks.length === 0 ? <p className="text-gray-400 text-sm text-center py-8">暂无任务</p> : (
        <div className="space-y-2">
          {tasks.map((t) => { const f = (() => { try { return JSON.parse(t.findings_summary || "{}"); } catch { return {}; } })(); return (
            <div key={t.id} onClick={() => showDetail(t.id)} className="bg-white dark:bg-gray-800 p-3 rounded border cursor-pointer hover:border-blue-300">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={"text-sm " + st(t.status)}>●</span>
                  <span className="text-gray-900 dark:text-white font-medium text-sm">{t.task_name}</span>
                  <span className={"text-xs px-1.5 py-0.5 rounded " + sc(t.priority)}>{t.priority}</span>
                  {f.critical > 0 && <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded">{f.critical} C</span>}
                  {f.high > 0 && <span className="text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded">{f.high} H</span>}
                </div>
                <span className="text-gray-400 text-xs">{t.progress_percent}%</span>
              </div>
              {detail === t.id && (
                <div className="mt-2 pt-2 border-t space-y-2">
                  <div className="flex gap-2 text-xs text-gray-500">
                    <span>类型：{t.task_type}</span><span>目标：{t.total_targets}</span><span>完成：{t.completed_targets}</span><span>创建：{new Date(t.created_at).toLocaleString()}</span>
                  </div>
                  {detailData && (<div className="text-xs text-gray-600 dark:text-gray-400 space-y-1">
                    <p>状态：{detailData.status} | 并发：{detailData.max_concurrency} | 超时：{detailData.timeout_seconds}s</p>
                    <p>扫描配置：{detailData.scan_profile}</p>
                    {detailData.targets && <p>目标：{JSON.parse(detailData.targets).map((x: any) => x.target || x.ip).join(", ")}</p>}
                  </div>)}
                </div>
              )}
            </div>); })}
        </div>
      )}
    </div>
  );
}
