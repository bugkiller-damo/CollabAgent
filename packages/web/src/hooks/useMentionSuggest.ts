import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "../api/client";

interface MentionCandidate {
  handle: string;
  displayName: string;
  type: "user" | "agent";
  id: string;
}

/** 提及候选的作用域：私有/DM 频道只列出已加入的成员（与服务端唤醒规则一致），
 *  公开频道维持全量候选（@ 会自动入圈）。 */
export interface MentionScope {
  channelId?: string;
  channelType?: string;
}

export function useMentionSuggest(textareaRef: React.RefObject<HTMLTextAreaElement | null>, scope?: MentionScope) {
  const [candidates, setCandidates] = useState<MentionCandidate[]>([]);
  // mentionActive：光标前存在未闭合的 "@"（弹窗会话进行中）
  const [mentionActive, setMentionActive] = useState(false);
  const [filtered, setFiltered] = useState<MentionCandidate[]>([]);
  const [visible, setVisible] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [query, setQuery] = useState("");

  const scopeChannelId = scope?.channelId;
  const scopeChannelType = scope?.channelType;

  const loadCandidates = useCallback(async () => {
    const list: MentionCandidate[] = [];
    const memberScoped = !!scopeChannelType && scopeChannelType !== "public";
    if (memberScoped) {
      // 私有/DM：频道信息还没加载完时先不给候选（避免短暂展示全量 agent）；
      // 加载完成后只列已加入成员。
      if (!scopeChannelId) {
        setCandidates([]);
        return;
      }
      try {
        const data = await apiGet<{ members: any[] }>(`/api/channels/${scopeChannelId}/members`);
        for (const m of data.members || []) {
          if (!m.handle) continue;
          list.push({
            handle: m.handle,
            displayName: m.display_name || m.handle,
            type: m.member_type === "agent" ? "agent" : "user",
            id: m.member_id,
          });
        }
      } catch {}
      setCandidates(list);
      return;
    }
    // Fetch agents
    try {
      const agentData = await apiGet<{ agents: any[] }>("/api/agents");
      for (const a of agentData.agents || []) {
        list.push({ handle: a.name, displayName: a.display_name, type: "agent", id: a.id });
      }
    } catch {}
    // Fetch server info (has humans) —— 需带鉴权
    try {
      const data = await apiGet<any>("/api/server/info");
      for (const h of data.humans || []) {
        list.push({
          handle: h.handle,
          displayName: h.display_name || h.displayName || h.handle,
          type: "user",
          id: h.id,
        });
      }
    } catch {}
    // Fallback if nothing loaded
    if (list.length === 0) {
      list.push({ handle: "alice", displayName: "Alice", type: "user", id: "fallback-1" });
      list.push({ handle: "demo", displayName: "Demo", type: "user", id: "fallback-2" });
      list.push({ handle: "local-agent-test", displayName: "Local Test", type: "agent", id: "fallback-3" });
    }
    setCandidates(list);
  }, [scopeChannelId, scopeChannelType]);

  // 进频道 / 切换频道时加载一次
  useEffect(() => {
    loadCandidates();
  }, [loadCandidates]);

  // filtered/visible 由 mentionActive + query + candidates 派生：
  // 候选刷新（例如频道刚加了成员、新 @ 会话触发重拉）时弹窗内容同步更新；
  // mentionActive 变 false（删掉 @ / 点击外部 / 完成插入）时弹窗立即关闭。
  useEffect(() => {
    if (!mentionActive) {
      setFiltered([]);
      setVisible(false);
      return;
    }
    const lower = query.toLowerCase();
    const matches = candidates.filter(
      (c) => c.handle.toLowerCase().includes(lower) || c.displayName.toLowerCase().includes(lower),
    );
    setFiltered(matches);
    setSelectedIdx(0);
    setVisible(matches.length > 0);
  }, [mentionActive, query, candidates]);

  // 点击输入框和弹窗以外的地方 → 关闭弹窗
  useEffect(() => {
    if (!mentionActive) return;
    const onDown = (ev: globalThis.MouseEvent) => {
      const t = ev.target as HTMLElement | null;
      if (!t) return;
      if (textareaRef.current?.contains(t)) return;
      if (t.closest("[data-mention-popup]")) return;
      setMentionActive(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [mentionActive, textareaRef]);

  // Detect @ typing
  const handleInput = useCallback(
    (e?: React.FormEvent<HTMLTextAreaElement>) => {
      const el = textareaRef.current;
      if (!el) return;
      const cursorPos = el.selectionStart;
      const text = e && "target" in e ? (e.target as HTMLTextAreaElement).value : el.value;
      // Find the @ before cursor
      let atIdx = -1;
      for (let i = cursorPos - 1; i >= 0; i--) {
        if (text[i] === "@") {
          atIdx = i;
          break;
        }
        if (text[i] === " " || text[i] === "\n") break;
      }
      if (atIdx >= 0) {
        const q = text.slice(atIdx + 1, cursorPos);
        // 新的 @ 会话（query 为空）→ 重新拉候选，频道刚加的成员立刻可 @
        if (q === "") loadCandidates();
        setMentionActive(true);
        setQuery(q);
      } else {
        // 删掉了 @ 或光标移离 → 关闭弹窗
        setMentionActive(false);
      }
    },
    [textareaRef, loadCandidates],
  );

  const insertMention = useCallback(
    (handle: string) => {
      setMentionActive(false);
      setVisible(false);
      setFiltered([]);
      setQuery("");
      const el = textareaRef.current;
      if (!el) return;
      const cursorPos = el.selectionStart;
      const text = el.value;
      let atIdx = -1;
      for (let i = cursorPos - 1; i >= 0; i--) {
        if (text[i] === "@") {
          atIdx = i;
          break;
        }
        if (text[i] === " " || text[i] === "\n") break;
      }
      if (atIdx >= 0) {
        const before = text.slice(0, atIdx);
        const after = text.slice(cursorPos);
        const newText = before + "@" + handle + " " + after;
        // Just update the DOM value — the wrapper in ChannelView syncs to React state
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        nativeSetter?.call(el, newText);
        // 光标移到插入的提及之后（否则停在 @handle 中间会立刻重新触发弹窗），
        // 并派发 input 事件：键盘路径不经过外层 setDraft，必须靠受控组件自己的
        // onChange 把 React state 同步成新值，否则下一次渲染 value 会被旧 state 覆盖
        // （表现就是"回车插入无效"）。
        const pos = atIdx + handle.length + 2;
        el.setSelectionRange(pos, pos);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return newText;
      }
      return text;
    },
    [textareaRef],
  );

  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!visibleRef.current) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, filteredRef.current.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const sel = filteredRef.current[selectedIdx];
        if (sel) insertMention(sel.handle);
      } else if (e.key === "Escape") {
        setMentionActive(false);
      }
    },
    [selectedIdx, insertMention],
  );

  return { visible, filtered, selectedIdx, handleInput, handleKeyDown, insertMention, setVisible };
}
