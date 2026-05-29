import type { MouseEvent } from "react";

interface MentionCandidate {
  handle: string;
  displayName: string;
  type: "user" | "agent";
  id?: string;
}

interface Props {
  items: MentionCandidate[];
  selectedIdx: number;
  onSelect: (handle: string) => void;
}

export function MentionPopup({ items, selectedIdx, onSelect }: Props) {
  if (items.length === 0) return null;

  return (
    <div
      className="absolute z-50 bg-gray-800 border border-gray-600 rounded-lg shadow-xl overflow-hidden"
      style={{ bottom: "100%", left: "1rem", minWidth: "14rem", maxHeight: "15rem", overflowY: "auto", marginBottom: "4px" }}
      onMouseDown={(e: MouseEvent) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <button
          key={item.handle}
          className={"w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 " +
            (i === selectedIdx ? "bg-blue-600 text-white" : "text-gray-300 hover:bg-gray-700")}
          onMouseDown={(e: MouseEvent) => { e.preventDefault(); onSelect(item.handle); }}
        >
          <span className="w-5 h-5 rounded-full bg-gray-600 flex items-center justify-center text-[10px] shrink-0">
            {(item.displayName || item.handle)[0]}
          </span>
          <span className="font-medium truncate">@{item.handle}</span>
          {item.displayName && item.displayName !== item.handle && (
            <span className="text-gray-500 text-xs truncate">{item.displayName}</span>
          )}
          <span className="ml-auto text-[10px] opacity-50 shrink-0">
            {item.type === "agent" ? "Agent" : ""}
          </span>
        </button>
      ))}
    </div>
  );
}
