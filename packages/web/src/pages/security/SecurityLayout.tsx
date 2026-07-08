import { Link, Outlet, useLocation } from "react-router-dom";

const tabs = [
  { to: "/security/assets", label: "资产管理", desc: "资产发现、清单、指纹" },
  { to: "/security/tasks", label: "渗透任务", desc: "创建、状态、漏洞结果" },
  { to: "/security/cases", label: "病例库", desc: "病例检索、审核、分发" },
  { to: "/security/alerts", label: "告警中心", desc: "规则配置、告警历史" },
];

export function SecurityLayout() {
  const { pathname } = useLocation();
  const isRoot = pathname === "/security";

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-1 px-4 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0 overflow-x-auto">
        <Link to="/security" className={"px-3 py-1.5 rounded text-sm font-semibold " + (isRoot ? "bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white" : "text-gray-500 hover:text-gray-900 dark:hover:text-white")}>安全业务</Link>
        <span className="text-gray-300 dark:text-gray-600">/</span>
        {tabs.map((t) => (
          <Link key={t.to} to={t.to} className={"px-3 py-1.5 rounded text-sm whitespace-nowrap " + (pathname.startsWith(t.to) ? "bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white" : "text-gray-500 hover:text-gray-900 dark:hover:text-white")}>{t.label}</Link>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto">
        {isRoot ? (
          <div className="p-6">
            <h2 className="text-gray-900 dark:text-white text-xl font-bold mb-4">安全业务</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {tabs.map((t) => (
                <Link key={t.to} to={t.to} className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">
                  <h3 className="text-gray-900 dark:text-white font-semibold">{t.label}</h3>
                  <p className="text-gray-500 text-sm mt-2">{t.desc}</p>
                </Link>
              ))}
            </div>
          </div>
        ) : <Outlet />}
      </div>
    </div>
  );
}
