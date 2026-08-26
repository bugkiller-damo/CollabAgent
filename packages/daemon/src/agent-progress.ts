/**
 * D4 频道内进度消息：节流聚合观察帧 → 一条原地更新的 ⏳ 消息。
 * 纯函数在 @collabagent/shared；本文件是回合级节流器。
 */

import { formatProgressMessage, type ProgressFrame, summarizeProgress } from "@collabagent/shared";
import { loadDaemonEnv } from "./config.js";

export {
  channelProgressEnabled,
  formatProgressMessage,
  isProgressContent,
  labelTool,
  PROGRESS_PREFIX,
  readProgressThrottleMs,
  summarizeProgress,
} from "@collabagent/shared";

export interface ProgressPoster {
  post(channel: string, content: string, threadId?: string): Promise<string | undefined>;
  edit(messageId: string, content: string): Promise<boolean>;
  remove(messageId: string): Promise<boolean>;
}

export interface ProgressTurn {
  note(frame: ProgressFrame): void;
  /** 回合结束：hadSend 则删除进度条；rewrite 则把进度条改成最终正文 */
  finish(opts: { hadSend: boolean; rewrite?: string }): Promise<{ rewritten: boolean }>;
  abort(): Promise<{ rewritten: boolean }>;
  currentHeadline(): string;
}

export interface CreateProgressTurnOpts {
  agentName: string;
  channel: string;
  threadId?: string;
  poster: ProgressPoster;
  now?: () => number;
  throttleMs?: number;
  enabled?: boolean;
  /** 顶栏/状态栏：每次文案变化都回调（不节流） */
  onHeadline?: (headline: string) => void;
}

export const createProgressTurn = (opts: CreateProgressTurnOpts): ProgressTurn => {
  const envCfg = loadDaemonEnv();
  const enabled = opts.enabled ?? envCfg.channelProgress;
  const throttleMs = opts.throttleMs ?? envCfg.progressThrottleMs;
  const now = opts.now ?? Date.now;
  const frames: ProgressFrame[] = [];
  let messageId: string | undefined;
  let lastPosted = "";
  let lastFlushAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let flushing: Promise<void> = Promise.resolve();

  const headlineOf = (): string => summarizeProgress(frames).headline;

  const flush = async (force: boolean): Promise<void> => {
    if (!enabled || closed) return;
    const snap = summarizeProgress(frames);
    const content = formatProgressMessage(snap);
    if (content === lastPosted && !force) return;
    const t = now();
    if (!force && messageId && t - lastFlushAt < throttleMs) return;
    lastFlushAt = t;
    lastPosted = content;
    try {
      if (!messageId) {
        messageId = await opts.poster.post(opts.channel, content, opts.threadId);
      } else {
        await opts.poster.edit(messageId, content);
      }
    } catch (err: any) {
      console.warn(`[progress] @${opts.agentName} flush failed:`, err?.message ?? err);
    }
  };

  const schedule = (): void => {
    if (!enabled || closed) return;
    if (timer) return;
    const wait = Math.max(0, throttleMs - (now() - lastFlushAt));
    timer = setTimeout(() => {
      timer = undefined;
      flushing = flushing.then(() => flush(false));
    }, wait);
    if (typeof timer === "object" && timer && "unref" in timer) {
      (timer as NodeJS.Timeout).unref?.();
    }
  };

  return {
    note(frame) {
      if (closed) return;
      frames.push(frame);
      opts.onHeadline?.(headlineOf());
      if (!enabled) return;
      if (!messageId && frames.some((f) => f.kind === "tool_use" || f.kind === "text" || f.kind === "thinking")) {
        flushing = flushing.then(() => flush(true));
        return;
      }
      schedule();
    },
    async finish(end) {
      if (closed) return { rewritten: false };
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await flushing;
      if (!enabled) return { rewritten: false };
      try {
        if (end.rewrite && messageId) {
          await opts.poster.edit(messageId, end.rewrite);
          messageId = undefined;
          return { rewritten: true };
        }
        if (messageId) {
          await opts.poster.remove(messageId);
          messageId = undefined;
        }
      } catch (err: any) {
        console.warn(`[progress] @${opts.agentName} finish failed:`, err?.message ?? err);
      }
      return { rewritten: false };
    },
    abort() {
      return this.finish({ hadSend: true });
    },
    currentHeadline() {
      return headlineOf();
    },
  };
};
