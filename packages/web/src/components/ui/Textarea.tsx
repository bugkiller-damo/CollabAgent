import { forwardRef, type TextareaHTMLAttributes } from "react";

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className = "", ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={[
          "w-full resize-none rounded-md border border-gray-300 bg-gray-100 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400",
          "focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30",
          "dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:placeholder:text-gray-500",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        ].join(" ")}
        {...props}
      />
    );
  }
);
Textarea.displayName = "Textarea";
