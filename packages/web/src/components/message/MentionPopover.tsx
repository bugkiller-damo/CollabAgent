import { useState, useEffect, useRef, useCallback } from 'react';
import { apiGet } from '../../api/client';

interface Member { id: string; handle: string; displayName?: string; type: string; }

export function MentionPopover({ query, channelName, onSelect, onClose }: {
  query: string; channelName: string; onSelect: (h: string) => void; onClose: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    apiGet<{ users: Member[]; agents: Member[] }>('/api/server/info')
      .then(d => setMembers([...(d.users || []), ...(d.agents || [])])).catch(() => {});
  }, []);
  const list = query ? members.filter(m => m.handle.toLowerCase().includes(query.toLowerCase())) : members;
  
  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, list.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && list[idx]) { e.preventDefault(); onSelect(list[idx].handle); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  }, [list, idx, onSelect, onClose]);
  
  useEffect(() => { window.addEventListener('keydown', handleKey); return () => window.removeEventListener('keydown', handleKey); }, [handleKey]);
  if (list.length === 0) return null;
  
  return (
    <div className="absolute bottom-full left-0 mb-1 w-64 max-h-48 overflow-y-auto bg-gray-800 border border-gray-600 rounded-lg shadow-xl z-50">
      {list.map((m, i) => (
        <button key={m.id} onClick={() => onSelect(m.handle)}
          className={"w-full text-left px-3 py-2 text-sm flex items-center gap-2 " + (i === idx ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-700')}>
          <span className="w-6 h-6 rounded bg-gray-600 flex items-center justify-center text-xs shrink-0">{m.handle[0]}</span>
          <div className="min-w-0"><span className="font-medium">@{m.handle}</span></div>
          <span className="text-[10px] text-gray-500 ml-auto">{m.type}</span>
        </button>
      ))}
    </div>
  );
}
