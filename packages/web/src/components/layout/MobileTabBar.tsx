import { Link, useLocation } from "react-router-dom";
import { useChannelStore } from "../../stores";

const tabs = [
  { to: "/channels/general", label: "频道", icon: channelIcon },
  { to: "/dm", label: "私信", icon: dmIcon },
  { to: "/tasks", label: "任务", icon: taskIcon },
  { to: "/settings/profile", label: "设置", icon: settingsIcon },
];

function channelIcon(active: boolean) {
  return (
    <svg
      className={`h-5 w-5 ${active ? "text-blue-500" : "text-gray-500 dark:text-gray-400"}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 8.25h13.5m-13.5 4.5h13.5m-13.5 4.5h13.5" />
    </svg>
  );
}

function dmIcon(active: boolean) {
  return (
    <svg
      className={`h-5 w-5 ${active ? "text-blue-500" : "text-gray-500 dark:text-gray-400"}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75"
      />
    </svg>
  );
}

function taskIcon(active: boolean) {
  return (
    <svg
      className={`h-5 w-5 ${active ? "text-blue-500" : "text-gray-500 dark:text-gray-400"}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z"
      />
    </svg>
  );
}

function settingsIcon(active: boolean) {
  return (
    <svg
      className={`h-5 w-5 ${active ? "text-blue-500" : "text-gray-500 dark:text-gray-400"}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.53 16.122a3 3 0 0 0-5.78 1.128 2.25 2.25 0 0 1-2.4 2.245 4.5 4.5 0 0 0-2.206.037A9.968 9.968 0 0 0 12 21a9.969 9.969 0 0 0 7.855-3.476 4.5 4.5 0 0 0-2.206-.037 2.25 2.25 0 0 1-2.4-2.245 3 3 0 0 0-5.78-1.121Zm7.806-9.124a2.25 2.25 0 0 1 2.25 2.25v.75h1.125a2.25 2.25 0 0 1 2.25 2.25v2.25a2.25 2.25 0 0 1-2.25 2.25h-9.75c-.621 0-1.125.504-1.125 1.125v2.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z"
      />
    </svg>
  );
}

export function MobileTabBar() {
  const location = useLocation();
  const activeChannelName = useChannelStore((s) => s.activeChannelName);
  const channelHref = activeChannelName ? `/channels/${activeChannelName}` : "/channels/general";

  const isActive = (path: string) => {
    if (path === "/dm") return location.pathname.startsWith("/dm");
    if (path === "/tasks") return location.pathname.startsWith("/tasks");
    if (path === "/settings/profile") return location.pathname.startsWith("/settings");
    return location.pathname.startsWith("/channels");
  };

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-gray-200 bg-white px-2 pb-safe lg:hidden dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-center justify-around">
        <Link
          to={channelHref}
          className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-xs transition-colors ${
            isActive("/channels") ? "font-medium text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-400"
          }`}
        >
          {channelIcon(isActive("/channels"))}
          频道
        </Link>
        <Link
          to="/dm"
          className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-xs transition-colors ${
            isActive("/dm") ? "font-medium text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-400"
          }`}
        >
          {dmIcon(isActive("/dm"))}
          私信
        </Link>
        <Link
          to="/tasks"
          className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-xs transition-colors ${
            isActive("/tasks") ? "font-medium text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-400"
          }`}
        >
          {taskIcon(isActive("/tasks"))}
          任务
        </Link>
        <Link
          to="/settings/profile"
          className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-xs transition-colors ${
            isActive("/settings/profile")
              ? "font-medium text-blue-600 dark:text-blue-400"
              : "text-gray-500 dark:text-gray-400"
          }`}
        >
          {settingsIcon(isActive("/settings/profile"))}
          设置
        </Link>
      </div>
    </nav>
  );
}
