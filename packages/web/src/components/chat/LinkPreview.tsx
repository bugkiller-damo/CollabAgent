import { useEffect, useState } from "react";
import { apiGet } from "../../api/client";

interface Preview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

// 模块级缓存，避免重复抓取同一 URL
const cache = new Map<string, Preview | null>();

export function LinkPreview({ url }: { url: string }) {
  const [data, setData] = useState<Preview | null>(cache.get(url) ?? null);
  const [done, setDone] = useState(cache.has(url));

  useEffect(() => {
    if (cache.has(url)) { setData(cache.get(url) ?? null); setDone(true); return; }
    let alive = true;
    apiGet<Preview>("/api/preview", { url })
      .then((d) => { cache.set(url, d); if (alive) { setData(d); setDone(true); } })
      .catch(() => { cache.set(url, null); if (alive) { setData(null); setDone(true); } });
    return () => { alive = false; };
  }, [url]);

  if (!done || !data || (!data.title && !data.image && !data.description)) return null;

  return (
    <a href={data.url} target="_blank" rel="noopener noreferrer"
      className="flex gap-3 mt-1.5 max-w-md border border-gray-200 dark:border-gray-700 rounded overflow-hidden hover:bg-gray-50 dark:hover:bg-gray-800">
      {data.image && (
        <img src={data.image} alt="" loading="lazy" className="w-20 h-20 object-cover shrink-0" />
      )}
      <div className="min-w-0 py-2 pr-2">
        {data.siteName && <div className="text-[11px] text-gray-400 truncate">{data.siteName}</div>}
        {data.title && <div className="text-sm text-gray-800 dark:text-gray-200 font-medium truncate">{data.title}</div>}
        {data.description && <div className="text-xs text-gray-500 line-clamp-2">{data.description}</div>}
      </div>
    </a>
  );
}
