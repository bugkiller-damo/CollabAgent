import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../../api/client";

interface Asset { id: string; ip: string; hostname: string; os: string; open_ports: number[]; services: string; asset_level: string; tags: string[]; status: string; last_seen_at: string }

export function AssetManagement() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [ip, setIp] = useState(""); const [hostname, setHostname] = useState(""); const [os, setOs] = useState(""); const [level, setLevel] = useState("general"); const [ports, setPorts] = useState("80,443"); const [tags, setTags] = useState("");
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<Asset | null>(null);

  const load = async () => { setLoading(true); try { const d = await apiGet<{ assets: Asset[] }>("/api/v1/assets"); setAssets(d.assets || []); } catch {} setLoading(false); };
  useEffect(() => { load(); }, []);

  const create = async () => { if (!ip) return; await apiPost("/api/v1/assets", { subsidiaryId: "a319db9b-6f52-43e6-b6e2-563e75860636", ip, hostname, os, openPorts: ports.split(",").map(Number).filter(Boolean), assetLevel: level, tags: tags ? tags.split(",").map((t) => t.trim()) : [] }); setShowCreate(false); setIp(""); setHostname(""); setOs(""); setPorts("80,443"); setTags(""); setLevel("general"); await load(); };

  const searchAssets = async () => { if (!search) return load(); try { const d = await apiGet<{ assets: Asset[] }>("/api/v1/assets", { q: search }); setAssets(d.assets || []); } catch {} };

  const svc = (a: Asset) => { try { return JSON.parse(a.services || "[]").map((s: any) => `${s.service}${s.version ? ":" + s.version : ""}`).join(", "); } catch { return ""; } };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-gray-900 dark:text-white text-lg font-bold">资产管理</h1>
        <button onClick={() => setShowCreate(true)} className="px-3 py-1.5 bg-blue-500 text-white rounded text-sm hover:bg-blue-600">+ 新增资产</button>
      </div>
      <div className="flex gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && searchAssets()} placeholder="搜索 IP / 主机名..." className="flex-1 px-3 py-1.5 border rounded text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
        <button onClick={searchAssets} className="px-3 py-1.5 bg-gray-200 dark:bg-gray-700 rounded text-sm">搜索</button>
      </div>
      {showCreate && (
        <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded border space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <input placeholder="IP *" value={ip} onChange={(e) => setIp(e.target.value)} className="px-2 py-1 border rounded text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
            <input placeholder="主机名" value={hostname} onChange={(e) => setHostname(e.target.value)} className="px-2 py-1 border rounded text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
            <input placeholder="OS" value={os} onChange={(e) => setOs(e.target.value)} className="px-2 py-1 border rounded text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
            <input placeholder="端口 (80,443)" value={ports} onChange={(e) => setPorts(e.target.value)} className="px-2 py-1 border rounded text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
            <input placeholder="标签" value={tags} onChange={(e) => setTags(e.target.value)} className="px-2 py-1 border rounded text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
            <select value={level} onChange={(e) => setLevel(e.target.value)} className="px-2 py-1 border rounded text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white">
              <option value="general">一般</option><option value="important">重要</option><option value="core">核心</option>
            </select>
          </div>
          <div className="flex gap-2">
            <button onClick={create} className="px-3 py-1 bg-blue-500 text-white rounded text-sm">创建</button>
            <button onClick={() => setShowCreate(false)} className="px-3 py-1 bg-gray-200 dark:bg-gray-700 rounded text-sm">取消</button>
          </div>
        </div>
      )}
      {loading ? <p className="text-gray-400 text-sm">加载中...</p> : assets.length === 0 ? <p className="text-gray-400 text-sm text-center py-8">暂无资产</p> : (
        <div className="space-y-2">
          {assets.map((a) => (
            <div key={a.id} onClick={() => setDetail(detail?.id === a.id ? null : a)} className="bg-white dark:bg-gray-800 p-3 rounded border cursor-pointer hover:border-blue-300">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-gray-900 dark:text-white font-mono text-sm">{a.ip}</span>
                  {a.hostname && <span className="text-gray-500 text-sm ml-2">{a.hostname}</span>}
                  <span className={"ml-2 text-xs px-1.5 py-0.5 rounded " + (a.asset_level === "core" ? "bg-red-100 text-red-700" : a.asset_level === "important" ? "bg-yellow-100 text-yellow-700" : "bg-gray-100 text-gray-600")}>{a.asset_level}</span>
                  <span className={"ml-1 text-xs " + (a.status === "active" ? "text-green-500" : "text-gray-400")}>●</span>
                </div>
                <span className="text-gray-400 text-xs">{a.open_ports?.length || 0} 端口</span>
              </div>
              {detail?.id === a.id && (
                <div className="mt-2 pt-2 border-t text-sm text-gray-600 dark:text-gray-400 space-y-1">
                  <p><span className="font-medium">OS：</span>{a.os || "-"}</p>
                  <p><span className="font-medium">服务：</span>{svc(a) || "-"}</p>
                  <p><span className="font-medium">标签：</span>{a.tags?.join(", ") || "-"}</p>
                  <p><span className="font-medium">最后活跃：</span>{new Date(a.last_seen_at).toLocaleString()}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
