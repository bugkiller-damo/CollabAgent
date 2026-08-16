import { createRouter, createWebHistory } from "vue-router";
import AuthGuard from "../components/auth/AuthGuard.vue";
import AppLayout from "../components/layout/AppLayout.vue";

/**
 * 路由表与 packages/web/src/App.tsx 的 Route 定义一一对应。
 *
 * 结构对照（React Router v7 → vue-router 4）：
 * - <Route element={<AuthGuard />}>           → path:"/" 的 AuthGuard 父路由（内部 <router-view>）。
 * - <Route element={<AppLayout />}>           → AuthGuard 子级的 AppLayout 父路由（内部 <router-view>）。
 * - <Navigate to="/channels/general" />       → redirect 选项。
 * - React Router v7 的 path="*"              → "/:pathMatch(.*)*"。
 * - 嵌套 <Route>（settings / admin）          → children 嵌套路由，父组件内置 <router-view>。
 * - 路由级 lazy loading                      → () => import(...)，每个页面独立 chunk。
 */

const router = createRouter({
  history: createWebHistory(),
  routes: [
    // 公开路由（React 版在 AuthGuard 之外）
    { path: "/login", component: () => import("../pages/LoginPage.vue") },
    { path: "/register", component: () => import("../pages/RegisterPage.vue") },
    { path: "/forgot-password", component: () => import("../pages/ForgotPasswordPage.vue") },

    // 受保护路由：AuthGuard → AppLayout → 页面
    {
      path: "/",
      component: AuthGuard,
      children: [
        {
          path: "",
          component: AppLayout,
          children: [
            // 频道 / DM / 任务
            { path: "channels", redirect: "/channels/general" },
            { path: "channels/:channelName", component: () => import("../pages/ChannelView.vue") },
            { path: "channels/:channelName/:threadId", component: () => import("../pages/ThreadView.vue") },
            { path: "dm/:peerName", component: () => import("../pages/DmView.vue") },
            { path: "dm/:peerName/:threadId", component: () => import("../pages/ThreadView.vue") },
            { path: "tasks", component: () => import("../pages/TaskBoard.vue") },
            { path: "tasks/:channelName", component: () => import("../pages/TaskBoard.vue") },
            { path: "connect", component: () => import("../pages/ConnectWizard.vue") },

            // 设置（嵌套：SettingsLayout + 子页面）
            {
              path: "settings",
              component: () => import("../pages/settings/SettingsLayout.vue"),
              children: [
                { path: "profile", component: () => import("../pages/settings/ProfileSettings.vue") },
                { path: "security", component: () => import("../pages/settings/SecuritySettings.vue") },
                { path: "integrations", component: () => import("../pages/settings/IntegrationSettings.vue") },
                { path: "notifications", component: () => import("../pages/settings/NotificationSettings.vue") },
              ],
            },

            // 管理后台（嵌套：AdminPanel + 子页面）
            {
              path: "admin",
              component: () => import("../pages/admin/AdminPanel.vue"),
              children: [
                { path: "agents", component: () => import("../pages/admin/AgentManagement.vue") },
                { path: "channels", component: () => import("../pages/admin/ChannelManagement.vue") },
                { path: "members", component: () => import("../pages/admin/WorkspaceMembers.vue") },
                { path: "metrics", component: () => import("../pages/admin/MetricsDashboard.vue") },
              ],
            },

            // 根路径重定向 & 404
            { path: "", redirect: "/channels/general" },
            { path: ":pathMatch(.*)*", component: () => import("../pages/NotFoundPage.vue") },
          ],
        },
      ],
    },
  ],
});

export default router;
