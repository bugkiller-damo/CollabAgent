import type { ReactNode } from "react";

interface SidebarSectionProps {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function SidebarSection({ title, action, children, className = "" }: SidebarSectionProps) {
  return (
    <div className={`space-y-0.5 ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between px-2 py-1.5">
          {title && (
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {title}
            </span>
          )}
          {action && <div className="flex items-center">{action}</div>}
        </div>
      )}
      {children}
    </div>
  );
}
