import { Navigate, Outlet } from "react-router-dom";
import { useAuthStore } from "../../stores";

export function AuthGuard() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}

export function GuestGuard() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  if (isAuthenticated) {
    return <Navigate to="/channels/general" replace />;
  }

  return <Outlet />;
}
