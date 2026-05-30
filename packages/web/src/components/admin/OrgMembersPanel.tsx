import { useEffect, useState, useCallback } from "react";
import { apiGet, apiClient } from "../../api/client";

interface Org { id: string; name: string; personal: boolean; role: string; memberCount: number; agentCount: number; }
interface Member { user_id: string; role: string; handle: string; display_name?: string; }

// 管理「我的私有空间」的协作成员：被加进来的人能看到我创建的 Agent。
export function OrgMembersPanel() {
  const [org, setOrg] = useState<Org | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invite, setInvite] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const loadMembers = useCallback((orgId: string) => {
    apiGet<{ members: Member[] }>(`/api/orgs/${orgId}/members`)
      .then((d) => setMembers(d.members || []))
      .catch(() => {});
  }, []);

  const loadOrg = useCallback(async () => {
    try {
      const d = await apiGet<{ orgs: Org[] }>("/api/orgs");
      const personal = (d.orgs || []).find((o) => o.personal) || null;
      setOrg(personal);
      if (personal) loadMembers(personal.id);
    } catch { /* ignore */ }
  }, [loadMembers]);

  useEffect(() => { loadOrg(); }, [loadOrg]);

  const doInvite = async () => {
    const h = invite.trim();
    if (!h || !org) return;
    setBusy(true); setMsg("");
    try {
      await apiClient(`/api/orgs/${org.id}/members`, { method: "POST", body: { handle: h } });
      setInvite(""); setMsg("已加入"); loadMembers(org.id);
    } catch (err: any) {
      setMsg(err?.message === "user not found" ? "用户不存在" : (err?.message || "邀请失败"));
    } finally { setBusy(false); }
  };

  const removeMember = async (m: Member) => {
    if (!org || m.role === "owner") return;
    try {
      await apiClient(`/api/orgs/${org.id}/members/${m.user_id}`, { method: "DELETE" });
      loadMembers(org.id);
    } catch (err: any) { alert(err?.message || "移除失败"); }
  };

  if (!org) return null;

  return (
    <div className="bg-gray-100 dark:bg-gray-800 rounded-lg p-4 space-y-3">
      <div>
        <h3 className="text-gray-900 dark:text-white font-semibold">协作空间「{org.name}」</h3>
        <p className="text-gray-500 text-xs mt-0.5">加入这里的成员能看到你在此空间创建的 Agent（共 {org.agentCount} 个）。新建 Agent 默认进入这里、仅你可见。</p>
      </div>
      <div className="flex gap-2">
        <input value={invite} onChange={(e) => setInvite(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") doInvite(); }}
          placeholder="输入用户名邀请协作者"
          className="flex-1 p-2 rounded text-sm bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600" />
        <button onClick={doInvite} disabled={busy || !invite.trim()}
          className="px-3 rounded text-sm bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50">邀请</button>
      </div>
      {msg && <p className={"text-xs " + (msg === "已加入" ? "text-green-500" : "text-red-400")}>{msg}</p>}
      <div className="flex flex-wrap gap-2">
        {members.map((m) => (
          <span key={m.user_id} className="group inline-flex items-center gap-1.5 text-sm bg-gray-200 dark:bg-gray-700 rounded-full pl-2.5 pr-1.5 py-1 text-gray-700 dark:text-gray-200">
            @{m.handle}{m.role === "owner" && <span className="text-[10px] text-blue-500">(你)</span>}
            {m.role !== "owner" && (
              <button onClick={() => removeMember(m)} title="移除"
                className="text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100">✕</button>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}
