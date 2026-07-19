import { type ButtonHTMLAttributes, type ReactNode } from "react";
import { Tooltip } from "./Tooltip";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  label: string;
  tooltip?: string;
  tooltipPosition?: "top" | "bottom" | "left" | "right";
}

export function IconButton({
  children,
  label,
  tooltip,
  tooltipPosition = "bottom",
  className = "",
  ...props
}: IconButtonProps) {
  const button = (
    <button
      type="button"
      aria-label={label}
      className={[
        "inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-500 transition-colors",
        "hover:bg-gray-100 hover:text-gray-900",
        "dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white",
        "disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.98]",
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </button>
  );

  if (!tooltip) return button;

  return (
    <Tooltip label={tooltip} position={tooltipPosition}>
      {button}
    </Tooltip>
  );
}
