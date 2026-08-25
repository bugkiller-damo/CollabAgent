/**
 * D1 Context Builder（Step 6）：线程追问入队前拉该线程历史、截断后拼进 prompt。
 * 设计：docs/2026-08-21/01-d1-d2-context-session-design.md
 *
 * 失败不阻断唤醒。SLOCK_CONTEXT_BUILDER=0 关闭。不召 LLM 摘要。
 */

import { isProgressContent } from "@collabagent/shared";

export interface HistoryMessage {
  id?: string;
  seq?: number | string;
  senderName?: string;
  senderType?: string;
  content?: string;
  time?: string;
}

export interface ContextPack {
  block: string;
  kept: number;
  dropped: number;
  chars: number;
}

export interface ContextBudget {
  maxMessages: number;
  maxChars: number;
}

export const DEFAULT_CONTEXT_MAX_MESSAGES = 40;
export const DEFAULT_CONTEXT_MAX_CHARS = 8000;

export const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export const contextBuilderEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.SLOCK_CONTEXT_BUILDER !== "0";

export const readContextBudget = (env: NodeJS.ProcessEnv = process.env): ContextBudget => ({
  maxMessages: parsePositiveInt(env.SLOCK_CONTEXT_MAX_MESSAGES, DEFAULT_CONTEXT_MAX_MESSAGES),
  maxChars: parsePositiveInt(env.SLOCK_CONTEXT_MAX_CHARS, DEFAULT_CONTEXT_MAX_CHARS),
});

export const normalizeThreadId = (raw: unknown): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  return t.length > 0 ? t : undefined;
};

const formatLine = (m: HistoryMessage): string => {
  const who = (m.senderName || "?").trim() || "?";
  const body = String(m.content ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return `@${who}: ${body}`;
};

/**
 * 从最旧丢到条数/字符预算内；保留近期原文。触发消息（同 id 或同正文）去掉以免双份。
 */
export const packThreadContext = (
  messages: HistoryMessage[],
  opts?: {
    triggerId?: string;
    triggerContent?: string;
    maxMessages?: number;
    maxChars?: number;
  },
): ContextPack | null => {
  const maxMessages = opts?.maxMessages ?? DEFAULT_CONTEXT_MAX_MESSAGES;
  const maxChars = opts?.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS;
  const triggerId = opts?.triggerId?.trim();
  const triggerContent = opts?.triggerContent?.trim();

  const filtered = messages.filter((m) => {
    const content = String(m.content ?? "").trim();
    if (!content) return false;
    if (isProgressContent(content)) return false;
    if (triggerId && m.id && String(m.id) === triggerId) return false;
    if (!triggerId && triggerContent && content === triggerContent) return false;
    return true;
  });

  if (filtered.length === 0) return null;

  const chronological = [...filtered].sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
  let kept = chronological;
  if (kept.length > maxMessages) kept = kept.slice(kept.length - maxMessages);

  while (kept.length > 0) {
    const lines = kept.map(formatLine);
    const chars = lines.reduce((n, l) => n + l.length + 1, 0);
    if (chars <= maxChars) {
      const dropped = chronological.length - kept.length;
      const block = ["【线程上下文】（按时间升序，超窗已丢最旧）", ...lines].join("\n");
      return { block, kept: kept.length, dropped, chars };
    }
    kept = kept.slice(1);
  }
  return null;
};

export const wrapWithIsolation = (packed: string, threadId: string): string => {
  const short = threadId.slice(0, 8);
  return [
    `【会话隔离】本回合只处理线程 ${short}。只以下方【线程上下文】和本条新消息为准；`,
    `不要把上一回合其它频道/线程的细节当成本线程事实。`,
    ``,
    packed,
  ].join("\n");
};

export const prependContext = (envelope: string, taskPrompt: string): string => `${envelope}\n\n${taskPrompt}`;

export interface FetchThreadHistoryInput {
  serverUrl: string;
  apiKey: string;
  agentId: string;
  channelName: string;
  threadId: string;
  limit?: number;
}

export const fetchThreadHistory = async (input: FetchThreadHistoryInput): Promise<HistoryMessage[]> => {
  const url = new URL(`/internal/agent/${encodeURIComponent(input.agentId)}/history`, input.serverUrl);
  url.searchParams.set("channel", `#${input.channelName.replace(/^#/, "").split(":")[0]}`);
  url.searchParams.set("threadId", input.threadId);
  url.searchParams.set("limit", String(input.limit ?? 100));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${input.apiKey}` } });
  if (!res.ok) {
    throw new Error(`history ${res.status} ${await res.text().catch(() => "")}`.trim());
  }
  const data = (await res.json()) as { messages?: HistoryMessage[] };
  return Array.isArray(data.messages) ? data.messages : [];
};

/**
 * 线程追问：拉历史 → 打包 → 隔离信封。无 threadId / 关闭 / 失败 → null（调用方用裸 prompt）。
 */
export const buildThreadContextEnvelope = async (input: {
  serverUrl: string;
  apiKey: string;
  agentId: string;
  channelName: string;
  threadId?: string;
  triggerId?: string;
  triggerContent?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<(ContextPack & { envelope: string; threadId: string }) | null> => {
  const env = input.env ?? process.env;
  if (!contextBuilderEnabled(env)) return null;
  const threadId = normalizeThreadId(input.threadId);
  if (!threadId) return null;
  const budget = readContextBudget(env);
  let messages: HistoryMessage[];
  try {
    messages = await fetchThreadHistory({
      serverUrl: input.serverUrl,
      apiKey: input.apiKey,
      agentId: input.agentId,
      channelName: input.channelName,
      threadId,
      limit: Math.max(budget.maxMessages * 2, 100),
    });
  } catch (err: any) {
    console.warn(`[ContextBuilder] thread ${threadId.slice(0, 8)} fetch failed:`, err?.message ?? err);
    return null;
  }
  const packed = packThreadContext(messages, {
    triggerId: input.triggerId,
    triggerContent: input.triggerContent,
    maxMessages: budget.maxMessages,
    maxChars: budget.maxChars,
  });
  if (!packed) return null;
  return { ...packed, threadId, envelope: wrapWithIsolation(packed.block, threadId) };
};
