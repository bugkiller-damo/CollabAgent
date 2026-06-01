import { useEffect, useState, useCallback } from "react";
import { apiGet, apiPost, apiClient } from "../../api/client";

interface Org { id: string; name: string; personal: boolean; role: string; memberCount: number; agentCount: number; }
interface Member { user_id: string; role: string; handle: string; display_name?: string; }
interface Invite { token: string; role: string; max_uses: number | null; uses: number; expires_at: string | null; revoked_at: string | null; }

// 工作区成员总览：谁在这个工作区、各自什么角色，外加邀请链接管理。仅 owner 可改。
export function WorkspaceMembers() {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [org, setOrg] = useState<Org | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState("");

  const isOwner = org?.role === "owner";

  const loadMembers = useCallback((orgId: string) => {
    apiGet<{ members: Member[] }>(`/api/orgs/${orgId}/members`).then((d) => setMembers(d.members || [])).catch(() => {});
  }, []);
  const loadInvites = useCallback((orgId: string) => {
    apiGet<{ invites: Invite[] }>(`/api/orgs/${orgId}/invites`).then((d) => setInvites(d.invites || [])).catch(() => setInvites([]));
  }, []);

  useEffect(() => {
    apiGet<{ orgs: Org[] }>("/api/orgs").then((d) => {
      const list = d.orgs || [];
      setOrgs(list);
      const def = list.find((o) => !o.personal) || list[0] || null;
      setOrg(def);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!org) return;
    loadMembers(org.id);
    if (org.role === "owner") loadInvites(org.id);
    else setInvites([]);
  }, [org, loadMembers, loadInvites]);

  const changeRole = async (m: Member, role: string) => {
    if (!org) return;
    try {
      await apiClient(`/api/orgs/${org.id}/members/${m.user_id}`, { method: "PATCH", body: { role } });
      loadMembers(org.id);
    } catch (e: any) { setMsg(e?.message || "改角色失败"); }
  };

  const removeMember = async (m: Member) => {
    if (!org || m.role === "owner") return;
    try {
      await apiClient(`/api/orgs/${org.id}/members/${m.user_id}`, { method: "DELETE" });
      loadMembers(org.id);
    } catch (e: any) { setMsg(e?.message || "移除失败"); }
  };

  const createInvite = async () => {
    if (!org) return;
    try {
      await apiPost(`/api/orgs/${org.id}/invites`, { expiresInDays: 7 });
      loadInvites(org.id);
    } catch (e: any) { setMsg(e?.message || "生成失败"); }
  };

  const revokeInvite = async (token: string) => {
    if (!org) return;
    try {
      await apiClient(`/api/orgs/${org.id}/invites/${token}`, { method: "DELETE" });
      loadInvites(org.id);
    } catch (e: any) { setMsg(e?.message || "吊销失败"); }
  };

  const inviteUrl = (token: string) => `${window.location.origin}/register?invite=${token}`;
  const copyInvite = async (token: string) => {
    try { await navigator.clipboard.writeText(inviteUrl(token)); setCopied(token); setTimeout(() => setCopied(""), 2000); }
    catch { setMsg("复制失败"); }
  };

  const roleLabel = (r: string) => (r === "owner" ? "所有者" : r === "admin" ? "管理员" : "成员");
  const activeInvites = invites.filter((i) => !i.revoked_at);

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-gray-900 dark:text-white text-xl font-bold">成员管理</h2>
        {orgs.length > 1 && (
          <select value={org?.id || ""} onChange={(e) => setOrg(orgs.find((o) => o.id === e.target.value) || null)}
            className="p-2 rounded text-sm bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600">
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}{o.personal ? "（个人）" : ""}</option>)}
          </select>
        )}
      </div>
      {msg && <p className="text-red-400 text-sm">{msg}</p>}

      {/* 成员列表 */}
      <div className="bg-gray-50 dark:bg-gray-800 rounded-lg divide-y divide-gray-200 dark:divide-gray-700">
        {members.map((m) => (
          <div key={m.user_id} className="flex items-center gap-3 p-3">
            <div className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-semibold">
              {(m.display_name || m.handle)[0]?.toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-gray-900 dark:text-white text-sm truncate">{m.display_name || m.handle}</p>
              <p className="text-gray-500 text-xs">@{m.handle}</p>
            </div>
            {isOwner && m.role !== "owner" ? (
              <select value={m.role} onChange={(e) => changeRole(m, e.target.value)}
                className="text-xs p-1.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-600">
                <option value="member">成员</option>
                <option value="admin">管理员</option>
              </select>
            ) : (
              <span className="text-xs text-gray-500">{roleLabel(m.role)}</span>
            )}
            {isOwner && m.role !== "owner" && (
              <button onClick={() => removeMember(m)} className="text-gray-400 hover:text-red-500 text-sm" title="移除">✕</button>
            )}
          </div>
        ))}
        {members.length === 0 && <p className="text-gray-500 text-sm p-4">暂无成员</p>}
      </div>

      {/* 邀请链接（仅 owner） */}
      {isOwner && (
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-gray-900 dark:text-white font-semibold">邀请同事加入</h3>
              <p className="text-gray-500 text-xs mt-0.5">生成链接发给同事，他们用链接注册后自动加入「{org?.name}」。</p>
            </div>
            <button onClick={createInvite} className="bg-blue-600 text-white px-3 py-2 rounded text-sm hover:bg-blue-500">
              生成邀请链接
            </button>
          </div>
          {activeInvites.map((inv) => (
            <div key={inv.token} className="flex items-center gap-2 bg-gray-100 dark:bg-gray-900 rounded p-2">
              <code className="flex-1 text-xs text-gray-600 dark:text-gray-300 truncate">{inviteUrl(inv.token)}</code>
              <span className="text-xs text-gray-400 shrink-0">
                已用 {inv.uses}{inv.max_uses != null ? `/${inv.max_uses}` : ""} 次
                {inv.expires_at && ` · ${new Date(inv.expires_at).toLocaleDateString()} 过期`}
              </span>
              <button onClick={() => copyInvite(inv.token)} className="text-blue-500 hover:text-blue-400 text-xs shrink-0">
                {copied === inv.token ? "已复制 ✓" : "复制"}
              </button>
              <button onClick={() => revokeInvite(inv.token)} className="text-gray-400 hover:text-red-500 text-xs shrink-0" title="吊销">✕</button>
            </div>
          ))}
          {activeInvites.length === 0 && <p className="text-gray-500 text-xs">还没有有效的邀请链接。</p>}
        </div>
      )}
    </div>
  );
}
