import { useEffect, useState, useCallback } from "react";
import { apiClient, apiGet } from "../../api/client";
import { useAuthStore } from "../../stores";

interface Member {
  member_id: string;
  member_type: "human" | "agent";
  role: string;
  handle: string;
  display_name?: string;
}

const ROLE_LABEL: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员" };

export function ChannelMembersPanel({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const currentUserId = useAuthStore((s) => s.user?.id);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteHandle, setInviteHandle] = useState("");
  const [inviteMsg, setInviteMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    apiGet<{ members: Member[] }>(`/api/channels/${channelId}/members`)
      .then((d) => { setMembers(d.members || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [channelId]);

  useEffect(() => { load(); }, [load]);

  const handleInvite = async () => {
    const h = inviteHandle.trim();
    if (!h) return;
    setBusy(true);
    setInviteMsg("");
    try {
      await apiClient(`/api/channels/${channelId}/invite`, { method: "POST", body: { handle: h } });
      setInviteHandle("");
      setInviteMsg("已邀请");
      load();
    } catch (err: any) {
      setInviteMsg(err?.message === "user or agent not found" ? "用户/Agent 不存在"
        : err?.message === "already a member" ? "已是成员" : (err?.message || "邀请失败"));
    } finally { setBusy(false); }
  };

  const handleRemove = async (m: Member) => {
    if (!confirm(`将 @${m.handle} 移出频道？`)) return;
    try {
      await apiClient(`/api/channels/${channelId}/members/${m.member_id}`, { method: "DELETE" });
      load();
    } catch (err: any) { alert(err?.message || "移除失败"); }
  };

  const handleRole = async (m: Member, role: string) => {
    try {
      await apiClient(`/api/channels/${channelId}/members/${m.member_id}`, { method: "PATCH", body: { role } });
      load();
    } catch (err: any) { alert(err?.message || "修改失败"); }
  };

  const humans = members.filter((m) => m.member_type === "human");
  const agents = members.filter((m) => m.member_type === "agent");

  const renderMember = (m: Member) => {
    const isSelf = m.member_id === currentUserId;
    return (
      <div key={m.member_id + m.member_type} className="group flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700">
        <div className={"w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0 " +
          (m.member_type === "agent" ? "bg-purple-600" : "bg-gray-500")}>
          {(m.display_name || m.handle || "?")[0]?.toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-gray-800 dark:text-gray-200 text-sm truncate">
            {m.display_name || m.handle}{isSelf && <span className="text-gray-400"> （你）</span>}
          </div>
          <div className="text-gray-400 text-xs truncate">@{m.handle}</div>
        </div>
        {m.member_type === "human" && m.role !== "owner" ? (
          <select value={m.role || "member"} onChange={(e) => handleRole(m, e.target.value)}
            className="text-[10px] bg-transparent text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-600 rounded px-1 py-0.5 opacity-0 group-hover:opacity-100 focus:opacity-100">
            <option value="member">成员</option>
            <option value="admin">管理员</option>
          </select>
        ) : (
          m.role && m.role !== "member" && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-300">
              {ROLE_LABEL[m.role] || m.role}
            </span>
          )
        )}
        {m.member_type === "human" && m.role !== "owner" && !isSelf && (
          <button onClick={() => handleRemove(m)} title="移除成员"
            className="text-gray-400 hover:text-red-500 text-xs opacity-0 group-hover:opacity-100">✕</button>
        )}
      </div>
    );
  };

  return (
    <aside className="w-60 shrink-0 border-l border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 flex flex-col">
      <div className="flex items-center justify-between p-3 border-b border-gray-200 dark:border-gray-700">
        <span className="text-gray-700 dark:text-gray-300 text-sm font-semibold">成员（{members.length}）</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-700 dark:hover:text-white text-sm">✕</button>
      </div>

      <div className="p-3 border-b border-gray-200 dark:border-gray-700 space-y-1">
        <div className="flex gap-1">
          <input type="text" value={inviteHandle} onChange={(e) => setInviteHandle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleInvite(); }}
            placeholder="输入用户名 / Agent名 邀请"
            className="flex-1 min-w-0 text-sm p-1.5 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600" />
          <button onClick={handleInvite} disabled={busy || !inviteHandle.trim()}
            className="px-2 rounded text-sm bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50">邀请</button>
        </div>
        {inviteMsg && <p className={"text-xs " + (inviteMsg === "已邀请" ? "text-green-500" : "text-red-400")}>{inviteMsg}</p>}
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {loading && <p className="text-gray-400 text-sm text-center py-4">加载中…</p>}
        {!loading && members.length === 0 && (
          <p className="text-gray-400 text-sm text-center py-4">暂无成员</p>
        )}
        {agents.length > 0 && (
          <div>
            <div className="text-gray-400 text-xs font-semibold uppercase px-2 mb-1">Agent（{agents.length}）</div>
            {agents.map(renderMember)}
          </div>
        )}
        {humans.length > 0 && (
          <div>
            <div className="text-gray-400 text-xs font-semibold uppercase px-2 mb-1">成员（{humans.length}）</div>
            {humans.map(renderMember)}
          </div>
        )}
      </div>
    </aside>
  );
}
