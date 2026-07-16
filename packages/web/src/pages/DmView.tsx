import { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { apiGet, apiClient, uploadAttachment } from "../api/client";
import { useMessageStore } from "../stores";
import { toast } from "../stores/toastStore";
import { MessageRow } from "../components/chat/MessageRow";
import { EmptyState } from "../components/EmptyState";
import { MessageSkeleton } from "../components/Skeleton";
import { useMentionSuggest } from "../hooks/useMentionSuggest";
import { MentionPopup } from "../components/chat/MentionPopup";

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
  const [pendingAttachment, setPendingAttachment] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fetchHistory = useMessageStore((s) => s.fetchHistory);
  const messages = useMessageStore((s) => (convKey && s.messagesByTarget[convKey]) || EMPTY);
  const loading = useMessageStore((s) => s.loading);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { filtered, selectedIdx, visible, handleInput, handleKeyDown: mentionKD, insertMention: rawInsert } = useMentionSuggest(textareaRef);
  const insertMention = (handle: string) => { const t = rawInsert(handle); if (t) setDraft(t); };

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

  // 文件上传（选择 + 拖拽 + 粘贴）
  const handleFile = useCallback(async (file: File) => {
    if (file.size > 10 * 1024 * 1024) {
      toast.error(`"${file.name}" 超过 10MB 上限`);
      return;
    }
    setUploading(true);
    try {
      const result = await uploadAttachment(file);
      setPendingAttachment(result.attachmentId);
      toast.success("附件已上传，将在消息发送时附上");
    } catch (err: any) {
      toast.error(err?.message || "附件上传失败");
    } finally {
      setUploading(false);
    }
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const onPaste = useCallback((e: React.ClipboardEvent) => {
    const file = Array.from(e.clipboardData.files || [])[0];
    if (file) { e.preventDefault(); handleFile(file); }
  }, [handleFile]);

  const doSend = async () => {
    const content = draft.trim();
    if ((!content && !pendingAttachment) || !convKey) return;
    setDraft("");
    const att = pendingAttachment;
    setPendingAttachment(null);
    try {
      await apiClient("/api/messages/send", {
        method: "POST",
        body: { target: convKey, content, attachmentIds: att ? [att] : [] },
      });
      fetchHistory(convKey).catch(() => {});
      setTimeout(() => { const el = containerRef.current; if (el) el.scrollTop = el.scrollHeight; }, 50);
    } catch (err: any) {
      toast.error(err?.message || "发送失败");
      setDraft(content);
      if (att) setPendingAttachment(att);
    }
  };

  const title = peer?.displayName || peer?.handle || peerName || "私信";

  return (
    <div className="flex flex-col h-full min-h-0" onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
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

      {dragOver && (
        <div className="bg-blue-500/20 border-2 border-dashed border-blue-500 text-blue-200 text-sm text-center py-2">
          放下以上传附件
        </div>
      )}

      {error ? (
        <div className="flex-1 p-4">
          <EmptyState icon="⚠️" title="无法打开私信" description={error} />
        </div>
      ) : messages.length === 0 ? (
        <div className="flex-1 p-4 overflow-y-auto">
          {loading ? <MessageSkeleton /> : (
            <EmptyState icon="✉️" title="还没有私信" description={`发送第一条消息，开始和 ${title} 的私聊`} />
          )}
        </div>
      ) : (
        <div ref={containerRef} className="flex-1 p-4 overflow-y-auto space-y-1">
          {messages.map((m: any) => (
            <MessageRow key={m.id} msg={m} channelName={convKey} />
          ))}
        </div>
      )}

      {pendingAttachment && (
        <div className="px-4 py-2 bg-blue-50 dark:bg-blue-900/20 border-t border-blue-200 dark:border-blue-800 text-sm text-blue-700 dark:text-blue-300 flex items-center justify-between">
          <span>📎 附件已选（将在发送时附上）</span>
          <button onClick={() => setPendingAttachment(null)} className="text-blue-500 hover:underline">取消</button>
        </div>
      )}

      <div className="p-4 border-t border-gray-200 dark:border-gray-700 relative">
        <MentionPopup items={filtered} selectedIdx={selectedIdx} onSelect={insertMention} />
        <div className="flex gap-2 items-end">
          <input
            ref={fileInputRef}
            type="file"
            hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || !!error || !convKey}
            className="text-gray-500 hover:text-blue-500 p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
            title="附件"
            aria-label="附件"
          >
            {uploading ? "⏳" : "📎"}
          </button>
          <textarea
            ref={textareaRef}
            value={draft}
            disabled={!!error || !convKey}
            placeholder={`发私信给 ${title}... (Enter 发送, Shift+Enter 换行, @ 提及)`}
            rows={1}
            onChange={(e) => { setDraft(e.target.value); handleInput(); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px"; }}
            onKeyDown={(e) => { mentionKD(e); if (!visible && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); } }}
            onPaste={onPaste}
            className="flex-1 p-2 rounded bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600 focus:outline-none focus:border-blue-500 resize-none text-sm disabled:opacity-50"
          />
        </div>
        <div className="text-gray-500 text-xs mt-1">Enter 发送 · Shift+Enter 换行 · 支持拖放/粘贴/📎 上传附件</div>
      </div>
    </div>
  );
}
