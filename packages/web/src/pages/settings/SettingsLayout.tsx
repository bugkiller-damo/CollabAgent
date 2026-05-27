import { Outlet, NavLink } from "react-router-dom";

export function SettingsLayout() {
  return (
    <div className="flex h-full">
      <nav className="w-48 p-4 border-r border-gray-700 space-y-1">
        <NavLink to="/settings/profile" className={({ isActive }) => `block p-2 rounded text-sm ${isActive ? "bg-gray-700 text-white" : "text-gray-400 hover:text-white"}`}>个人资料</NavLink>
      </nav>
      <div className="flex-1 p-6"><Outlet /></div>
    </div>
  );
}
