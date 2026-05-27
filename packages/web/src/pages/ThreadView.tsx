import { useParams, Link } from "react-router-dom";
import { useEffect, useState, useRef } from "react";
import { apiClient } from "../api/client";
import { useAuthStore } from "../stores/authStore";

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
  const [parent, setParent] = useState<ThreadMsg | null>(null);
  const [replies, setReplies] = useState<ThreadMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const fetchedRef = useRef<string | null>(null);

  const loadThread = async () => {
    try {
      const data = await apiClient<{ parent: ThreadMsg; replies: ThreadMsg[] }>(
        `/api/messages/thread/${threadId}`, { method: "GET" }
      );
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

  const handleReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || !channelName) return;
    try {
      await apiClient("/api/messages/send", {
        method: "POST",
        body: {
          target: `#${channelName}:${threadId}`,
          content: draft,
          threadId,
        },
      });
      setDraft("");
      await loadThread();
    } catch {
      setError("回复失败");
    }
  };

  if (error && !parent) {
    return (
      <div className="flex flex-col h-full items-center justify-center text-gray-400">
        <p>{error}</p>
        <Link to={`/channels/${channelName}`} className="text-blue-400 mt-2 hover:underline">
          返回 #{channelName}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <h2 className="text-white font-bold">Thread</h2>
          <span className="text-gray-500 text-sm">in</span>
          <Link to={`/channels/${channelName}`} className="text-blue-400 hover:underline text-sm">
            #{channelName}
          </Link>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {parent && (
          <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-7 h-7 rounded bg-gray-600 flex items-center justify-center text-xs text-white">
                {(parent.senderName || parent.sender_id || "?")[0]}
              </div>
              <span className="font-semibold text-white text-sm">{parent.senderName || parent.sender_id}</span>
              <span className="text-gray-500 text-xs">
                {new Date(parent.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            <p className="text-gray-300 text-sm whitespace-pre-wrap">{parent.content}</p>
          </div>
        )}

        {replies.length > 0 && (
          <div className="flex items-center gap-2">
            <div className="flex-1 border-t border-gray-700" />
            <span className="text-gray-500 text-xs">{replies.length} 条回复</span>
            <div className="flex-1 border-t border-gray-700" />
          </div>
        )}

        {replies.map((msg) => (
          <div key={msg.id} className="group flex gap-3 hover:bg-gray-800/50 p-2 rounded">
            <div className="w-7 h-7 rounded bg-gray-600 shrink-0 flex items-center justify-center text-xs text-white">
              {(msg.senderName || msg.sender_id || "?")[0]}
            </div>
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="font-semibold text-white text-sm">{msg.senderName || msg.sender_id}</span>
                <span className="text-gray-500 text-xs">
                  {new Date(msg.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              <p className="text-gray-300 text-sm whitespace-pre-wrap">{msg.content}</p>
            </div>
          </div>
        ))}

        {replies.length === 0 && parent && (
          <p className="text-gray-500 text-center text-sm">还没有回复，说点什么吧</p>
        )}
      </div>

      <form onSubmit={handleReply} className="p-4 border-t border-gray-700">
        <input
          type="text" value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="回复线程..."
          className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600 focus:outline-none focus:border-blue-500"
        />
      </form>
    </div>
  );
}
