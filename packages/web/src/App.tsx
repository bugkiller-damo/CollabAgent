import { Routes, Route, Navigate, Outlet } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { ChannelView } from "./pages/ChannelView";
import { DmView } from "./pages/DmView";
import { ThreadView } from "./pages/ThreadView";
import { TaskBoard } from "./pages/TaskBoard";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage";
import { SettingsLayout } from "./pages/settings/SettingsLayout";
import { ProfileSettings } from "./pages/settings/ProfileSettings";
import { AdminPanel } from "./pages/admin/AdminPanel";
import { useAuthStore } from "./stores/authStore";

function AuthGuard() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <Outlet />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route element={<AuthGuard />}>
        <Route element={<AppLayout />}>
          <Route path="/channels" element={<Navigate to="/channels/general" />} />
          <Route path="/channels/:channelName" element={<ChannelView />} />
          <Route path="/channels/:channelName/:threadId" element={<ThreadView />} />
          <Route path="/dm/:peerName" element={<DmView />} />
          <Route path="/dm/:peerName/:threadId" element={<ThreadView />} />
          <Route path="/tasks" element={<TaskBoard />} />
          <Route path="/tasks/:channelName" element={<TaskBoard />} />
          <Route path="/settings" element={<SettingsLayout />}>
            <Route path="profile" element={<ProfileSettings />} />
          </Route>
          <Route path="/admin" element={<AdminPanel />} />
          <Route path="/" element={<Navigate to="/channels/general" />} />
        </Route>
      </Route>
    </Routes>
  );
}
