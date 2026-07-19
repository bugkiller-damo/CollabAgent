interface AvatarProps {
  name: string;
  src?: string;
  size?: "sm" | "md" | "lg" | "xl";
  online?: boolean;
  className?: string;
}

const sizeMap = {
  sm: { box: "w-6 h-6", text: "text-[10px]", dot: "w-2 h-2" },
  md: { box: "w-8 h-8", text: "text-xs", dot: "w-2.5 h-2.5" },
  lg: { box: "w-10 h-10", text: "text-sm", dot: "w-3 h-3" },
  xl: { box: "w-14 h-14", text: "text-xl", dot: "w-3.5 h-3.5" },
};

export function Avatar({ name, src, size = "md", online, className = "" }: AvatarProps) {
  const s = sizeMap[size];
  const initial = (name || "?")[0].toUpperCase();
  return (
    <div className={`relative inline-flex shrink-0 ${className}`}>
      {src ? (
        <img src={src} alt={name} className={`${s.box} rounded-full object-cover`} />
      ) : (
        <div
          className={`${s.box} rounded-full bg-gray-500 dark:bg-gray-600 flex items-center justify-center font-medium text-white ${s.text}`}
        >
          {initial}
        </div>
      )}
      {typeof online === "boolean" && (
        <span
          className={`absolute -bottom-0.5 -right-0.5 ${s.dot} rounded-full border-2 border-gray-50 dark:border-gray-800 ${
            online ? "bg-green-500" : "bg-gray-400"
          }`}
        />
      )}
    </div>
  );
}
