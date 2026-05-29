import { useState, useRef, useCallback, useEffect } from "react";

interface MentionItem {
  name: string;
  type: "user" | "agent";
  display?: string;
}

export function useMentionAutocomplete(apiBase = "/api") {
  const [suggestions, setSuggestions] = useState<MentionItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [mentionStart, setMentionStart] = useState(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cachedUsers = useRef<MentionItem[]>([]);

  // Preload user list on mount
  useEffect(() => {
    fetch(`${apiBase}/server/info`)
      .then((r) => r.json())
      .then((data: { channels?: unknown[]; agents?: unknown[]; humans?: unknown[]; serverId?: string }) => {
        const items: MentionItem[] = [];
        if (data.humans) {
          for (const h of data.humans as Array<{ handle: string }>) {
            items.push({ name: h.handle, type: "user" });
          }
        }
        if (data.agents) {
          for (const a of data.agents as Array<{ name: string }>) {
            items.push({ name: a.name, type: "agent" });
          }
        }
        // Defaults based on seed data
        if (items.length === 0) {
          items.push({ name: "alice", type: "user" });
          items.push({ name: "demo", type: "user" });
          items.push({ name: "local-agent-test", type: "agent" });
          items.push({ name: "code-reviewer", type: "agent" });
          items.push({ name: "slock-daemon", type: "agent" });
        }
        cachedUsers.current = items;
      })
      .catch(() => {
        cachedUsers.current = [
          { name: "alice", type: "user" },
          { name: "demo", type: "user" },
          { name: "local-agent-test", type: "agent" },
          { name: "code-reviewer", type: "agent" },
        ];
      });
  }, [apiBase]);

  const handleInput = useCallback((textarea: HTMLTextAreaElement) => {
    const pos = textarea.selectionStart;
    const text = textarea.value;

    // Find the last @ before cursor
    const beforeCursor = text.slice(0, pos);
    const atIndex = beforeCursor.lastIndexOf("@");

    if (atIndex === -1 || atIndex < pos - 30) {
      setShowSuggestions(false);
      return;
    }

    // Check that @ is at a word boundary (preceded by space or start)
    if (atIndex > 0 && beforeCursor[atIndex - 1] !== " " && beforeCursor[atIndex - 1] !== "\n") {
      setShowSuggestions(false);
      return;
    }

    const query = beforeCursor.slice(atIndex + 1).toLowerCase();

    // Filter matching users/agents
    const matches = cachedUsers.current
      .filter((u) => u.name.toLowerCase().includes(query))
      .slice(0, 8);

    if (matches.length === 0) {
      setShowSuggestions(false);
    } else {
      setSuggestions(matches);
      setActiveIndex(0);
      setMentionStart(atIndex);
      setShowSuggestions(true);
    }
  }, []);

  const selectMention = useCallback(
    (item: MentionItem) => {
      const textarea = textareaRef.current;
      if (!textarea || mentionStart < 0) return;

      const text = textarea.value;
      const pos = textarea.selectionStart;
      const before = text.slice(0, mentionStart);
      const after = text.slice(pos);
      const insert = `@${item.name} `;

      textarea.value = before + insert + after;
      const newPos = mentionStart + insert.length;
      textarea.selectionStart = newPos;
      textarea.selectionEnd = newPos;
      textarea.focus();

      setShowSuggestions(false);
      // Trigger React state update
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    },
    [mentionStart]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!showSuggestions) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % suggestions.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (suggestions[activeIndex]) {
          selectMention(suggestions[activeIndex]);
        }
      } else if (e.key === "Escape") {
        setShowSuggestions(false);
      }
    },
    [showSuggestions, suggestions, activeIndex, selectMention]
  );

  const close = useCallback(() => setShowSuggestions(false), []);

  return {
    suggestions,
    activeIndex,
    showSuggestions,
    textareaRef,
    handleInput,
    handleKeyDown,
    selectMention,
    close,
  };
}
