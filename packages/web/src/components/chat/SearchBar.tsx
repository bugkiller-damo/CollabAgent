import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet } from "../../api/client";
import { formatTime } from "../../lib/formatTime";
import { MarkdownContent } from "./MarkdownContent";

interface SearchResult {
  id: string;
  content: string;
  channelId: string;
  seq: number;
  time: string;
}

export function SearchBar() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const debounceRef = useRef<number>(undefined as unknown as number);

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); return; }
    setLoading(true);
    try {
      const data = await apiGet<{ results: SearchResult[] }>("/api/messages/search", { q });
      setResults(data.results || []);
      setOpen(true);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleInput = (val: string) => {
    setQuery(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(val), 300);
  };

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node) &&
          inputRef.current && !inputRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const navigateTo = (r: SearchResult) => {
    setOpen(false);
    setQuery("");
    const ch = r.channelId?.startsWith("#") ? r.channelId.slice(1) : r.channelId;
    navigate(`/channels/${ch}#${r.id}`);
  };

  return (
    <div className="relative flex-1 max-w-sm">
      <div className="relative">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-sm">🔍</span>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleInput(e.target.value)}
          onFocus={() => { if (results.length > 0) setOpen(true); }}
          onKeyDown={(e) => { if (e.key === "Escape") { setOpen(false); inputRef.current?.blur(); } }}
          placeholder="搜索消息..."
          className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white text-sm border border-transparent focus:outline-none focus:border-blue-500 placeholder-gray-400"
        />
        {loading && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-xs">⏳</span>}
      </div>

      {open && results.length > 0 && (
        <div
          ref={panelRef}
          className="absolute top-full mt-1 left-0 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-50 max-h-80 overflow-y-auto"
        >
          <p className="text-xs text-gray-400 px-3 py-1.5 border-b border-gray-100 dark:border-gray-700">
            找到 {results.length} 条结果
          </p>
          {results.map((r) => (
            <button
              key={r.id}
              onClick={() => navigateTo(r)}
              className="w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 border-b border-gray-50 dark:border-gray-700/50 last:border-0"
            >
              <div className="flex items-center gap-2 text-xs text-gray-500 mb-0.5">
                <span>{r.channelId || "?"}</span>
                <span>·</span>
                <span>{formatTime(r.time)}</span>
              </div>
              <div className="text-sm text-gray-900 dark:text-white line-clamp-2 [&_*]:!text-sm [&_*]:!leading-snug">
                <MarkdownContent content={r.content} />
              </div>
            </button>
          ))}
        </div>
      )}

      {open && query && !loading && results.length === 0 && (
        <div ref={panelRef} className="absolute top-full mt-1 left-0 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-50 p-4 text-center text-gray-500 text-sm">
          没有找到匹配的消息
        </div>
      )}
    </div>
  );
}
