import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useEffect, useState, useRef } from "react";
import { useMessageStore, useChannelStore, useUiStore, useAgentStore } from "../stores";
import { apiClient, apiGet } from "../api/client";
import { toast } from "../stores/toastStore";
import { MessageRow } from "../components/chat/MessageRow";
import { PendingRow } from "../components/chat/PendingRow";
import { VirtualMessageList, type ListItem } from "../components/chat/VirtualMessageList";
import { EmptyState } from "../components/EmptyState";
import { MessageSkeleton } from "../components/Skeleton";
import { PageHeader } from "../components/layout/PageHeader";
import { IconButton } from "../components/ui/IconButton";
import { MessageComposer, type ComposerAttachment } from "../components/chat/MessageComposer";
import { ChannelMembersPanel } from "../components/channel/ChannelMembersPanel";
import { ChannelSettingsModal } from "../components/channel/ChannelSettingsModal";

const VIRTUAL_THRESHOLD = 100;
const EMPTY_MSGS: never[] = [];

const membersIcon = (
  <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.295-2.228-.837-3.244M15 19.128c.956.6 2.04.872 3.124.872M7.5 14.251c.956.6 2.04.872 3.124.872 1.085 0 2.169-.273 3.124-.872M7.5 14.251c.63.394 1.343.6 2.076.6h.017c.734 0 1.446-.206 2.076-.6m-4.17-.6a4.125 4.125 0 0 1-7.532 2.493 9.337 9.337 0 0 1 4.121-.952 9.38 9.38 0 0 1 2.625.372m9.94 3.198-1.807-1.626a4.125 4.125 0 0 0-5.512 0l-1.806 1.626M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
  </svg>
);

const settingsIcon = (
  <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9.53 16.122a3 3 0 0 0-5.78 1.128 2.25 2.25 0 0 1-2.4 2.245 4.5 4.5 0 0 0-2.206.037A9.968 9.968 0 0 0 12 21a9.969 9.969 0 0 0 7.855-3.476 4.5 4.5 0 0 0-2.206-.037 2.25 2.25 0 0 1-2.4-2.245 3 3 0 0 0-5.78-1.121Zm7.806-9.124a2.25 2.25 0 0 1 2.25 2.25v.75h1.125a2.25 2.25 0 0 1 2.25 2.25v2.25a2.25 2.25 0 0 1-2.25 2.25h-9.75c-.621 0-1.125.504-1.125 1.125v2.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z" />
  </svg>
);

const boardIcon = (
  <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z" />
  </svg>
);

const lockIcon = (
  <svg className="h-4 w-4 text-amber-500" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-label="私有频道">
    <title>私有频道</title>
    <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
  </svg>
);

const terminalIcon = (
  <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="m6.75 7.5 3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z" />
  </svg>
);

