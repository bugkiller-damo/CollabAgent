import { Outlet, useLocation, useNavigate } from "react-router-dom";

export function SettingsLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const isActive = (path: string) => location.pathname === path;

  const linkCls = (path: string) =>
    "block p-2 rounded text-sm " + (isActive(path) ? "bg-gray-700 text-white" : "text-gray-400 hover:text-white");

  return (
    <div className="flex h-full">
      <nav className="w-48 p-4 border-r border-gray-700 space-y-1">
        <button onClick={() => navigate("/settings/profile")} className={linkCls("/settings/profile")}>个人资料</button>
        <button onClick={() => navigate("/settings/security")} className={linkCls("/settings/security")}>安全与账户</button>
        <button className="block p-2 rounded text-sm text-gray-500">集成</button>
        <button className="block p-2 rounded text-sm text-gray-500">通知</button>
      </nav>
      <div className="flex-1 p-6"><Outlet /></div>
    </div>
  );
}
