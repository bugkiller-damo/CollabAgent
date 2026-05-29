import { useState, useEffect, useRef, useCallback } from "react";
import { apiGet } from "../api/client";

interface MentionCandidate {
  handle: string; displayName: string; type: "user" | "agent"; id: string;
}

export function useMentionSuggest(textareaRef: React.RefObject<HTMLTextAreaElement | null>) {
  const [candidates, setCandidates] = useState<MentionCandidate[]>([]);
  const skipNextInput = useRef(false);
  const [filtered, setFiltered] = useState<MentionCandidate[]>([]);
  const [visible, setVisible] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState({ top: 0, left: 0 });

  // Load candidates from API
  useEffect(() => {
    const loadUsers = async () => {
      const list: MentionCandidate[] = [];
      // Fetch agents
      try {
        const agentData = await apiGet<{ agents: any[] }>("/api/agents");
        for (const a of (agentData.agents || [])) {
          list.push({ handle: a.name, displayName: a.display_name, type: "agent", id: a.id });
        }
      } catch {}
      // Fetch server info (has humans + agents)
      try {
        const res = await fetch("/api/server/info");
        const data = await res.json() as any;
        for (const h of (data.humans || [])) {
          list.push({ handle: h.handle, displayName: h.displayName || h.handle, type: "user", id: h.id });
        }
      } catch {}
      // Fallback if nothing loaded
      if (list.length === 0) {
        list.push({ handle: "alice", displayName: "Alice", type: "user", id: "fallback-1" });
        list.push({ handle: "demo", displayName: "Demo", type: "user", id: "fallback-2" });
        list.push({ handle: "local-agent-test", displayName: "Local Test", type: "agent", id: "fallback-3" });
      }
      setCandidates(list);
    };
    loadUsers();
  }, []);

  // Detect @ typing and filter
  const handleInput = useCallback(() => {
    if (skipNextInput.current) { skipNextInput.current = false; return; }
    const el = textareaRef.current;
    if (!el) return;
    const cursorPos = el.selectionStart;
    const text = el.value;
    // Find the @ before cursor
    let atIdx = -1;
    for (let i = cursorPos - 1; i >= 0; i--) {
      if (text[i] === "@") { atIdx = i; break; }
      if (text[i] === " " || text[i] === "\n") break;
    }
    if (atIdx >= 0) {
      const q = text.slice(atIdx + 1, cursorPos);
      setQuery(q);
      const lower = q.toLowerCase();
      const matches = candidates.filter(c =>
        c.handle.toLowerCase().includes(lower) || c.displayName.toLowerCase().includes(lower)
      );
      setFiltered(matches);
      setSelectedIdx(0);
      setVisible(matches.length > 0);
      // Calculate popup position
      const rect = el.getBoundingClientRect();
      setPosition({ top: rect.top - 200, left: rect.left + 20 });
    } else {
      setVisible(false);
    }
  }, [textareaRef, candidates]);

  const insertMention = useCallback((handle: string) => {
    const el = textareaRef.current;
    if (!el) return;
    skipNextInput.current = true;
    const cursorPos = el.selectionStart;
    const text = el.value;
    let atIdx = -1;
    for (let i = cursorPos - 1; i >= 0; i--) {
      if (text[i] === "@") { atIdx = i; break; }
      if (text[i] === " " || text[i] === "\n") break;
    }
    if (atIdx >= 0) {
      const before = text.slice(0, atIdx);
      const after = text.slice(cursorPos);
      const newText = before + "@" + handle + " " + after;
      // Trigger React state update via native input event
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      nativeSetter?.call(el, newText);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.focus();
    }
    setVisible(false);
    setFiltered([]);
    // Prevent race with handleInput
    skipNextInput.current = true;
    setTimeout(() => { setVisible(false); setFiltered([]); }, 50);
  }, [textareaRef]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!visible) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      if (filtered[selectedIdx]) insertMention(filtered[selectedIdx].handle);
    } else if (e.key === "Escape") { setVisible(false); }
  }, [visible, filtered, selectedIdx, insertMention]);

  return { visible, filtered, selectedIdx, position, handleInput, handleKeyDown, insertMention, setVisible };
}
