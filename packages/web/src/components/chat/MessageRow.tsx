import { useState, memo } from "react";
import { useNavigate } from "react-router-dom";
import { apiClient } from "../../api/client";
import { useAuthStore, useMessageStore } from "../../stores";
import { toast } from "../../stores/toastStore";
import { ConfirmDialog } from "../ConfirmDialog";
import { formatTime } from "../../lib/formatTime";
import { MarkdownContent } from "./MarkdownContent";
import { AttachmentView } from "./AttachmentView";
import { LinkPreview } from "./LinkPreview";

const EMOJI_CHOICES = ["👍", "❤️", "😂", "🎉", "🤔", "👀"];

// 消息高亮闪烁动画（淡黄色背景 → 渐变为透明，3s 完成）
const highlightStyleId = "msg-highlight-style";
if (typeof document !== "undefined" && !document.getElementById(highlightStyleId)) {
  const s = document.createElement("style");
  s.id = highlightStyleId;
  s.textContent = `
    @keyframes msgHighlight {
      0% { background-color: rgba(234, 179, 8, 0.25); }
      100% { background-color: transparent; }
    }
    .animate-highlight {
      animation: msgHighlight 3s ease-out forwards;
    }
  `;
  document.head.appendChild(s);
}

function MessageRowBase({ msg, channelName, isHighlighted }: { msg: any; channelName?: string; isHighlighted?: boolean }) {
  const navigate = useNavigate();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const editMessage = useMessageStore((s) => s.editMessage);
  const deleteMessage = useMessageStore((s) => s.deleteMessage);
  const addReaction = useMessageStore((s) => s.addReaction);
  const removeReaction = useMessageStore((s) => s.removeReaction);
  const replyCount = msg._replyCount ?? msg.replyCount ?? msg.reply_count ?? 0;
  const isOwn = currentUserId && msg.senderId && String(msg.senderId) === String(currentUserId);
  const edited = msg.editedAt || msg.edited_at;
  const deleted = msg.deleted;
  const firstUrl = (msg.content?.match(/https?:\/\/[^\s<>()]+/) || [])[0];
  const reactions: { emoji: string; userIds: string[] }[] = msg.reactions || [];

  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(msg.content || "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);

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

  const handleDelete = async () => {
    setConfirmDelete(false);
    try {
      await deleteMessage(msg.id);
      toast.success("消息已删除");
    } catch (err: any) {
      toast.error(err?.message || "删除失败");
    }
  };

  const handleReactionClick = async (emoji: string) => {
    if (!currentUserId) return;
    const existing = reactions.find((r) => r.emoji === emoji);
    const hasMy = existing?.userIds.includes(String(currentUserId));
    try {
      if (hasMy) {
        await removeReaction(msg.id, emoji, String(currentUserId));
      } else {
        await addReaction(msg.id, emoji, String(currentUserId));
      }
    } catch (err: any) {
      toast.error(err?.message || "操作失败");
    }
  };

  return (
    <div className={`group flex gap-3 hover:bg-gray-100 dark:hover:bg-gray-800/50 p-2 rounded relative ${isHighlighted ? "animate-highlight" : ""}`}>
      <div className="w-8 h-8 rounded bg-gray-600 shrink-0 flex items-center justify-center text-xs text-white">
        {(msg.senderName || "?")[0]}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-gray-900 dark:text-white text-sm">{msg.senderName || msg.senderId || "Unknown"}</span>
          <span className="text-gray-500 text-xs" title={new Date(msg.time || msg.createdAt).toLocaleString()}>
            {formatTime(msg.time || msg.createdAt)}
          </span>
          {edited && <span className="text-gray-400 text-xs">(已编辑)</span>}
          {deleted && <span className="text-gray-400 text-xs italic">(已删除)</span>}
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
            {deleted ? (
              <p className="text-gray-400 italic text-sm mt-0.5">此消息已删除</p>
            ) : (
              <>
                {msg.content && <MarkdownContent content={msg.content} />}
                {msg.attachments && msg.attachments.length > 0 && <AttachmentView attachments={msg.attachments} />}
                {firstUrl && <LinkPreview url={firstUrl} />}
              </>
            )}

            {/* Reactions chips */}
            {reactions.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {reactions.map((r) => {
                  const hasMy = currentUserId && r.userIds.includes(String(currentUserId));
                  return (
                    <button
                      key={r.emoji}
                      onClick={() => handleReactionClick(r.emoji)}
                      className={`text-xs px-1.5 py-0.5 rounded border ${hasMy ? "bg-blue-100 dark:bg-blue-900/40 border-blue-300 dark:border-blue-700" : "bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700"} hover:opacity-80`}
                      title={`${r.userIds.length} 人`}
                    >
                      {r.emoji} {r.userIds.length}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="flex items-center gap-1 mt-1 relative">
              <button onClick={() => navigate("/channels/" + channelName + "/" + msg.id)}
                className="text-gray-500 hover:text-blue-400 text-xs px-1.5 py-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700">
                💬 {replyCount > 0 ? replyCount + " 条回复" : "回复"}
              </button>
              <button onClick={() => navigator.clipboard.writeText(msg.content || "")}
                className="text-gray-500 hover:text-gray-900 dark:hover:text-white text-xs px-1.5 py-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 opacity-0 group-hover:opacity-100">
                复制
              </button>
              {isOwn && !deleted && (
                <>
                  <button onClick={() => { setEditText(msg.content || ""); setEditing(true); }}
                    className="text-gray-500 hover:text-gray-900 dark:hover:text-white text-xs px-1.5 py-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 opacity-0 group-hover:opacity-100">
                    编辑
                  </button>
                  <button onClick={() => setConfirmDelete(true)}
                    className="text-red-500 hover:text-red-600 text-xs px-1.5 py-0.5 rounded hover:bg-red-50 dark:hover:bg-red-900/30"
                    title="删除消息">
                    🗑 删除
                  </button>
                </>
              )}
              {!deleted && (
                <>
                  <button onClick={() => setEmojiPickerOpen((v) => !v)}
                    className="text-gray-500 hover:text-yellow-400 text-xs px-1.5 py-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 opacity-0 group-hover:opacity-100">
                    😀
                  </button>
                  {emojiPickerOpen && (
                    <div className="absolute right-0 top-6 z-10 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-1 flex gap-0.5">
                      {EMOJI_CHOICES.map((e) => (
                        <button
                          key={e}
                          onClick={() => { handleReactionClick(e); setEmojiPickerOpen(false); }}
                          className="text-lg w-7 h-7 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
                        >
                          {e}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="删除消息"
          message="确认删除这条消息？此操作不可撤销。"
          confirmLabel="删除"
          danger
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

export const MessageRow = memo(MessageRowBase);
