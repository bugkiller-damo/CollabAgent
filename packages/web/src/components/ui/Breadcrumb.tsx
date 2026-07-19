import { Link } from "react-router-dom";
import { type ReactNode } from "react";

interface BreadcrumbItem {
  label: string;
  to?: string;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
}

export function Breadcrumb({ items }: BreadcrumbProps) {
  return (
    <nav aria-label="breadcrumb" className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400">
      {items.map((item, idx) => {
        const isLast = idx === items.length - 1;
        return (
          <span key={idx} className="flex items-center gap-1.5">
            {idx > 0 && <span className="text-gray-300 dark:text-gray-600">/</span>}
            {item.to && !isLast ? (
              <Link to={item.to} className="hover:text-blue-500 hover:underline">
                {item.label}
              </Link>
            ) : (
              <span className={isLast ? "font-medium text-gray-900 dark:text-white" : ""}>{item.label}</span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
