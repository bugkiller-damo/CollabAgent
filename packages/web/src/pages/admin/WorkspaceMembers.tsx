import { useEffect, useState, useCallback } from "react";
import { apiGet, apiPost, apiClient } from "../../api/client";
import { PageHeader } from "../../components/layout/PageHeader";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Avatar } from "../../components/ui/Avatar";

interface Org { id: string; name: string; personal: boolean; role: string; memberCount: number; agentCount: number; }
interface Member { user_id: string; role: string; handle: string; display_name?: string; }
interface Invite { token: string; role: string; max_uses: number | null; uses: number; expires_at: string | null; revoked_at: string | null; }

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
    } catch (e: any) {
      setMsg(e?.message || "改角色失败");
    }
  };

  const removeMember = async (m: Member) => {
    if (!org || m.role === "owner") return;
    try {
      await apiClient(`/api/orgs/${org.id}/members/${m.user_id}`, { method: "DELETE" });
      loadMembers(org.id);
    } catch (e: any) {
      setMsg(e?.message || "移除失败");
    }
  };

  const createInvite = async () => {
    if (!org) return;
    try {
      await apiPost(`/api/orgs/${org.id}/invites`, { expiresInDays: 7 });
      loadInvites(org.id);
    } catch (e: any) {
      setMsg(e?.message || "生成失败");
    }
  };

  const revokeInvite = async (token: string) => {
    if (!org) return;
    try {
      await apiClient(`/api/orgs/${org.id}/invites/${token}`, { method: "DELETE" });
      loadInvites(org.id);
    } catch (e: any) {
      setMsg(e?.message || "吊销失败");
    }
  };

  const inviteUrl = (token: string) => `${window.location.origin}/register?invite=${token}`;
  const copyInvite = async (token: string) => {
    try {
      await navigator.clipboard.writeText(inviteUrl(token));
      setCopied(token);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      setMsg("复制失败");
    }
  };

  const roleLabel = (r: string) => (r === "owner" ? "所有者" : r === "admin" ? "管理员" : "成员");
  const activeInvites = invites.filter((i) => !i.revoked_at);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader title="成员管理" backTo="/admin" breadcrumb={[{ label: "管理后台", to: "/admin" }, { label: "成员管理" }]} />

      <div className="flex items-center justify-end">
        {orgs.length > 1 && (
          <select
            value={org?.id || ""}
            onChange={(e) => setOrg(orgs.find((o) => o.id === e.target.value) || null)}
            className="rounded-md border border-gray-300 bg-gray-100 p-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
          >
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}{o.personal ? "（个人）" : ""}</option>)}
          </select>
        )}
      </div>

      {msg && <p className="text-sm text-red-500">{msg}</p>}

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
      <Card padding="none" className="divide-y divide-gray-200 lg:col-span-2 dark:divide-gray-700">
        {members.map((m) => (
          <div key={m.user_id} className="flex items-center gap-3 p-3">
            <Avatar name={m.display_name || m.handle} size="md" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-gray-900 dark:text-white">{m.display_name || m.handle}</p>
              <p className="text-xs text-gray-500">@{m.handle}</p>
            </div>
            {isOwner && m.role !== "owner" ? (
              <select
                value={m.role}
                onChange={(e) => changeRole(m, e.target.value)}
                className="rounded border border-gray-300 bg-gray-200 p-1.5 text-xs text-gray-700 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
              >
                <option value="member">成员</option>
                <option value="admin">管理员</option>
              </select>
            ) : (
              <span className="text-xs text-gray-500">{roleLabel(m.role)}</span>
            )}
            {isOwner && m.role !== "owner" && (
              <Button onClick={() => removeMember(m)} variant="ghost" size="sm" className="text-red-500 hover:text-red-600" title="移除">✕</Button>
            )}
          </div>
        ))}
        {members.length === 0 && <p className="p-4 text-sm text-gray-500">暂无成员</p>}
      </Card>

      {isOwner && (
        <Card className="space-y-3 lg:col-span-1">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-gray-900 dark:text-white">邀请同事加入</h3>
              <p className="mt-0.5 text-xs text-gray-500">生成链接发给同事，他们用链接注册后自动加入「{org?.name}」。</p>
            </div>
            <Button onClick={createInvite} size="sm">生成邀请链接</Button>
          </div>
          {activeInvites.map((inv) => (
            <div key={inv.token} className="flex items-center gap-2 rounded bg-gray-100 p-2 dark:bg-gray-900">
              <code className="flex-1 truncate text-xs text-gray-600 dark:text-gray-300">{inviteUrl(inv.token)}</code>
              <span className="shrink-0 text-xs text-gray-400">
                已用 {inv.uses}{inv.max_uses != null ? `/${inv.max_uses}` : ""} 次
                {inv.expires_at && ` · ${new Date(inv.expires_at).toLocaleDateString()} 过期`}
              </span>
              <Button onClick={() => copyInvite(inv.token)} variant="ghost" size="sm" className="shrink-0">{copied === inv.token ? "已复制 ✓" : "复制"}</Button>
              <Button onClick={() => revokeInvite(inv.token)} variant="ghost" size="sm" className="shrink-0 text-red-500 hover:text-red-600" title="吊销">✕</Button>
            </div>
          ))}
          {activeInvites.length === 0 && <p className="text-xs text-gray-500">还没有有效的邀请链接。</p>}
        </Card>
      )}
      </div>
    </div>
  );
}
