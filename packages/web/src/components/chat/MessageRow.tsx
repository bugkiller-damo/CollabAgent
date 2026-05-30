import { useState, memo } from "react";
import { useNavigate } from "react-router-dom";
import { apiClient } from "../../api/client";
import { useAuthStore, useMessageStore } from "../../stores";
import { MarkdownContent } from "./MarkdownContent";
import { AttachmentView } from "./AttachmentView";
import { LinkPreview } from "./LinkPreview";

function MessageRowBase({ msg, channelName }: { msg: any; channelName?: string }) {
  const navigate = useNavigate();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const editMessage = useMessageStore((s) => s.editMessage);
  const replyCount = msg._replyCount ?? msg.replyCount ?? msg.reply_count ?? 0;
  const isOwn = currentUserId && msg.senderId && String(msg.senderId) === String(currentUserId);
  const edited = msg.editedAt || msg.edited_at;
  const firstUrl = (msg.content?.match(/https?:\/\/[^\s<>()]+/) || [])[0];

  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(msg.content || "");

  const saveEdit = async () => {
    const text = editText.trim();
    if (!text || text === msg.content) { setEditing(false); return; }
    try {
      await editMessage(msg.id, text);
      setEditing(false);
    } catch {
      // keep editing open on failure
    }
  };

  return (
    <div className="group flex gap-3 hover:bg-gray-100 dark:hover:bg-gray-800/50 p-2 rounded relative">
      <div className="w-8 h-8 rounded bg-gray-600 shrink-0 flex items-center justify-center text-xs text-white">
        {(msg.senderName || "?")[0]}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-gray-900 dark:text-white text-sm">{msg.senderName || msg.senderId || "Unknown"}</span>
          <span className="text-gray-500 text-xs">
            {new Date(msg.time || msg.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
          </span>
          {edited && <span className="text-gray-400 text-xs">(已编辑)</span>}
        </div>

        {editing ? (
          <div className="mt-1">
            <textarea
              autoFocus
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit(); }
                if (e.key === "Escape") { setEditing(false); setEditText(msg.content || ""); }
              }}
              rows={2}
              className="w-full p-2 rounded bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600 text-sm resize-none"
            />
            <div className="text-xs text-gray-400 mt-0.5">
              Enter 保存 · Esc 取消
              <button onClick={saveEdit} className="ml-2 text-blue-500 hover:underline">保存</button>
              <button onClick={() => { setEditing(false); setEditText(msg.content || ""); }} className="ml-2 hover:underline">取消</button>
            </div>
          </div>
        ) : (
          <>
            {msg.content && <MarkdownContent content={msg.content} />}
            {msg.attachments && msg.attachments.length > 0 && <AttachmentView attachments={msg.attachments} />}
            {firstUrl && <LinkPreview url={firstUrl} />}
            <div className="flex items-center gap-1 mt-1">
              <button onClick={() => navigate("/channels/" + channelName + "/" + msg.id)}
                className="text-gray-500 hover:text-blue-400 text-xs px-1.5 py-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700">
                💬 {replyCount > 0 ? replyCount + " 条回复" : "回复"}
              </button>
              <button onClick={() => navigator.clipboard.writeText(msg.content)}
                className="text-gray-500 hover:text-gray-900 dark:hover:text-white text-xs px-1.5 py-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 opacity-0 group-hover:opacity-100">
                复制
              </button>
              {isOwn && (
                <button onClick={() => { setEditText(msg.content || ""); setEditing(true); }}
                  className="text-gray-500 hover:text-gray-900 dark:hover:text-white text-xs px-1.5 py-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 opacity-0 group-hover:opacity-100">
                  编辑
                </button>
              )}
              <button onClick={async () => { try { await apiClient("/api/messages/" + msg.id + "/reactions", { method: "POST", body: { emoji: "👍" } }); } catch {} }}
                className="text-gray-500 hover:text-yellow-400 text-xs px-1.5 py-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 opacity-0 group-hover:opacity-100">
                👍
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export const MessageRow = memo(MessageRowBase);
