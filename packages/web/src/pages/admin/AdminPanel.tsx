import { Link, Outlet, useLocation } from "react-router-dom";

const tabs = [
  { to: "/admin/agents", label: "Agent 管理", desc: "注册、配置、监控 AI Agent" },
  { to: "/admin/channels", label: "频道管理", desc: "创建、归档、删除频道" },
  { to: "/admin/members", label: "成员管理", desc: "邀请、移除、角色分配" },
  { to: "/admin/metrics", label: "运行指标", desc: "在线状态、消息量、资源占用" },
];

export function AdminPanel() {
  const { pathname } = useLocation();
  const isRoot = pathname === "/admin";

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 顶部导航条：所有子页之间互相切换，「管理后台」回首页 */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0 overflow-x-auto">
        <Link to="/admin"
          className={"px-3 py-1.5 rounded text-sm font-semibold " +
            (isRoot ? "bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white" : "text-gray-500 hover:text-gray-900 dark:hover:text-white")}>
          管理后台
        </Link>
        <span className="text-gray-300 dark:text-gray-600">/</span>
        {tabs.map((t) => (
          <Link key={t.to} to={t.to}
            className={"px-3 py-1.5 rounded text-sm whitespace-nowrap " +
              (pathname.startsWith(t.to) ? "bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white" : "text-gray-500 hover:text-gray-900 dark:hover:text-white")}>
            {t.label}
          </Link>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {isRoot ? (
          <div className="p-6">
            <h2 className="text-gray-900 dark:text-white text-xl font-bold mb-4">管理后台</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {tabs.map((t) => (
                <Link key={t.to} to={t.to}
                  className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">
                  <h3 className="text-gray-900 dark:text-white font-semibold">{t.label}</h3>
                  <p className="text-gray-500 text-sm mt-2">{t.desc}</p>
                </Link>
              ))}
            </div>
          </div>
        ) : (
          <Outlet />
        )}
      </div>
    </div>
  );
}
