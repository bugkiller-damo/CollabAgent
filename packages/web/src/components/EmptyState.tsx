interface EmptyStateProps {
  icon?: string;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({ icon = "💬", title, description, actionLabel, onAction }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-16 text-center">
      <div className="mb-4 text-5xl opacity-60">{icon}</div>
      <h3 className="mb-1 text-base font-medium text-gray-700 dark:text-gray-300">{title}</h3>
      {description && <p className="mb-4 max-w-sm text-sm text-gray-500 dark:text-gray-500">{description}</p>}
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white transition-colors hover:bg-blue-500"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
