import { useEffect, useState } from "react";
import { apiGet, apiPost, apiClient } from "../../api/client";

interface Case { id: string; title: string; cve_id: string; cvss_score: string; severity: string; vuln_type: string; status: string; created_at: string; remediation_summary: string }

export function CaseManagement() {
  const [cases, setCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Case | null>(null);
  const [detailData, setDetailData] = useState<any>(null);
  const [search, setSearch] = useState("");
  const [sevFilter, setSevFilter] = useState("");

  const load = async () => { setLoading(true); try { const d = await apiGet<{ cases: Case[] }>("/api/v1/cases"); setCases(d.cases || []); } catch {} setLoading(false); };
  useEffect(() => { load(); }, []);

  const doSearch = async () => { const p: Record<string, string> = {}; if (search) p.q = search; if (sevFilter) p.severity = sevFilter; try { const d = await apiGet<{ cases: Case[] }>("/api/v1/cases", p); setCases(d.cases || []); } catch {} };

  const showDetail = async (c: Case) => { if (detail?.id === c.id) { setDetail(null); setDetailData(null); return; } setDetail(c); try { const r = await apiGet<any>(`/api/v1/cases/${c.id}`); setDetailData(r.case); } catch {} };

  const approve = async (id: string) => { try { await apiClient(`/api/v1/cases/${id}/status`, { method: "PUT", body: { action: "approve" } }); await load(); } catch {} };

  const sc = (s: string) => s === "CRITICAL" ? "bg-red-100 text-red-700" : s === "HIGH" ? "bg-orange-100 text-orange-700" : s === "MEDIUM" ? "bg-yellow-100 text-yellow-700" : "bg-gray-100 text-gray-600";

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-gray-900 dark:text-white text-lg font-bold">病例库</h1>
      <div className="flex gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && doSearch()} placeholder="搜索漏洞 / CVE..." className="flex-1 px-3 py-1.5 border rounded text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
        <select value={sevFilter} onChange={(e) => { setSevFilter(e.target.value); setTimeout(doSearch, 0); }} className="px-2 py-1.5 border rounded text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white">
          <option value="">全部</option><option value="CRITICAL">CRITICAL</option><option value="HIGH">HIGH</option><option value="MEDIUM">MEDIUM</option><option value="LOW">LOW</option>
        </select>
      </div>
      {loading ? <p className="text-gray-400 text-sm">加载中...</p> : cases.length === 0 ? <p className="text-gray-400 text-sm text-center py-8">暂无病例</p> : (
        <div className="space-y-2">
          {cases.map((c) => (<div key={c.id} onClick={() => showDetail(c)} className="bg-white dark:bg-gray-800 p-3 rounded border cursor-pointer hover:border-blue-300">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={"text-xs px-1.5 py-0.5 rounded " + sc(c.severity)}>{c.severity}</span>
                <span className="text-gray-900 dark:text-white font-medium text-sm">{c.title}</span>
                {c.cve_id && <span className="text-gray-400 text-xs">{c.cve_id}</span>}
                <span className={"text-xs px-1.5 py-0.5 rounded " + (c.status === "published" ? "bg-green-100 text-green-700" : c.status === "pending_review" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600")}>{c.status}</span>
              </div>
              <span className="text-gray-500 text-sm font-mono">{c.cvss_score}</span>
            </div>
            {detail?.id === c.id && detailData && (<div className="mt-2 pt-2 border-t space-y-1 text-xs text-gray-600 dark:text-gray-400">
              <p><span className="font-medium">类型：</span>{detailData.vuln_type} | <span className="font-medium">CVSS：</span>{detailData.cvss_score}</p>
              <p><span className="font-medium">攻击入口：</span>{detailData.entry_point || "-"} | <span className="font-medium">影响：</span>{detailData.final_impact || "-"}</p>
              <p><span className="font-medium">修复建议：</span>{detailData.remediation_immediate || "-"}</p>
              <p><span className="font-medium">标签：</span>{detailData.tags?.join(", ") || "-"} | <span className="font-medium">版本：</span>{detailData.version}</p>
              {c.status === "pending_review" && <button onClick={(e) => { e.stopPropagation(); approve(c.id); }} className="px-2 py-1 bg-green-500 text-white rounded text-xs mt-1">审核通过</button>}
            </div>)}
          </div>))}
        </div>
      )}
    </div>
  );
}