export function ChannelView() {
  const { channelName } = useParams<{ channelName: string }>();
  const location = useLocation();
  const highlightMsgId = location.hash?.replace("#", "") || undefined;
  const target = channelName ? `#${channelName}` : "";
  const messages = useMessageStore((s) => (target && s.messagesByTarget[target]) || EMPTY_MSGS);
  const fetchHistory = useMessageStore((s) => s.fetchHistory);
  const loading = useMessageStore((s) => s.loading);
  const setActiveChannel = useChannelStore((s) => s.setActiveChannel);
  const currentChannel = useChannelStore((s) => s.channels.find((c: any) => c.name === channelName));

  const [showMembers, setShowMembers] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [pending, setPending] = useState<{ tempId: string; content: string; status: "sending" | "failed" | "queued" }[]>([]);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [droppedFiles, setDroppedFiles] = useState<File[] | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const fetchedRef = useRef<string | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const navigate = useNavigate();

  useEffect(() => {
    if (channelName && fetchedRef.current !== channelName) {
      fetchedRef.current = channelName;
      setActiveChannel(channelName);
      setPending([]);
      setAttachments([]);
      fetchHistory(target).catch(() => {});
    }
  }, [channelName, target, fetchHistory, setActiveChannel]);

  const highlightLoadedRef = useRef(false);
  useEffect(() => {
    if (!highlightMsgId || highlightLoadedRef.current) return;
    if (messages.length === 0) return;
    const inPage = messages.find((m: any) => m.id === highlightMsgId);
    if (inPage) { highlightLoadedRef.current = true; return; }
    apiGet<{ results: { id: string; seq: number }[] }>("/api/messages/search", { q: highlightMsgId.slice(0, 8) }).then((r) => {
      const hit = r.results.find((x) => x.id === highlightMsgId);
      if (hit) {
        fetchHistory(target, { before: hit.seq + 1, limit: 50 }).catch(() => {});
        highlightLoadedRef.current = true;
      }
    }).catch(() => {});
  }, [highlightMsgId, messages, target, fetchHistory]);

  useEffect(() => {
    const el = containerRef.current;
    if (el) {
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      if (isNearBottom) el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const scrollToBottom = () => setTimeout(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, 50);

  const trySend = async (tempId: string, content: string, attachmentIds?: string[]) => {
    try {
      await apiClient("/api/messages/send", { method: "POST", body: { target, content, attachmentIds } });
      setPending((p) => p.filter((m) => m.tempId !== tempId));
      fetchHistory(target).catch(() => {});
      scrollToBottom();
    } catch (err) {
      console.error("Send failed", err);
      setPending((p) => p.map((m) => (m.tempId === tempId ? { ...m, status: "failed" } : m)));
    }
  };

  const handleSend = async (content: string, attachmentIds: string[]) => {
    if (attachmentIds.length > 0) {
      try {
        await apiClient("/api/messages/send", { method: "POST", body: { target, content, attachmentIds } });
        fetchHistory(target).catch(() => {});
        scrollToBottom();
      } catch (err) {
        console.error("Send with attachments failed", err);
        toast.error("发送失败，请重试");
        throw err;
      }
      return;
    }

    const trimmed = content.trim();
    if (!trimmed) return;

    const tempId = "tmp-" + Date.now();
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setPending((p) => [...p, { tempId, content: trimmed, status: "queued" }]);
      scrollToBottom();
      return;
    }
    setPending((p) => [...p, { tempId, content: trimmed, status: "sending" }]);
    scrollToBottom();
    trySend(tempId, trimmed);
  };

  const retrySend = (tempId: string) => {
    const item = pendingRef.current.find((m) => m.tempId === tempId);
    if (!item) return;
    setPending((p) => p.map((m) => (m.tempId === tempId ? { ...m, status: "sending" } : m)));
    trySend(tempId, item.content);
  };

  const discardPending = (tempId: string) => setPending((p) => p.filter((m) => m.tempId !== tempId));

  const online = useUiStore((s) => s.online);
  const terminalAgent = useUiStore((s) => s.terminalAgent);
  const openTerminal = useUiStore((s) => s.openTerminal);
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

  const onDropFiles = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) {
      setDroppedFiles(files);
      setTimeout(() => setDroppedFiles(null), 50);
    }
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="relative flex min-h-0 flex-1 flex-col"
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
        onDrop={onDropFiles}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-blue-400 bg-blue-500/10 m-2"
          >
            <span className="font-medium text-blue-500">松开以上传文件</span>
          </div>
        )}

        <PageHeader
          title={`#${channelName}`}
          subtitle={currentChannel?.description}
          leading={(currentChannel as any)?.type === "private" || (currentChannel as any)?.visibility === "private" ? lockIcon : undefined}
        >
          <div className="flex items-center gap-1">
            <IconButton
              label="观察终端"
              tooltip="观察 Agent 终端"
              onClick={() => {
                // 优先看正在工作的 agent；否则沿用上次选择；再否则列表第一个
                const agents = useAgentStore.getState().agents;
                const working = Object.values(agents).find((a) => a.status === "working" || (a.status as string) === "thinking");
                const fallback = useUiStore.getState().terminalAgent || Object.keys(agents)[0];
                openTerminal(working?.name || fallback || "agent");
              }}
              className={terminalAgent ? "text-blue-500" : ""}
            >
              {terminalIcon}
            </IconButton>
            <IconButton label="看板" tooltip="任务看板" onClick={() => navigate("/tasks/" + channelName)}>{boardIcon}</IconButton>
            <IconButton label="成员" tooltip="成员" onClick={() => setShowMembers((v) => !v)} className={showMembers ? "text-blue-500" : ""}>{membersIcon}</IconButton>
            {currentChannel && (
              <IconButton label="频道设置" tooltip="频道设置" onClick={() => setShowSettings(true)}>{settingsIcon}</IconButton>
            )}
          </div>
        </PageHeader>

        {isEmpty ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {loading ? <MessageSkeleton /> : (
              <EmptyState icon="💬" title="还没有消息" description="发送第一条消息，开启这个频道的对话吧" />
            )}
          </div>
        ) : useVirtual ? (
          <VirtualMessageList items={listItems} channelName={channelName} highlightMsgId={highlightMsgId} onRetry={retrySend} onDiscard={discardPending} />
        ) : (
          <div ref={containerRef} className="min-h-0 flex-1 space-y-1 overflow-y-auto p-4">
            {messages.map((msg: any, idx: number) => (
              <MessageRow key={msg.id} msg={msg} channelName={channelName} prevMsg={messages[idx - 1]} />
            ))}
            {pending.map((m) => (
              <PendingRow key={m.tempId} item={m} onRetry={retrySend} onDiscard={discardPending} />
            ))}
          </div>
        )}

        <div className="border-t border-gray-200 p-4 dark:border-gray-700">
          <MessageComposer
            placeholder={`发送消息到 #${channelName}... (@ 提及，可拖拽/粘贴文件)`}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            onSend={handleSend}
            droppedFiles={droppedFiles}
            mentionScope={{ channelId: (currentChannel as any)?.id, channelType: (currentChannel as any)?.type }}
          />
        </div>
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
