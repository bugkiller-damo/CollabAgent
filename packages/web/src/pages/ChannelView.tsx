import { useParams, useNavigate } from "react-router-dom";
import { useEffect, useState, useRef } from "react";
import { useMessageStore, useChannelStore } from "../stores";
import { apiClient } from "../api/client";
import { useMentionSuggest } from "../hooks/useMentionSuggest";
import { MentionPopup } from "../components/chat/MentionPopup";

const EMPTY_MSGS: never[] = [];

export function ChannelView() {
  const { channelName } = useParams<{ channelName: string }>();
  const target = channelName ? `#${channelName}` : "";
  const messages = useMessageStore((s) => (target && s.messagesByTarget[target]) || EMPTY_MSGS);
  const fetchHistory = useMessageStore((s) => s.fetchHistory);
  const setActiveChannel = useChannelStore((s) => s.setActiveChannel);
  const [draft, setDraft] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { filtered, selectedIdx, visible, handleInput, handleKeyDown: mentionKD, insertMention: rawInsert } = useMentionSuggest(textareaRef);
  const insertMention = (handle: string) => {
    const newText = rawInsert(handle);
    if (newText) setDraft(newText);
  };
  const navigate = useNavigate();
  const fetchedRef = useRef<string | null>(null);


  
  // Load reply counts
  useEffect(() => {
    messages.forEach(async (msg: any) => {
      if (msg._replyCount !== undefined) return;
      try {
        const d = await apiClient('/api/messages/thread/' + msg.id, { method: "GET" }) as any;
        if (d && d.replies) {
          const count = d.replies.length;
          useMessageStore.setState(s => ({
            messagesByTarget: {
              ...s.messagesByTarget,
              [target]: (s.messagesByTarget[target] || []).map((m: any) =>
                m.id === msg.id ? { ...m, _replyCount: count } : m
              )
            }
          }));
        }
      } catch {}
    });
  }, [messages]);

  useEffect(() => {
    if (channelName && fetchedRef.current !== channelName) {
      fetchedRef.current = channelName;
      setActiveChannel(channelName);
      fetchHistory(target).catch(() => {});
    }
  }, [channelName]);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages]);

  const doSend = async () => {
    if (!draft.trim()) return;
    try {
      await apiClient("/api/messages/send", { method: "POST", body: { target, content: draft } });
      setDraft("");
      fetchHistory(target).catch(() => {});
    } catch (err) { console.error("Send failed", err); }
  };
  const handleSend = (e: React.FormEvent) => { e.preventDefault(); doSend(); };
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !visible) { e.preventDefault(); doSend(); }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-3">
        <h2 className="text-gray-900 dark:text-white font-bold">#{channelName}</h2>
        <button onClick={()=>navigate("/tasks/"+channelName)} className="text-gray-500 hover:text-blue-400 text-xs">
          看板
        </button>
      </div>
      </div>
      <div ref={containerRef} className="flex-1 p-4 overflow-y-auto space-y-3">
        {messages.length === 0 && (
          <p className="text-gray-500 text-center mt-8">暂无消息，发送第一条消息开始对话</p>
        )}
        {messages.map((msg: any) => (
          <div key={msg.id} className="group flex gap-3 hover:bg-gray-100 dark:bg-gray-800/50 p-2 rounded relative">
            <div className="w-8 h-8 rounded bg-gray-600 shrink-0 flex items-center justify-center text-xs text-gray-900 dark:text-white">
              {(msg.senderName || "?")[0]}
            </div>
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="font-semibold text-gray-900 dark:text-white text-sm">{msg.senderName || msg.senderId || "Unknown"}</span>
                <span className="text-gray-500 text-xs">
                  {new Date(msg.time || msg.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}{(msg.replyCount||0) > 0 ? "<span className=\"text-gray-500 hover:text-blue-400 text-xs ml-2 cursor-pointer\" onClick={() => navigate(\"/channels/\" + channelName + \"/\" + msg.id)}>💬 {msg.replyCount}</span>" : null}
                </span>
              </div>
              <p className="text-gray-700 dark:text-gray-300 text-sm whitespace-pre-wrap">{msg.content}</p><div className="flex items-center gap-3 mt-1"><button onClick={() => navigate("/channels/" + channelName + "/" + msg.id)} className="text-gray-600 hover:text-blue-400 text-xs">💬 {msg.replyCount > 0 ? msg.replyCount + " 条回复" : "回复"}</button></div>
            <div className="absolute right-2 top-2 hidden group-hover:flex gap-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow"><button onClick={() => navigator.clipboard.writeText(msg.content)} title="Copy" className="px-2 py-1 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:text-white hover:bg-gray-200 dark:bg-gray-700 rounded text-xs">Copy</button><button onClick={() => navigate("/channels/" + channelName + "/" + (msg.id||""))} title="Reply in thread" className="px-2 py-1 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:text-white hover:bg-gray-200 dark:bg-gray-700 rounded text-xs">{msg.reply_count > 0 ? msg.reply_count + " replies" : "Reply"}</button></div>
              {/* Hover action menu */}
              <div className="hidden group-hover:flex items-center gap-1 mt-1">
                <button onClick={() => navigator.clipboard.writeText(msg.content)}
                  title="复制" className="text-gray-500 hover:text-gray-900 dark:text-white text-xs px-1.5 py-0.5 rounded hover:bg-gray-200 dark:bg-gray-700">复制</button>
                <button onClick={() => {
                  navigate("/channels/" + channelName + "/" + (msg.id || ""));
                }} title="回复" className="text-gray-500 hover:text-gray-900 dark:text-white text-xs px-1.5 py-0.5 rounded hover:bg-gray-200 dark:bg-gray-700">{((msg._replyCount||0)>0)?msg._replyCount+" 💬":"回复"}</button>
                <button onClick={async () => {
                  try { await apiClient("/api/messages/" + msg.id + "/reactions", { method: "POST", body: { emoji: "👍" } }); }
                  catch {}
                }} title="👍" className="text-gray-500 hover:text-yellow-400 text-xs px-1.5 py-0.5 rounded hover:bg-gray-200 dark:bg-gray-700">👍</button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <form onSubmit={handleSend} className="p-4 border-t border-gray-200 dark:border-gray-700 relative">
        <MentionPopup items={filtered} selectedIdx={selectedIdx} onSelect={insertMention} />
        <textarea ref={textareaRef} value={draft}
          onChange={(e) => { setDraft(e.target.value); handleInput(); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px"; }}
          onKeyDown={e => { mentionKD(e); if (!visible && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); } } }
          placeholder={`发送消息到 #${channelName}... (@ 提及)`}
          rows={1}
          className="w-full p-2 rounded bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600 focus:outline-none focus:border-blue-500 resize-none text-sm"
        />
        <div className="flex justify-between mt-1 text-gray-600 text-xs">
          <span>Enter 发送 · Shift+Enter 换行 · 输入 @ 提及</span>
          {draft.length > 0 && <span>{draft.length}/4000</span>}
        </div>
      </form>
    </div>
  );
}
