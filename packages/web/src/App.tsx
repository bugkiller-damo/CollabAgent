import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { AuthGuard } from "./components/auth/AuthGuard";

// 路由级 lazy loading：每个页面独立 chunk，按需加载
// 所有组件使用 named export，用 .then() 桥接到 { default }
const ChannelView = lazy(() => import("./pages/ChannelView").then(m => ({ default: m.ChannelView })));
const DmView = lazy(() => import("./pages/DmView").then(m => ({ default: m.DmView })));
const ThreadView = lazy(() => import("./pages/ThreadView").then(m => ({ default: m.ThreadView })));
const TaskBoard = lazy(() => import("./pages/TaskBoard").then(m => ({ default: m.TaskBoard })));
const LoginPage = lazy(() => import("./pages/LoginPage").then(m => ({ default: m.LoginPage })));
const RegisterPage = lazy(() => import("./pages/RegisterPage").then(m => ({ default: m.RegisterPage })));
const ForgotPasswordPage = lazy(() => import("./pages/ForgotPasswordPage").then(m => ({ default: m.ForgotPasswordPage })));
const SettingsLayout = lazy(() => import("./pages/settings/SettingsLayout").then(m => ({ default: m.SettingsLayout })));
const ProfileSettings = lazy(() => import("./pages/settings/ProfileSettings").then(m => ({ default: m.ProfileSettings })));
const SecuritySettings = lazy(() => import("./pages/settings/SecuritySettings").then(m => ({ default: m.SecuritySettings })));
const AdminPanel = lazy(() => import("./pages/admin/AdminPanel").then(m => ({ default: m.AdminPanel })));
const AgentManagement = lazy(() => import("./pages/admin/AgentManagement").then(m => ({ default: m.AgentManagement })));
const ChannelManagement = lazy(() => import("./pages/admin/ChannelManagement").then(m => ({ default: m.ChannelManagement })));
const WorkspaceMembers = lazy(() => import("./pages/admin/WorkspaceMembers").then(m => ({ default: m.WorkspaceMembers })));
const MetricsDashboard = lazy(() => import("./pages/admin/MetricsDashboard").then(m => ({ default: m.MetricsDashboard })));
const ConnectWizard = lazy(() => import("./pages/ConnectWizard").then(m => ({ default: m.ConnectWizard })));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage").then(m => ({ default: m.NotFoundPage })));
const NotificationSettings = lazy(() => import("./pages/settings/NotificationSettings").then(m => ({ default: m.NotificationSettings })));
const IntegrationSettings = lazy(() => import("./pages/settings/IntegrationSettings").then(m => ({ default: m.IntegrationSettings })));

function SettingsPlaceholder({ title }: { title: string }) {
  return <div className="p-6 text-gray-400"><h2 className="text-white text-xl font-bold mb-2">{title}</h2><p>即将推出</p></div>;
}

/** Suspense fallback：轻量骨架屏，不额外引入组件 */
function PageLoading() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="flex flex-col items-center gap-3">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        <span className="text-gray-400 text-sm">加载中...</span>
      </div>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Suspense fallback={<PageLoading />}><LoginPage /></Suspense>} />
      <Route path="/register" element={<Suspense fallback={<PageLoading />}><RegisterPage /></Suspense>} />
      <Route path="/forgot-password" element={<Suspense fallback={<PageLoading />}><ForgotPasswordPage /></Suspense>} />
      <Route element={<AuthGuard />}>
        <Route element={<AppLayout />}>
          <Route path="/channels" element={<Navigate to="/channels/general" />} />
          <Route path="/channels/:channelName" element={<Suspense fallback={<PageLoading />}><ChannelView /></Suspense>} />
          <Route path="/channels/:channelName/:threadId" element={<Suspense fallback={<PageLoading />}><ThreadView /></Suspense>} />
          <Route path="/dm/:peerName" element={<Suspense fallback={<PageLoading />}><DmView /></Suspense>} />
          <Route path="/dm/:peerName/:threadId" element={<Suspense fallback={<PageLoading />}><ThreadView /></Suspense>} />
          <Route path="/tasks" element={<Suspense fallback={<PageLoading />}><TaskBoard /></Suspense>} />
          <Route path="/tasks/:channelName" element={<Suspense fallback={<PageLoading />}><TaskBoard /></Suspense>} />
          <Route path="/connect" element={<Suspense fallback={<PageLoading />}><ConnectWizard /></Suspense>} />
          <Route path="/settings" element={<Suspense fallback={<PageLoading />}><SettingsLayout /></Suspense>}>
            <Route path="profile" element={<Suspense fallback={<PageLoading />}><ProfileSettings /></Suspense>} />
              <Route path="security" element={<Suspense fallback={<PageLoading />}><SecuritySettings /></Suspense>} />
              <Route path="integrations" element={<Suspense fallback={<PageLoading />}><IntegrationSettings /></Suspense>} />
              <Route path="notifications" element={<Suspense fallback={<PageLoading />}><NotificationSettings /></Suspense>} />
          </Route>
          <Route path="/admin" element={<Suspense fallback={<PageLoading />}><AdminPanel /></Suspense>}>
              <Route path="agents" element={<Suspense fallback={<PageLoading />}><AgentManagement /></Suspense>} />
              <Route path="channels" element={<Suspense fallback={<PageLoading />}><ChannelManagement /></Suspense>} />
              <Route path="members" element={<Suspense fallback={<PageLoading />}><WorkspaceMembers /></Suspense>} />
              <Route path="metrics" element={<Suspense fallback={<PageLoading />}><MetricsDashboard /></Suspense>} />
            </Route>
          <Route path="/" element={<Navigate to="/channels/general" />} />
          <Route path="*" element={<Suspense fallback={<PageLoading />}><NotFoundPage /></Suspense>} />
        </Route>
      </Route>
    </Routes>
  );
}
