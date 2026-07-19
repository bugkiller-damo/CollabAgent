import { useState, type ReactNode } from "react";

interface TooltipProps {
  children: ReactNode;
  label: string;
  position?: "top" | "bottom" | "left" | "right";
}

const positionClasses = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-1.5",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-1.5",
  left: "right-full top-1/2 -translate-y-1/2 mr-1.5",
  right: "left-full top-1/2 -translate-y-1/2 ml-1.5",
};

export function Tooltip({ children, label, position = "bottom" }: TooltipProps) {
  const [show, setShow] = useState(false);

  return (
    <div
      className="relative flex items-center justify-center"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
    >
      {children}
      {show && (
        <div
          className={[
            "pointer-events-none absolute z-50 whitespace-nowrap rounded-md",
            "bg-gray-900 px-2 py-1 text-xs text-white shadow-lg",
            "dark:bg-gray-700",
            "animate-fade-in",
            positionClasses[position],
          ].join(" ")}
          role="tooltip"
        >
          {label}
        </div>
      )}
    </div>
  );
}
