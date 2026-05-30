interface EmptyStateProps {
  icon?: string;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({ icon = "💬", title, description, actionLabel, onAction }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div className="text-5xl mb-4 opacity-60">{icon}</div>
      <h3 className="text-gray-700 dark:text-gray-300 font-medium text-base mb-1">{title}</h3>
      {description && <p className="text-gray-500 dark:text-gray-500 text-sm max-w-sm mb-4">{description}</p>}
      {actionLabel && onAction && (
        <button onClick={onAction} className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-500 text-sm">
          {actionLabel}
        </button>
      )}
    </div>
  );
}
