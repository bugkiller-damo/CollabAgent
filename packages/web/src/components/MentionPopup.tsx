interface MentionCandidate {
  handle: string; displayName: string; type: "user" | "agent"; id: string;
}

interface Props {
  items: MentionCandidate[];
  selectedIdx: number;
  position: { top: number; left: number };
  onSelect: (handle: string) => void;
  onClose: () => void;
}

export function MentionPopup({ items, selectedIdx, position, onSelect, onClose }: Props) {
  if (items.length === 0) return null;
  return (
    <div className="fixed z-50" style={{ bottom: window.innerHeight - position.top + 10 + "px", left: position.left + "px" }}
      onMouseLeave={onClose}>
      <div className="bg-gray-800 border border-gray-600 rounded-lg shadow-xl w-64 max-h-48 overflow-y-auto">
        {items.map((item, i) => (
          <button key={item.id || item.handle}
            onClick={() => onSelect(item.handle)}
            className={"w-full text-left px-3 py-2 flex items-center gap-2 text-sm " +
              (i === selectedIdx ? "bg-blue-600 text-white" : "text-gray-300 hover:bg-gray-700")}>
            <span className={"w-6 h-6 rounded flex items-center justify-center text-xs font-bold shrink-0 " +
              (item.type === "agent" ? "bg-purple-600" : "bg-gray-600")}>
              {item.handle[0]?.toUpperCase() || "?"}
            </span>
            <div className="min-w-0">
              <div className="truncate font-semibold">@{item.handle}</div>
              <div className="text-xs truncate opacity-70">{item.displayName} · {item.type === "agent" ? "Agent" : "User"}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
