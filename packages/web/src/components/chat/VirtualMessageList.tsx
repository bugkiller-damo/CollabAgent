import { useRef, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { MessageRow } from "./MessageRow";
import { PendingRow, type PendingItem } from "./PendingRow";

export type ListItem =
  | { kind: "msg"; data: any }
  | { kind: "pending"; data: PendingItem };

interface Props {
  items: ListItem[];
  channelName?: string;
  onRetry: (tempId: string) => void;
  onDiscard: (tempId: string) => void;
}

export function VirtualMessageList({ items, channelName, onRetry, onDiscard }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(items.length);
  const didInitialScroll = useRef(false);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 72,
    overscan: 10,
    getItemKey: (i) => {
      const it = items[i];
      return it.kind === "msg" ? it.data.id : it.data.tempId;
    },
  });

  // 初次渲染滚动到底部
  useEffect(() => {
    if (!didInitialScroll.current && items.length > 0) {
      didInitialScroll.current = true;
      virtualizer.scrollToIndex(items.length - 1, { align: "end" });
    }
  }, [items.length, virtualizer]);

  // 新消息到达时，若已接近底部则自动滚到底
  useEffect(() => {
    const el = parentRef.current;
    if (el && items.length > prevCount.current) {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
      if (nearBottom) virtualizer.scrollToIndex(items.length - 1, { align: "end" });
    }
    prevCount.current = items.length;
  }, [items.length, virtualizer]);

  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto">
      <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const it = items[vi.index];
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start}px)` }}
              className="px-4 py-0.5"
            >
              {it.kind === "msg"
                ? <MessageRow msg={it.data} channelName={channelName} />
                : <PendingRow item={it.data} onRetry={onRetry} onDiscard={onDiscard} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
