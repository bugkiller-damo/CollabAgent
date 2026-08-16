import { Link, Outlet, useLocation } from "react-router-dom";
import { PageHeader } from "../../components/layout/PageHeader";
import { NavItem } from "../../components/ui/NavItem";

const tabs = [
  { to: "/admin/agents", label: "Agent 管理", desc: "注册、配置、监控 AI Agent" },
  { to: "/admin/channels", label: "频道管理", desc: "创建、归档、删除频道" },
  { to: "/admin/members", label: "成员管理", desc: "邀请、移除、角色分配" },
  { to: "/admin/metrics", label: "运行指标", desc: "在线状态、消息量、资源占用" },
];

const agentIcon = (
  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z"
    />
  </svg>
);

const channelIcon = (
  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 8.25h13.5m-13.5 4.5h13.5m-13.5 4.5h13.5" />
  </svg>
);

const membersIcon = (
  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.295-2.228-.837-3.244M15 19.128c.956.6 2.04.872 3.124.872M7.5 14.251c.956.6 2.04.872 3.124.872 1.085 0 2.169-.273 3.124-.872M7.5 14.251c.63.394 1.343.6 2.076.6h.017c.734 0 1.446-.206 2.076-.6m-4.17-.6a4.125 4.125 0 0 1-7.532 2.493 9.337 9.337 0 0 1 4.121-.952 9.38 9.38 0 0 1 2.625.372m9.94 3.198-1.807-1.626a4.125 4.125 0 0 0-5.512 0l-1.806 1.626M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
    />
  </svg>
);

const metricsIcon = (
  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z"
    />
  </svg>
);

const icons = [agentIcon, channelIcon, membersIcon, metricsIcon];

export function AdminPanel() {
  const { pathname } = useLocation();
  const isRoot = pathname === "/admin";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="管理后台">
        <nav className="flex items-center gap-1 overflow-x-auto">
          {tabs.map((t, idx) => (
            <NavItem key={t.to} to={t.to} icon={icons[idx]}>
              {t.label}
            </NavItem>
          ))}
        </nav>
      </PageHeader>

      <div className="flex-1 overflow-y-auto">
        {isRoot ? (
          <div className="mx-auto w-full max-w-7xl p-4 sm:p-6">
            <h3 className="mb-4 text-base font-semibold text-gray-900 dark:text-white">管理概览</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {tabs.map((t, idx) => (
                <Link
                  key={t.to}
                  to={t.to}
                  className="rounded-lg border border-gray-200 bg-gray-50 p-4 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700"
                >
                  <div className="mb-2 text-gray-500 dark:text-gray-400">{icons[idx]}</div>
                  <h4 className="font-semibold text-gray-900 dark:text-white">{t.label}</h4>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t.desc}</p>
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
