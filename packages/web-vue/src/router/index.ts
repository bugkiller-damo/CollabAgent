import { createRouter, createWebHistory } from "vue-router";
import PlaceholderPage from "../pages/PlaceholderPage.vue";

/**
 * 路由表与 packages/web/src/App.tsx 的 Route 定义一一对应。
 * 迁移期所有路由统一指向 PlaceholderPage；
 * meta.sourceComponent 保留 React 版原组件名，便于逐页替换时对照。
 *
 * 与 React 版的结构差异：
 * - <Navigate to="/channels/general" /> → vue-router 的 redirect 选项（/ 与 /channels）。
 * - <AuthGuard /> 暂不迁移为组件，后续应实现为 router.beforeEach 全局守卫。
 * - <AppLayout /> 后续作为 /channels 等受保护路由的公共布局父路由重新引入。
 * - React Router v7 的 path="*" → vue-router 4 的 "/:pathMatch(.*)*"。
 * - settings / admin 的嵌套子路由保留嵌套结构，PlaceholderPage 内置 <router-view />
 *   充当 React Router <Outlet /> 的等效物。
 */
const router = createRouter({
  history: createWebHistory(),
  routes: [
    // 公开路由（React 版在 AuthGuard 之外）
    { path: "/login", component: PlaceholderPage, meta: { sourceComponent: "LoginPage" } },
    { path: "/register", component: PlaceholderPage, meta: { sourceComponent: "RegisterPage" } },
    { path: "/forgot-password", component: PlaceholderPage, meta: { sourceComponent: "ForgotPasswordPage" } },

    // 频道 / DM / 任务（React 版在 AuthGuard + AppLayout 之内）
    { path: "/channels", redirect: "/channels/general" },
    { path: "/channels/:channelName", component: PlaceholderPage, meta: { sourceComponent: "ChannelView" } },
    { path: "/channels/:channelName/:threadId", component: PlaceholderPage, meta: { sourceComponent: "ThreadView" } },
    { path: "/dm/:peerName", component: PlaceholderPage, meta: { sourceComponent: "DmView" } },
    { path: "/dm/:peerName/:threadId", component: PlaceholderPage, meta: { sourceComponent: "ThreadView" } },
    { path: "/tasks", component: PlaceholderPage, meta: { sourceComponent: "TaskBoard" } },
    { path: "/tasks/:channelName", component: PlaceholderPage, meta: { sourceComponent: "TaskBoard" } },
    { path: "/connect", component: PlaceholderPage, meta: { sourceComponent: "ConnectWizard" } },

    // 设置（嵌套：SettingsLayout + 子页面）
    {
      path: "/settings",
      component: PlaceholderPage,
      meta: { sourceComponent: "SettingsLayout" },
      children: [
        { path: "profile", component: PlaceholderPage, meta: { sourceComponent: "ProfileSettings" } },
        { path: "security", component: PlaceholderPage, meta: { sourceComponent: "SecuritySettings" } },
        { path: "integrations", component: PlaceholderPage, meta: { sourceComponent: "IntegrationSettings" } },
        { path: "notifications", component: PlaceholderPage, meta: { sourceComponent: "NotificationSettings" } },
      ],
    },

    // 管理后台（嵌套：AdminPanel + 子页面）
    {
      path: "/admin",
      component: PlaceholderPage,
      meta: { sourceComponent: "AdminPanel" },
      children: [
        { path: "agents", component: PlaceholderPage, meta: { sourceComponent: "AgentManagement" } },
        { path: "channels", component: PlaceholderPage, meta: { sourceComponent: "ChannelManagement" } },
        { path: "members", component: PlaceholderPage, meta: { sourceComponent: "WorkspaceMembers" } },
        { path: "metrics", component: PlaceholderPage, meta: { sourceComponent: "MetricsDashboard" } },
      ],
    },

    // 根路径重定向 & 404（对应 React 版 path="/" 的 Navigate 与 path="*" 的 NotFoundPage）
    { path: "/", redirect: "/channels/general" },
    { path: "/:pathMatch(.*)*", component: PlaceholderPage, meta: { sourceComponent: "NotFoundPage" } },
  ],
});

export default router;
