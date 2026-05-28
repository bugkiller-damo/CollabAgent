import { useParams } from "react-router-dom";
import { useEffect, useState, useRef, useLayoutEffect } from "react";
import { useMessageStore, useChannelStore } from "../stores";
import { apiClient } from "../api/client";

const EMPTY_MSGS: never[] = [];

interface ThreadReply {
  id: string; senderName: string; content: string; time: string;
}

export function ChannelView() {
  const { channelName } = useParams<{ channelName: string }>();
  const target = channelName ? `#${channelName}` : "";
  const messages = useMessageStore((s) => (target && s.messagesByTarget[target]) || EMPTY_MSGS);
  const fetchHistory = useMessageStore((s) => s.fetchHistory);
  const setActiveChannel = useChannelStore((s) => s.setActiveChannel);
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const fetchedRef = useRef<string | null>(null);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [threadReplies, setThreadReplies] = useState<ThreadReply[]>([]);
  const [threadReply, setThreadReply] = useState("");

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

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

  const toggleThread = async (msgId: string) => {
    if (openThreadId === msgId) {
      closeThread();
      return;
    }
    setOpenThreadId(msgId);
    const load = async () => {
      try {
        const data = await apiClient<{ replies: ThreadReply[] }>(`/api/messages/thread/${msgId}`);
        setThreadReplies(data.replies || []);
      } catch { setThreadReplies([]); }
    };
    await load();
    // auto-refresh thread replies every 2s so other users' replies appear
    const timer = setInterval(load, 2000);
    (window as any).__threadTimer = timer;
  };
  // Clean up timer when closing thread
  const closeThread = () => {
    setOpenThreadId(null);
    setThreadReplies([]);
    clearInterval((window as any).__threadTimer);
  };

  const handleThreadReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!threadReply.trim() || !openThreadId) return;
    try {
      await apiClient("/api/messages/send", {
        method: "POST",
        body: { target, content: threadReply, threadId: openThreadId },
      });
      setThreadReply("");
      // refresh thread replies
      const data = await apiClient<{ replies: ThreadReply[] }>(`/api/messages/thread/${openThreadId}`);
      setThreadReplies(data.replies || []);
    } catch { /* ignore */ }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-gray-700">
        <h2 className="text-white font-bold">#{channelName}</h2>
      </div>
      <div ref={scrollRef} className="flex-1 p-4 overflow-y-auto space-y-3">
        {messages.length === 0 && (
          <p className="text-gray-500 text-center mt-8">暂无消息，发送第一条消息开始对话</p>
        )}
        {messages.map((msg: any) => (
          <div key={msg.id}>
            <div className="group flex gap-3 hover:bg-gray-800/50 p-2 rounded">
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
                <button onClick={() => toggleThread(msg.id)}
                  className="text-gray-600 hover:text-blue-400 text-xs mt-1">
                  💬 {openThreadId === msg.id ? "收起" : "回复"}
                </button>
              </div>
            </div>
            {/* Inline thread panel */}
            {openThreadId === msg.id && (
              <div className="ml-11 mt-1 border-l-2 border-gray-600 pl-4 space-y-2">
                {threadReplies.length === 0 && (
                  <p className="text-gray-600 text-xs">暂无回复</p>
                )}
                {threadReplies.map((r) => (
                  <div key={r.id} className="flex gap-2 p-1 rounded hover:bg-gray-800/30">
                    <div className="w-6 h-6 rounded bg-gray-600 shrink-0 flex items-center justify-center text-xs text-white">
                      {(r.senderName || "?")[0]}
                    </div>
                    <div>
                      <div className="flex items-baseline gap-1">
                        <span className="font-semibold text-white text-xs">{r.senderName}</span>
                        <span className="text-gray-500 text-[10px]">
                          {new Date(r.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>
                      <p className="text-gray-400 text-xs">{r.content}</p>
                    </div>
                  </div>
                ))}
                <form onSubmit={handleThreadReply} className="flex gap-2 pb-2">
                  <input type="text" value={threadReply} onChange={e => setThreadReply(e.target.value)}
                    placeholder="回复..." className="flex-1 p-1.5 rounded bg-gray-700 text-white border border-gray-600 text-xs focus:outline-none" />
                </form>
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
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
