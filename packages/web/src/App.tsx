import { Routes, Route, Navigate } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { ChannelView } from "./pages/ChannelView";
import { LoginPage } from "./pages/LoginPage";

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AppLayout />}>
        <Route path="/channels/:channelName" element={<ChannelView />} />
        <Route path="/" element={<Navigate to="/channels/general" />} />
      </Route>
    </Routes>
  );
}
