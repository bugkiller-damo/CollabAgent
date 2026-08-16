import { useParams, useNavigate } from "react-router-dom";
import { useEffect, useState, useRef } from "react";
import { apiClient } from "../api/client";
import { useMessageStore, useChannelStore } from "../stores";
import { MarkdownContent } from "../components/chat/MarkdownContent";
import { MessageComposer } from "../components/chat/MessageComposer";
import { PageHeader } from "../components/layout/PageHeader";
import { Avatar } from "../components/ui/Avatar";
import { EmptyState } from "../components/EmptyState";
import { formatTime } from "../lib/formatTime";

interface ThreadMsg {
  id: string;
  channel_id: string;
  sender_id: string;
  senderName: string;
  content: string;
  seq: number;
  time: string;
}

export function ThreadView() {
  const { channelName, threadId } = useParams<{ channelName: string; threadId: string }>();
  const threadKey = channelName && threadId ? `${channelName}:${threadId.substring(0, 8)}` : "";
  const liveReplies = useMessageStore((s) => (threadKey ? s.messagesByTarget[threadKey] : undefined)) || [];
  const currentChannel = useChannelStore((s) => s.channels.find((c: any) => c.name === channelName));
  const [parent, setParent] = useState<ThreadMsg | null>(null);
  const [replies, setReplies] = useState<ThreadMsg[]>([]);
  const [error, setError] = useState("");
  const fetchedRef = useRef<string | null>(null);
  const navigate = useNavigate();

  const loadThread = async () => {
    if (!threadId) return;
    try {
      const data = await apiClient<{ parent: ThreadMsg; replies: ThreadMsg[] }>(`/api/messages/thread/${threadId}`, { method: "GET" });
      setParent(data.parent);
      setReplies(data.replies || []);
    } catch {
      setError("加载线程失败");
    }
  };

  useEffect(() => {
    if (threadId && fetchedRef.current !== threadId) {
      fetchedRef.current = threadId;
      loadThread();
    }
  }, [threadId]);

  useEffect(() => {
    if (liveReplies.length === 0) return;
    setReplies((prev) => {
      const known = new Set(prev.map((r) => r.id));
      const live = liveReplies
        .filter((m: any) => !known.has(m.id))
        .map((m: any) => ({
          id: m.id,
          channel_id: m.channelId,
          sender_id: m.senderId,
          senderName: m.senderName,
          content: m.content,
          seq: m.seq,
          time: m.time,
        } as ThreadMsg));
      return live.length > 0 ? [...prev, ...live] : prev;
    });
  }, [liveReplies]);

  const handleSend = async (content: string) => {
    if (!content.trim() || !channelName || !threadId) return;
    try {
      await apiClient("/api/messages/send", {
        method: "POST",
        body: { target: `#${channelName}:${threadId}`, content, threadId },
      });
      await loadThread();
    } catch {
      setError("回复失败");
      throw new Error("回复失败");
    }
  };

  if (error && !parent) {
    return (
      <div className="flex flex-1 flex-col">
        <PageHeader title="线程" breadcrumb={[{ label: "频道", to: `/channels/${channelName}` }, { label: "线程" }]} />
        <div className="flex flex-1 items-center justify-center p-4">
          <EmptyState icon="⚠️" title="加载失败" description={error}
            actionLabel="返回频道" onAction={() => navigate(`/channels/${channelName}`)} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="线程"
        backTo={`/channels/${channelName}`}
        breadcrumb={[{ label: `#${channelName}`, to: `/channels/${channelName}` }, { label: "线程" }]}
      />

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {parent && (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800">
            <div className="mb-2 flex items-center gap-2">
              <Avatar name={parent.senderName || parent.sender_id} size="md" />
              <span className="text-sm font-semibold text-gray-900 dark:text-white">{parent.senderName || parent.sender_id}</span>
              <span className="text-xs text-gray-500 dark:text-gray-400" title={new Date(parent.time).toLocaleString()}>
                {formatTime(parent.time)}
              </span>
            </div>
            <MarkdownContent content={parent.content} />
          </div>
        )}

        {replies.length > 0 && (
          <div className="flex items-center gap-2">
            <div className="flex-1 border-t border-gray-200 dark:border-gray-700" />
            <span className="text-xs text-gray-500 dark:text-gray-400">{replies.length} 条回复</span>
            <div className="flex-1 border-t border-gray-200 dark:border-gray-700" />
          </div>
        )}

        {replies.map((msg) => (
          <div key={msg.id} className="group flex gap-3 rounded p-2 hover:bg-gray-100 dark:hover:bg-gray-800/50">
            <Avatar name={msg.senderName || msg.sender_id} size="md" />
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-semibold text-gray-900 dark:text-white">{msg.senderName || msg.sender_id}</span>
                <span className="text-xs text-gray-500 dark:text-gray-400" title={new Date(msg.time).toLocaleString()}>
                  {formatTime(msg.time)}
                </span>
              </div>
              <MarkdownContent content={msg.content} />
            </div>
          </div>
        ))}

        {replies.length === 0 && parent && (
          <p className="text-center text-sm text-gray-500 dark:text-gray-400">还没有回复，说点什么吧</p>
        )}
      </div>

      <div className="border-t border-gray-200 p-4 dark:border-gray-700">
        <MessageComposer
          placeholder="回复线程... (Enter 发送, Shift+Enter 换行, @ 提及)"
          onSend={handleSend}
          mentionScope={{ channelId: parent?.channel_id ?? (currentChannel as any)?.id, channelType: (currentChannel as any)?.type }}
        />
      </div>
    </div>
  );
}
