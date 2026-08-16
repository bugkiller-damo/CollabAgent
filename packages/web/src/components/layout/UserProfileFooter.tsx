import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore, useUiStore } from "../../stores";
import { Avatar } from "../ui/Avatar";

const sunIcon = (
  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"
    />
  </svg>
);

const moonIcon = (
  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z"
    />
  </svg>
);

const settingsIcon = (
  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M9.53 16.122a3 3 0 0 0-5.78 1.128 2.25 2.25 0 0 1-2.4 2.245 4.5 4.5 0 0 0-2.206.037A9.968 9.968 0 0 0 12 21a9.969 9.969 0 0 0 7.855-3.476 4.5 4.5 0 0 0-2.206-.037 2.25 2.25 0 0 1-2.4-2.245 3 3 0 0 0-5.78-1.121Zm7.806-9.124a2.25 2.25 0 0 1 2.25 2.25v.75h1.125a2.25 2.25 0 0 1 2.25 2.25v2.25a2.25 2.25 0 0 1-2.25 2.25h-.75v.75a2.25 2.25 0 0 1-2.25 2.25h-2.25a2.25 2.25 0 0 1-2.25-2.25v-.75h-1.125a2.25 2.25 0 0 1-2.25-2.25v-2.25a2.25 2.25 0 0 1 2.25-2.25h.75v-.75a2.25 2.25 0 0 1 2.25-2.25h2.25Z"
    />
  </svg>
);

const logoutIcon = (
  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9"
    />
  </svg>
);

export function UserProfileFooter() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const displayName = user?.displayName || user?.handle || "User";

  return (
    <div ref={ref} className="relative border-t border-gray-200 p-2 dark:border-gray-700">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md p-2 text-left transition-colors hover:bg-gray-200 dark:hover:bg-gray-700"
      >
        <Avatar name={displayName} src={(user as any)?.avatarUrl} size="md" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-gray-900 dark:text-white">{displayName}</p>
          <p className="truncate text-xs text-gray-500">@{user?.handle || "unknown"}</p>
        </div>
        <svg
          className="h-4 w-4 shrink-0 text-gray-400"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full left-2 right-2 mb-1 rounded-lg border border-gray-200 bg-white py-1 shadow-lg animate-scale-in origin-bottom-left dark:border-gray-700 dark:bg-gray-800">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              navigate("/settings/profile");
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <span className="shrink-0">{settingsIcon}</span>
            设置
          </button>
          <button
            type="button"
            onClick={() => {
              setTheme(theme === "dark" ? "light" : "dark");
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <span className="shrink-0">{theme === "dark" ? sunIcon : moonIcon}</span>
            {theme === "dark" ? "浅色模式" : "深色模式"}
          </button>
          <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
          <button
            type="button"
            onClick={handleLogout}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
          >
            <span className="shrink-0">{logoutIcon}</span>
            退出登录
          </button>
        </div>
      )}
    </div>
  );
}
