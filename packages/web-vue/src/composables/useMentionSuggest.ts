import { computed, type MaybeRefOrGetter, onMounted, type Ref, ref, toValue, watch } from "vue";
import { apiGet } from "../api";

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

/**
 * @ 提及候选 —— 从 packages/web/src/hooks/useMentionSuggest.ts 移植。
 * 输入输出契约与 React 版一致（textareaRef、scope、visible/filtered/selectedIdx/
 * handleInput/handleKeyDown/insertMention/setVisible），差异仅两点：
 * - scope 额外接受 Ref/Getter（MaybeRefOrGetter）：传普通对象时行为与 React 版相同
 *   （仅挂载时加载一次）；传响应式来源时 channelId/channelType 变化会重载候选，
 *   对应 React 版 useCallback deps 的语义
 * - 返回的 visible/filtered/selectedIdx 是 Ref
 */
export function useMentionSuggest(
  textareaRef: Ref<HTMLTextAreaElement | null>,
  scope?: MaybeRefOrGetter<MentionScope | undefined>,
) {
  const candidates = ref<MentionCandidate[]>([]);
  // mentionActive：光标前存在未闭合的 "@"（弹窗会话进行中）
  const mentionActive = ref(false);
  const filtered = ref<MentionCandidate[]>([]);
  const visible = ref(false);
  const selectedIdx = ref(0);
  const query = ref("");

  const scopeChannelId = computed(() => toValue(scope)?.channelId);
  const scopeChannelType = computed(() => toValue(scope)?.channelType);

  const loadCandidates = async () => {
    const list: MentionCandidate[] = [];
    const memberScoped = !!scopeChannelType.value && scopeChannelType.value !== "public";
    if (memberScoped) {
      // 私有/DM：频道信息还没加载完时先不给候选（避免短暂展示全量 agent）；
      // 加载完成后只列已加入成员。
      if (!scopeChannelId.value) {
        candidates.value = [];
        return;
      }
      try {
        const data = await apiGet<{ members: any[] }>(`/api/channels/${scopeChannelId.value}/members`);
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
      candidates.value = list;
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
    candidates.value = list;
  };

  // 进频道 / 切换频道时加载一次；scope 为响应式来源时随 channelId/channelType 变化重载
  onMounted(() => {
    loadCandidates();
  });
  watch([scopeChannelId, scopeChannelType], () => {
    loadCandidates();
  });

  // filtered/visible 由 mentionActive + query + candidates 派生：
  // 候选刷新（例如频道刚加了成员、新 @ 会话触发重拉）时弹窗内容同步更新；
  // mentionActive 变 false（删掉 @ / 点击外部 / 完成插入）时弹窗立即关闭。
  watch(
    [mentionActive, query, candidates],
    () => {
      if (!mentionActive.value) {
        filtered.value = [];
        visible.value = false;
        return;
      }
      const lower = query.value.toLowerCase();
      const matches = candidates.value.filter(
        (c) => c.handle.toLowerCase().includes(lower) || c.displayName.toLowerCase().includes(lower),
      );
      filtered.value = matches;
      selectedIdx.value = 0;
      visible.value = matches.length > 0;
    },
    { immediate: true },
  );

  // 点击输入框和弹窗以外的地方 → 关闭弹窗
  watch(mentionActive, (active, _prev, onCleanup) => {
    if (!active) return;
    const onDown = (ev: globalThis.MouseEvent) => {
      const t = ev.target as HTMLElement | null;
      if (!t) return;
      if (textareaRef.value?.contains(t)) return;
      if (t.closest("[data-mention-popup]")) return;
      mentionActive.value = false;
    };
    document.addEventListener("mousedown", onDown);
    onCleanup(() => document.removeEventListener("mousedown", onDown));
  });

  // Detect @ typing
  const handleInput = (e?: Event) => {
    const el = textareaRef.value;
    if (!el) return;
    const cursorPos = el.selectionStart;
    const text = e?.target ? (e.target as HTMLTextAreaElement).value : el.value;
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
      mentionActive.value = true;
      query.value = q;
    } else {
      // 删掉了 @ 或光标移离 → 关闭弹窗
      mentionActive.value = false;
    }
  };

  const insertMention = (handle: string): string | undefined => {
    mentionActive.value = false;
    visible.value = false;
    filtered.value = [];
    query.value = "";
    const el = textareaRef.value;
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
      // 只更新 DOM value —— 外层组件负责把 input 事件同步回 v-model
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      nativeSetter?.call(el, newText);
      // 光标移到插入的提及之后（否则停在 @handle 中间会立刻重新触发弹窗），
      // 并派发 input 事件：Vue 的 v-model 同样是受控的，键盘路径不经过外层 draft
      // 赋值，必须靠 @input 监听把组件状态同步成新值，否则下一次渲染 value 会被
      // 旧状态覆盖（表现就是"回车插入无效"）。所以这个 hack 在 Vue 下依然需要。
      const pos = atIdx + handle.length + 2;
      el.setSelectionRange(pos, pos);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return newText;
    }
    return text;
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!visible.value) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIdx.value = Math.min(selectedIdx.value + 1, filtered.value.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIdx.value = Math.max(selectedIdx.value - 1, 0);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const sel = filtered.value[selectedIdx.value];
      if (sel) insertMention(sel.handle);
    } else if (e.key === "Escape") {
      mentionActive.value = false;
    }
  };

  const setVisible = (v: boolean) => {
    visible.value = v;
  };

  return { visible, filtered, selectedIdx, handleInput, handleKeyDown, insertMention, setVisible };
}
