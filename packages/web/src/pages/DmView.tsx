import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { apiGet, apiClient } from "../api/client";
import { useMessageStore, useUiStore } from "../stores";
import { MessageRow } from "../components/chat/MessageRow";
import { EmptyState } from "../components/EmptyState";
import { MessageSkeleton } from "../components/Skeleton";
import { PageHeader } from "../components/layout/PageHeader";
import { MessageComposer, type ComposerAttachment } from "../components/chat/MessageComposer";
import { Avatar } from "../components/ui/Avatar";

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
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const fetchHistory = useMessageStore((s) => s.fetchHistory);
  const messages = useMessageStore((s) => (convKey && s.messagesByTarget[convKey]) || EMPTY);
  const loading = useMessageStore((s) => s.loading);
  const containerRef = useRef<HTMLDivElement>(null);
  const online = useUiStore((s) => s.online);

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
  }, [peerName, fetchHistory]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (isNearBottom) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const scrollToBottom = () => setTimeout(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, 50);

  const handleSend = async (content: string, attachmentIds: string[]) => {
    if (!convKey) return;
    try {
      await apiClient("/api/messages/send", {
        method: "POST",
        body: { target: convKey, content, attachmentIds },
      });
      fetchHistory(convKey).catch(() => {});
      scrollToBottom();
    } catch (err: any) {
      throw err;
    }
  };

  const title = peer?.displayName || peer?.handle || peerName || "私信";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={title}
        subtitle={`@${peer?.handle || peerName}`}
        leading={<Avatar name={title} size="md" />}
      >
        {peer?.type === "agent" && (
          <span className="rounded bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-600 dark:bg-purple-900/40 dark:text-purple-300">
            Agent
          </span>
        )}
      </PageHeader>

      {error ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <EmptyState icon="⚠️" title="无法打开私信" description={error} />
        </div>
      ) : messages.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loading ? <MessageSkeleton /> : (
            <EmptyState icon="✉️" title="还没有私信" description={`发送第一条消息，开始和 ${title} 的私聊`} />
          )}
        </div>
      ) : (
        <div ref={containerRef} className="min-h-0 flex-1 space-y-1 overflow-y-auto p-4">
          {messages.map((m: any, idx: number) => (
            <MessageRow key={m.id} msg={m} channelName={convKey} prevMsg={messages[idx - 1]} />
          ))}
        </div>
      )}

      <div className="border-t border-gray-200 p-4 dark:border-gray-700">
        <MessageComposer
          placeholder={`发私信给 ${title}... (Enter 发送, Shift+Enter 换行, @ 提及)`}
          disabled={!!error || !convKey || !online}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          onSend={handleSend}
        />
      </div>
    </div>
  );
}
