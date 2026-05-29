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
      <div className="p-4 border-b border-gray-700">
        <div className="flex items-center gap-3">
        <h2 className="text-white font-bold">#{channelName}</h2>
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
          <div key={msg.id} className="group flex gap-3 hover:bg-gray-800/50 p-2 rounded">
            <div className="w-8 h-8 rounded bg-gray-600 shrink-0 flex items-center justify-center text-xs text-white">
              {(msg.senderName || "?")[0]}
            </div>
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="font-semibold text-white text-sm">{msg.senderName || msg.senderId || "Unknown"}</span>
                <span className="text-gray-500 text-xs">
                  {new Date(msg.time || msg.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              <p className="text-gray-300 text-sm whitespace-pre-wrap">{msg.content}</p>
            </div>
          </div>
        ))}
      </div>
      <form onSubmit={handleSend} className="p-4 border-t border-gray-700 relative">
        <MentionPopup items={filtered} selectedIdx={selectedIdx} onSelect={insertMention} />
        <textarea ref={textareaRef} value={draft}
          onChange={(e) => { setDraft(e.target.value); handleInput(); resize(); }}
          onKeyDown={e => { mentionKD(e); if (!visible && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); } } }
          placeholder={`发送消息到 #${channelName}... (@ 提及)`}
          rows={1}
          className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600 focus:outline-none focus:border-blue-500 resize-none text-sm"
        />
        <div className="flex justify-between mt-1 text-gray-600 text-xs">
          <span>Enter 发送 · Shift+Enter 换行 · 输入 @ 提及</span>
          {draft.length > 0 && <span>{draft.length}/4000</span>}
        </div>
      </form>
    </div>
  );
}
