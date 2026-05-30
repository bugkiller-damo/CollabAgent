import { useParams, useNavigate } from "react-router-dom";
import { useEffect, useState, useRef } from "react";
import { useMessageStore, useChannelStore, useUiStore } from "../stores";
import { apiClient, uploadAttachment, type UploadedAttachment } from "../api/client";
import { useMentionSuggest } from "../hooks/useMentionSuggest";
import { MessageSkeleton } from "../components/Skeleton";
import { MentionPopup } from "../components/chat/MentionPopup";
import { MessageRow } from "../components/chat/MessageRow";
import { PendingRow } from "../components/chat/PendingRow";
import { VirtualMessageList, type ListItem } from "../components/chat/VirtualMessageList";
import { EmptyState } from "../components/EmptyState";

const VIRTUAL_THRESHOLD = 100;
import { ChannelMembersPanel } from "../components/channel/ChannelMembersPanel";
import { ChannelSettingsModal } from "../components/channel/ChannelSettingsModal";

const EMPTY_MSGS: never[] = [];

export function ChannelView() {
  const { channelName } = useParams<{ channelName: string }>();
  const target = channelName ? `#${channelName}` : "";
  const messages = useMessageStore((s) => (target && s.messagesByTarget[target]) || EMPTY_MSGS);
  const fetchHistory = useMessageStore((s) => s.fetchHistory);
  const loading = useMessageStore((s) => s.loading);
  const setActiveChannel = useChannelStore((s) => s.setActiveChannel);
  const currentChannel = useChannelStore((s) => s.channels.find((c: any) => c.name === channelName));
  const [showMembers, setShowMembers] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<{ tempId: string; content: string; status: "sending" | "failed" | "queued" }[]>([]);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const [attachments, setAttachments] = useState<{ tempId: string; name: string; status: "uploading" | "done" | "error"; uploaded?: UploadedAttachment }[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const online = useUiStore((s) => s.online);
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { filtered, selectedIdx, visible, handleInput, handleKeyDown: mentionKD, insertMention: rawInsert } = useMentionSuggest(textareaRef);
  const insertMention = (handle: string) => {
    const newText = rawInsert(handle);
    if (newText) setDraft(newText);
  };
  const navigate = useNavigate();
  const fetchedRef = useRef<string | null>(null);

  // 回复数由 /api/messages 列表查询直接返回（replyCount），无需逐条再请求 thread

  useEffect(() => {
    if (channelName && fetchedRef.current !== channelName) {
      fetchedRef.current = channelName;
      setActiveChannel(channelName);
      setPending([]);
      setAttachments([]);
      fetchHistory(target).catch(() => {});
    }
  }, [channelName]);

  useEffect(() => {
    const el = containerRef.current;
    if (el) {
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      if (isNearBottom) el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const scrollToBottom = () => setTimeout(() => { const el = containerRef.current; if (el) el.scrollTop = el.scrollHeight; }, 50);

  const trySend = async (tempId: string, content: string) => {
    try {
      await apiClient("/api/messages/send", { method: "POST", body: { target, content } });
      setPending((p) => p.filter((m) => m.tempId !== tempId));
      fetchHistory(target).catch(() => {});
      scrollToBottom();
    } catch (err) {
      console.error("Send failed", err);
      setPending((p) => p.map((m) => (m.tempId === tempId ? { ...m, status: "failed" } : m)));
    }
  };

  const handleFiles = (files: FileList | File[]) => {
    const list = Array.from(files);
    for (const file of list) {
      if (file.size > 10 * 1024 * 1024) {
        alert(`"${file.name}" 超过 10MB 上限`);
        continue;
      }
      const tempId = "att-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
      setAttachments((a) => [...a, { tempId, name: file.name, status: "uploading" }]);
      uploadAttachment(file)
        .then((uploaded) => setAttachments((a) => a.map((x) => (x.tempId === tempId ? { ...x, status: "done", uploaded } : x))))
        .catch(() => setAttachments((a) => a.map((x) => (x.tempId === tempId ? { ...x, status: "error" } : x))));
    }
  };

  const removeAttachment = (tempId: string) => setAttachments((a) => a.filter((x) => x.tempId !== tempId));

  const doSend = async () => {
    const content = draft.trim();
    if (attachments.some((a) => a.status === "uploading")) return; // 等待上传完成
    const attachmentIds = attachments.filter((a) => a.status === "done" && a.uploaded).map((a) => a.uploaded!.attachmentId);
    if (!content && attachmentIds.length === 0) return;

    // 带附件的消息直接发送（不走文字的乐观队列）
    if (attachmentIds.length > 0) {
      setDraft("");
      setAttachments([]);
      try {
        await apiClient("/api/messages/send", { method: "POST", body: { target, content, attachmentIds } });
        fetchHistory(target).catch(() => {});
        scrollToBottom();
      } catch (err) {
        console.error("Send with attachments failed", err);
        alert("发送失败，请重试");
      }
      return;
    }

    const tempId = "tmp-" + Date.now();
    setDraft("");
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      // 离线：入队，恢复网络后自动发送
      setPending((p) => [...p, { tempId, content, status: "queued" }]);
      scrollToBottom();
      return;
    }
    setPending((p) => [...p, { tempId, content, status: "sending" }]);
    scrollToBottom();
    trySend(tempId, content);
  };

  const retrySend = (tempId: string) => {
    const item = pendingRef.current.find((m) => m.tempId === tempId);
    if (!item) return;
    setPending((p) => p.map((m) => (m.tempId === tempId ? { ...m, status: "sending" } : m)));
    trySend(tempId, item.content);
  };

  const discardPending = (tempId: string) => setPending((p) => p.filter((m) => m.tempId !== tempId));

  // 网络恢复 → 自动发送队列中的离线消息
  useEffect(() => {
    if (!online) return;
    const queued = pendingRef.current.filter((m) => m.status === "queued");
    if (queued.length === 0) return;
    setPending((p) => p.map((m) => (m.status === "queued" ? { ...m, status: "sending" } : m)));
    queued.forEach((m) => trySend(m.tempId, m.content));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);
  const isEmpty = messages.length === 0 && pending.length === 0;
  const totalCount = messages.length + pending.length;
  const useVirtual = totalCount > VIRTUAL_THRESHOLD;
  const listItems: ListItem[] = useVirtual
    ? [
        ...messages.map((m: any) => ({ kind: "msg" as const, data: m })),
        ...pending.map((p) => ({ kind: "pending" as const, data: p })),
      ]
    : [];

  const handleSend = (e: React.FormEvent) => { e.preventDefault(); doSend(); };
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !visible) { e.preventDefault(); doSend(); }
  };

  return (
    <div className="flex min-h-0 flex-1">
    <div className="flex flex-col min-h-0 flex-1 relative"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files); }}
    >
      {dragOver && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-blue-500/10 border-2 border-dashed border-blue-400 rounded pointer-events-none">
          <span className="text-blue-500 font-medium">松开以上传文件</span>
        </div>
      )}
      <div className="p-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-3">
        <h2 className="text-gray-900 dark:text-white font-bold">#{channelName}</h2>
        {currentChannel?.description && (
          <span className="text-gray-500 text-xs truncate max-w-xs">{currentChannel.description}</span>
        )}
        <div className="ml-auto flex items-center gap-3">
          <button onClick={()=>navigate("/tasks/"+channelName)} className="text-gray-500 hover:text-blue-400 text-xs">
            看板
          </button>
          <button onClick={() => setShowMembers((v) => !v)} title="成员"
            className={"text-xs " + (showMembers ? "text-blue-400" : "text-gray-500 hover:text-blue-400")}>
            👥 成员
          </button>
          {currentChannel && (
            <button onClick={() => setShowSettings(true)} title="频道设置"
              className="text-gray-500 hover:text-blue-400 text-xs">
              ⚙️ 设置
            </button>
          )}
        </div>
      </div>
      </div>
      {isEmpty ? (
        <div className="flex-1 p-4 overflow-y-auto">
          {loading ? <MessageSkeleton /> : (
            <EmptyState icon="💬" title="还没有消息" description="发送第一条消息，开启这个频道的对话吧" />
          )}
        </div>
      ) : useVirtual ? (
        <VirtualMessageList items={listItems} channelName={channelName} onRetry={retrySend} onDiscard={discardPending} />
      ) : (
        <div ref={containerRef} className="flex-1 p-4 overflow-y-auto space-y-1">
          {messages.map((msg: any) => (
            <MessageRow key={msg.id} msg={msg} channelName={channelName} />
          ))}
          {pending.map((m) => (
            <PendingRow key={m.tempId} item={m} onRetry={retrySend} onDiscard={discardPending} />
          ))}
        </div>
      )}
      <form onSubmit={handleSend} className="p-4 border-t border-gray-200 dark:border-gray-700 relative">
        <MentionPopup items={filtered} selectedIdx={selectedIdx} onSelect={insertMention} />
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {attachments.map((a) => (
              <div key={a.tempId} className="flex items-center gap-1.5 text-xs bg-gray-200 dark:bg-gray-700 rounded px-2 py-1">
                <span className="text-gray-700 dark:text-gray-200 truncate max-w-[140px]">📎 {a.name}</span>
                {a.status === "uploading" && <span className="text-gray-400">上传中…</span>}
                {a.status === "error" && <span className="text-red-500">失败</span>}
                <button type="button" onClick={() => removeAttachment(a.tempId)} className="text-gray-400 hover:text-red-500">✕</button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <input ref={fileInputRef} type="file" multiple className="hidden"
            onChange={(e) => { if (e.target.files?.length) handleFiles(e.target.files); e.target.value = ""; }} />
          <button type="button" title="上传文件" onClick={() => fileInputRef.current?.click()}
            className="shrink-0 text-gray-500 hover:text-blue-500 text-xl px-1 pb-1">📎</button>
          <textarea ref={textareaRef} value={draft}
            onChange={(e) => { setDraft(e.target.value); handleInput(); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px"; }}
            onKeyDown={e => { mentionKD(e); if (!visible && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); } } }
            onPaste={(e) => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); handleFiles(files); } }}
            placeholder={`发送消息到 #${channelName}... (@ 提及，可拖拽/粘贴文件)`}
            rows={1}
            className="flex-1 p-2 rounded bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600 focus:outline-none focus:border-blue-500 resize-none text-sm"
          />
        </div>
        <div className="flex justify-between mt-1 text-gray-600 text-xs">
          <span>Enter 发送 · Shift+Enter 换行 · @ 提及 · 📎 拖拽/粘贴上传</span>
          {draft.length > 0 && <span>{draft.length}/4000</span>}
        </div>
      </form>
    </div>
    {showMembers && currentChannel && (
      <ChannelMembersPanel channelId={(currentChannel as any).id} onClose={() => setShowMembers(false)} />
    )}
    {showSettings && currentChannel && (
      <ChannelSettingsModal
        channel={currentChannel}
        onClose={() => setShowSettings(false)}
        onArchived={() => navigate("/channels/general")}
        onDeleted={() => navigate("/channels/general")}
      />
    )}
    </div>
  );
}
