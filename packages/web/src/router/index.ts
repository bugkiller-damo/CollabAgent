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
            { path: "activity", component: () => import("../pages/ActivityView.vue") },
            { path: "people", component: () => import("../pages/PeopleView.vue") },
            { path: "search", component: () => import("../pages/SearchView.vue") },
            { path: "computers", component: () => import("../pages/ComputerView.vue") },
            { path: "computers/:id", component: () => import("../pages/ComputerView.vue") },
            { path: "connect", redirect: "/computers" },

            // 设置（嵌套：SettingsLayout + 子页面）——2026-09-17 IA 收敛：原 /admin 三页并入
            {
              path: "settings",
              component: () => import("../pages/settings/SettingsLayout.vue"),
              children: [
                { path: "profile", component: () => import("../pages/settings/ProfileSettings.vue") },
                { path: "security", component: () => import("../pages/settings/SecuritySettings.vue") },
                { path: "integrations", component: () => import("../pages/settings/IntegrationSettings.vue") },
                { path: "notifications", component: () => import("../pages/settings/NotificationSettings.vue") },
                { path: "members", component: () => import("../pages/settings/WorkspaceMembers.vue") },
                { path: "metrics", component: () => import("../pages/settings/MetricsDashboard.vue") },
              ],
            },

            // 旧 /admin 深链兼容重定向（书签/外部链接；站内引用已全部改指 /settings/*）
            { path: "admin", redirect: "/settings" },
            { path: "admin/channels", redirect: "/channels/general" },
            { path: "admin/members", redirect: "/settings/members" },
            { path: "admin/metrics", redirect: "/settings/metrics" },
            {
              path: "admin/agents",
              redirect: (to) => {
                const agent = to.query.agent;
                if (typeof agent === "string" && agent) {
                  return { path: "/people", query: { member: agent } };
                }
                return "/computers";
              },
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
