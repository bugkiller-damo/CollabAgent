import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Breadcrumb } from "../ui/Breadcrumb";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  breadcrumb?: { label: string; to?: string }[];
  leading?: ReactNode;
  backTo?: string;
  children?: ReactNode;
  className?: string;
}

const backIcon = (
  <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
  </svg>
);

export function PageHeader({ title, subtitle, breadcrumb, leading, backTo, children, className = "" }: PageHeaderProps) {
  return (
    <div className={`border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800 ${className}`}>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          {backTo && (
            <Link
              to={backTo}
              className="mr-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white"
              aria-label="返回"
            >
              {backIcon}
            </Link>
          )}
          {leading && <div className="shrink-0">{leading}</div>}
          <div className="min-w-0">
            {breadcrumb && breadcrumb.length > 0 && <div className="mb-1"><Breadcrumb items={breadcrumb} /></div>}
            <div className="flex items-center gap-2">
              <h2 className="shrink-0 text-lg font-bold text-gray-900 dark:text-white">{title}</h2>
              {subtitle && (
                <span
                  className="max-w-[10rem] truncate text-xs text-gray-500 dark:text-gray-400 sm:max-w-xs md:max-w-sm"
                  title={subtitle}
                >
                  {subtitle}
                </span>
              )}
            </div>
          </div>
        </div>
        {children && <div className="mt-2 flex shrink-0 items-center gap-2 sm:mt-0">{children}</div>}
      </div>
    </div>
  );
}
