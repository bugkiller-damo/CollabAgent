import { useParams, Link } from "react-router-dom";
import { useEffect, useState, useRef } from "react";
import { useMessageStore, useChannelStore } from "../stores";
import { apiClient } from "../api/client";

const EMPTY_MSGS: never[] = [];

export function ChannelView() {
  const { channelName } = useParams<{ channelName: string }>();
  const target = channelName ? `#${channelName}` : "";
  const messages = useMessageStore((s) => (target && s.messagesByTarget[target]) || EMPTY_MSGS);
  const fetchHistory = useMessageStore((s) => s.fetchHistory);
  const setActiveChannel = useChannelStore((s) => s.setActiveChannel);
  const [draft, setDraft] = useState("");
  const fetchedRef = useRef<string | null>(null);

  useEffect(() => {
    if (channelName && fetchedRef.current !== channelName) {
      fetchedRef.current = channelName;
      setActiveChannel(channelName);
      fetchHistory(target).catch(() => {});
    }
  }, [channelName]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    try {
      await apiClient("/api/messages/send", {
        method: "POST",
        body: { target, content: draft },
      });
      setDraft("");
      fetchHistory(target).catch(() => {});
    } catch (err) {
      console.error("Send failed", err);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-gray-700">
        <h2 className="text-white font-bold">#{channelName}</h2>
      </div>
      <div className="flex-1 p-4 overflow-y-auto space-y-3">
        {messages.length === 0 && (
          <p className="text-gray-500 text-center mt-8">暂无消息，发送第一条消息开始对话</p>
        )}
        {messages.map((msg: any) => (
          <div key={msg.id} className="group flex gap-3 hover:bg-gray-800/50 p-2 rounded">
            <div className="w-8 h-8 rounded bg-gray-600 shrink-0 flex items-center justify-center text-xs text-white">
              {(msg.senderName || msg.senderId || msg.sender_id || "?")[0]}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="font-semibold text-white text-sm">
                  {msg.senderName || msg.senderId || msg.sender_id || "Unknown"}
                </span>
                <span className="text-gray-500 text-xs">
                  {new Date(msg.time || msg.createdAt || msg.created_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              <p className="text-gray-300 text-sm whitespace-pre-wrap">{msg.content}</p>
              {(msg.taskNumber || msg.task_number) && (
                <span className="inline-block mt-1 text-xs bg-blue-900 text-blue-300 px-1.5 py-0.5 rounded">
                  task #{msg.taskNumber} · {(msg.taskStatus || msg.task_status)}
                </span>
              )}
              {/* Thread reply button */}
              <div className="mt-1">
                <Link
                  to={`/channels/${channelName}/${msg.id}`}
                  className="text-gray-600 hover:text-blue-400 text-xs"
                >
                  💬 回复
                </Link>
              </div>
            </div>
          </div>
        ))}
      </div>
      <form onSubmit={handleSend} className="p-4 border-t border-gray-700">
        <input
          type="text" value={draft} onChange={(e) => setDraft(e.target.value)}
          placeholder={`发送消息到 #${channelName}...`}
          className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600 focus:outline-none focus:border-blue-500"
        />
      </form>
    </div>
  );
}
