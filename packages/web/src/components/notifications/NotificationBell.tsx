import React, { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useNotificationStore, type NotificationItem } from "../../stores/notificationStore";
import { readCsrf } from "../../api/client";

function timeAgo(iso: string): string {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return `${Math.floor(d)}秒前`;
  if (d < 3600) return `${Math.floor(d / 60)}分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)}小时前`;
  return `${Math.floor(d / 86400)}天前`;
}

const TYPE_ICON: Record<string, string> = {
  "@mention": "💬",
  task_assigned: "✅",
  dm: "📨",
  reminder: "⏰",
};

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const panelRef = useRef<HTMLDivElement>(null);
  const {
    notifications,
    unreadCount,
    loading,
    loadFromApi,
    markAsRead,
    markAllAsRead,
  } = useNotificationStore();

  useEffect(() => {
    loadFromApi();
  }, [loadFromApi]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleClick = async (n: NotificationItem) => {
    if (!n.read) {
      markAsRead(n.id);
      try {
        await fetch(`/api/notifications/${n.id}/read`, {
          method: "PATCH",
          credentials: "include",
          headers: { "X-CSRF-Token": readCsrf() || "" },
        });
      } catch { /* ignore */ }
    }
    if (n.channelId) {
      const meta = n.metadata || {};
      const channelName = meta.channelName;
      setOpen(false);
      if (channelName) {
        navigate(`/channels/${channelName}`);
      }
    }
  };

  const handleMarkAll = async () => {
    markAllAsRead();
    try {
      await fetch("/api/notifications/read", {
        method: "PATCH",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": readCsrf() || "",
        },
      });
    } catch { /* ignore */ }
  };

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen(!open)}
        className="relative p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition"
        title="通知"
        aria-label="通知"
      >
        <span className="text-xl">🔔</span>
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-xs rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-96 max-h-[480px] bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 z-50 overflow-hidden flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">通知</h3>
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAll}
                className="text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400"
              >
                全部已读
              </button>
            )}
          </div>
          <div className="overflow-y-auto flex-1">
            {loading && notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-gray-500 dark:text-gray-400 text-sm">
                加载中…
              </div>
            ) : notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-gray-500 dark:text-gray-400 text-sm">
                暂无通知
              </div>
            ) : (
              notifications.map((n) => (
                <button
                  key={n.id}
                  onClick={() => handleClick(n)}
                  className={`w-full text-left px-4 py-3 border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 transition flex gap-3 ${
                    !n.read ? "bg-blue-50 dark:bg-blue-900/20" : ""
                  }`}
                >
                  <span className="text-2xl flex-shrink-0">{TYPE_ICON[n.type] || "📌"}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate">
                        {n.title}
                      </p>
                      {!n.read && <span className="w-2 h-2 rounded-full bg-blue-500 mt-1 flex-shrink-0" />}
                    </div>
                    {n.body && (
                      <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 line-clamp-2">
                        {n.body}
                      </p>
                    )}
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                      {timeAgo(n.createdAt)}
                    </p>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

