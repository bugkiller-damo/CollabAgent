import { type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";

interface NavItemProps {
  to: string;
  icon?: ReactNode;
  children: ReactNode;
  end?: boolean;
}

export function NavItem({ to, icon, children, end = false }: NavItemProps) {
  const location = useLocation();
  const active = end ? location.pathname === to : location.pathname.startsWith(to);
  return (
    <Link
      to={to}
      className={[
        "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
        active
          ? "bg-gray-200 font-medium text-gray-900 dark:bg-gray-700 dark:text-white"
          : "text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white",
      ].join(" ")}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      <span className="truncate">{children}</span>
    </Link>
  );
}
