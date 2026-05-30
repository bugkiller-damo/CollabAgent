import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { apiGet, apiClient } from "../api/client";
import { useMessageStore } from "../stores";
import { MarkdownContent } from "../components/chat/MarkdownContent";
import { AttachmentView } from "../components/chat/AttachmentView";
import { EmptyState } from "../components/EmptyState";

const EMPTY: never[] = [];

interface Peer {
  id: string;
  type: "human" | "agent";
  handle: string;
  displayName?: string;
}

export function DmView() {
  const { peerName } = useParams<{ peerName: string }>();
  const [peer, setPeer] = useState<Peer | null>(null);
  const [convKey, setConvKey] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [draft, setDraft] = useState("");
  const fetchHistory = useMessageStore((s) => s.fetchHistory);
  const messages = useMessageStore((s) => (convKey && s.messagesByTarget[convKey]) || EMPTY);
  const loading = useMessageStore((s) => s.loading);
  const containerRef = useRef<HTMLDivElement>(null);

  // 解析对端 + 找/建 DM 频道 → 得到稳定会话键 dm:<uuid>
  useEffect(() => {
    if (!peerName) return;
    setError("");
    setConvKey("");
    apiGet<{ channelId: string; dmKey: string; peer: Peer }>("/api/channels/resolve", { target: "dm:@" + peerName })
      .then((d) => {
        setPeer(d.peer);
        setConvKey(d.dmKey);
        fetchHistory(d.dmKey).catch(() => {});
      })
      .catch((e: any) => setError(e?.message || "找不到该用户/Agent"));
  }, [peerName]);

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const doSend = async () => {
    const content = draft.trim();
    if (!content || !convKey) return;
    setDraft("");
    try {
      await apiClient("/api/messages/send", { method: "POST", body: { target: convKey, content } });
      fetchHistory(convKey).catch(() => {});
      setTimeout(() => { const el = containerRef.current; if (el) el.scrollTop = el.scrollHeight; }, 50);
    } catch (err: any) {
      alert(err?.message || "发送失败");
      setDraft(content);
    }
  };

  const title = peer?.displayName || peer?.handle || peerName || "私信";

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
        <span className="w-7 h-7 rounded-full bg-gray-600 flex items-center justify-center text-xs text-white shrink-0">
          {(title || "?")[0]}
        </span>
        <h2 className="text-gray-900 dark:text-white font-bold">{title}</h2>
        {peer?.type === "agent" && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-300">Agent</span>
        )}
        <span className="text-gray-400 text-xs">@{peer?.handle || peerName}</span>
      </div>

      {error ? (
        <div className="flex-1 p-4">
          <EmptyState icon="⚠️" title="无法打开私信" description={error} />
        </div>
      ) : messages.length === 0 ? (
        <div className="flex-1 p-4 overflow-y-auto">
          {loading ? (
            <p className="text-gray-400 text-sm">加载中…</p>
          ) : (
            <EmptyState icon="✉️" title="还没有私信" description={`发送第一条消息，开始和 ${title} 的私聊`} />
          )}
        </div>
      ) : (
        <div ref={containerRef} className="flex-1 p-4 overflow-y-auto space-y-1">
          {messages.map((m: any) => (
            <div key={m.id} className="group flex gap-3 hover:bg-gray-100 dark:hover:bg-gray-800/50 p-2 rounded">
              <div className="w-8 h-8 rounded bg-gray-600 shrink-0 flex items-center justify-center text-xs text-white">
                {(m.senderName || "?")[0]}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-semibold text-gray-900 dark:text-white text-sm">{m.senderName || "?"}</span>
                  <span className="text-gray-500 text-xs">
                    {new Date(m.time || m.createdAt || Date.now()).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
                {m.content && <MarkdownContent content={m.content} />}
                {m.attachments && m.attachments.length > 0 && <AttachmentView attachments={m.attachments} />}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="p-4 border-t border-gray-200 dark:border-gray-700">
        <textarea
          value={draft}
          disabled={!!error || !convKey}
          placeholder={`发私信给 ${title}... (Enter 发送, Shift+Enter 换行)`}
          rows={1}
          onChange={(e) => { setDraft(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px"; }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); } }}
          className="w-full p-2 rounded bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600 focus:outline-none focus:border-blue-500 resize-none text-sm disabled:opacity-50"
        />
        <div className="text-gray-500 text-xs mt-1">Enter 发送 · Shift+Enter 换行</div>
      </div>
    </div>
  );
}
