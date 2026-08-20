/**
 * 结构化观察帧总线（改造方案 B1，见 docs/2026-08-18/03-slock-modification-plan.md §2.B1）。
 *
 * 背景：终端观察面板历来只消费 PTY 帧（screenText 截屏）。headless 路径
 * （PersistentClaude / stream-json）没有 PTY，围观能力为零——这是 O13 路线里
 * 「headless 转正」的硬前置。本模块把 stream-json 输出事件转成结构化观察帧
 * （对齐 buzz buzz-acp/observer.rs 的 ObserverEvent 思路）：
 *
 * - streamEventToFrames：纯函数，claude stream-json 事件 → ObservationFrame[]
 * - ObservationBus：per-agent 发布/订阅 + 环形 replay buffer（对齐 pty-output-bus
 *   的纪律：按 key 索引、unsubscribe 清理、监听器抛错不影响他人）
 * - renderTranscript：把 replay buffer 渲染成纯文本 transcript——当前直接复用
 *   现有 terminal:frame 通道推给浏览器（web 侧零改动即可获得 headless 围观能力），
 *   后续 web 的结构化流视图（tool_use 折叠卡片）改为直接消费帧
 */

// ObservationFrame 规范定义在 @collabagent/shared（WS 线协议 terminal:obs-frame
// 的载荷类型，2026-08-20 S2.3 收敛）。此处 re-export，既有 import 方不用改路径。
import type { ObservationFrame } from "@collabagent/shared";

export type { ObservationFrame };

type ObservationListener = (frame: ObservationFrame) => void;

export interface ObservationBus {
  publish(frame: ObservationFrame): void;
  subscribe(agentName: string, listener: ObservationListener): () => void;
  /** replay buffer 全量（新观众上线补历史用） */
  replay(agentName: string): ObservationFrame[];
  /** replay buffer 渲染成 transcript 文本（terminal:frame 兼容通道用） */
  transcript(agentName: string, maxChars?: number): string;
  clear(agentName: string): void;
  listenerCount(agentName: string): number;
}

/** 单帧 payload 文本截断（对齐 buzz-dev-mcp 的截断纪律：LLM/观众看摘要，完整内容在本地落盘） */
const truncate = (s: string, max: number): string =>
  s.length > max ? s.slice(0, max) + `…(+${s.length - max} chars)` : s;

/**
 * claude stream-json 事件 → 观察帧。纯函数便于单测。
 * 事件形态（claude --output-format stream-json --verbose）：
 * - {"type":"system","subtype":"init","session_id":...}      会话初始化
 * - {"type":"assistant","message":{"id","content":[blocks]}}  assistant 输出块
 * - {"type":"user","message":{"content":[tool_result...]}}   工具结果回灌
 * - {"type":"result","subtype":"success"|"error",...}        回合结束（精确边界）
 */
export const streamEventToFrames = (agentName: string, ev: any, allocSeq: () => number): ObservationFrame[] => {
  const frames: ObservationFrame[] = [];
  const base = { agentName, timestamp: Date.now() };
  const push = (kind: ObservationFrame["kind"], turnId: string | null, payload: ObservationFrame["payload"]): void => {
    frames.push({ ...base, seq: allocSeq(), kind, turnId, payload });
  };

  switch (ev?.type) {
    case "system":
      if (ev.subtype === "init") {
        push("system", null, { text: `session ${ev.session_id ?? "?"} (model=${ev.model ?? "?"})` });
      }
      break;
    case "assistant": {
      const turnId = ev.message?.id ?? null;
      const blocks = Array.isArray(ev.message?.content) ? ev.message.content : [];
      for (const b of blocks) {
        if (b?.type === "text" && typeof b.text === "string") {
          push("text", turnId, { text: truncate(b.text, 4000) });
        } else if (b?.type === "thinking" && typeof b.thinking === "string") {
          push("thinking", turnId, { text: truncate(b.thinking, 1000) });
        } else if (b?.type === "tool_use") {
          push("tool_use", turnId, {
            toolName: b.name ?? "?",
            toolUseId: b.id ?? undefined,
            toolInput: b.input,
            text: truncate(JSON.stringify(b.input ?? {}), 500),
          });
        }
      }
      break;
    }
    case "user": {
      // stream-json 里工具结果以 user 消息回灌
      const blocks = Array.isArray(ev.message?.content) ? ev.message.content : [];
      for (const b of blocks) {
        if (b?.type === "tool_result") {
          const text =
            typeof b.content === "string"
              ? b.content
              : Array.isArray(b.content)
                ? b.content.map((c: any) => c?.text ?? "").join("\n")
                : JSON.stringify(b.content ?? "");
          push("tool_result", null, {
            toolUseId: b.tool_use_id ?? undefined,
            text: truncate(text, 1000),
          });
        }
      }
      break;
    }
    case "result": {
      const ok = ev.subtype === "success";
      const summary = [
        ok ? "success" : `error (${ev.subtype ?? "?"})`,
        ev.duration_ms != null ? `${(ev.duration_ms / 1000).toFixed(1)}s` : null,
        ev.total_cost_usd != null ? `$${Number(ev.total_cost_usd).toFixed(4)}` : null,
        ev.num_turns != null ? `${ev.num_turns} turns` : null,
      ]
        .filter(Boolean)
        .join(", ");
      push("turn_end", null, { summary, text: ok ? undefined : truncate(String(ev.result ?? ""), 500) });
      break;
    }
  }
  return frames;
};

/** 帧 → transcript 单行（人类可读优先，不追求复刻 TUI 像素画面） */
export const renderFrame = (f: ObservationFrame): string => {
  switch (f.kind) {
    case "system":
      return `── ${f.payload.text ?? ""}`;
    case "text":
      return f.payload.text ?? "";
    case "thinking":
      return `💭 ${f.payload.text ?? ""}`;
    case "tool_use":
      return `🔧 ${f.payload.toolName ?? "?"} ${f.payload.text ?? ""}`;
    case "tool_result":
      return `   ↳ ${(f.payload.text ?? "").replace(/\n/g, "\n   ↳ ")}`;
    case "turn_end":
      return `── turn end (${f.payload.summary ?? ""})${f.payload.text ? `\n⚠️ ${f.payload.text}` : ""}`;
    case "error":
      return `⚠️ ${f.payload.text ?? ""}`;
    default:
      // kind 联合类型已穷尽；防御未来新增 kind 时编译期漏改渲染分支
      return `[${f.kind}] ${f.payload.text ?? ""}`;
  }
};

export interface ObservationBusOptions {
  /** 每 agent replay buffer 上限（默认 500 帧） */
  bufferSize?: number;
  now?: () => number;
}

export const createObservationBus = (opts: ObservationBusOptions = {}): ObservationBus => {
  const bufferSize = opts.bufferSize ?? 500;
  const listeners = new Map<string, Set<ObservationListener>>();
  const buffers = new Map<string, ObservationFrame[]>();

  return {
    publish(frame) {
      let buf = buffers.get(frame.agentName);
      if (!buf) {
        buf = [];
        buffers.set(frame.agentName, buf);
      }
      buf.push(frame);
      if (buf.length > bufferSize) buf.splice(0, buf.length - bufferSize);

      const set = listeners.get(frame.agentName);
      if (!set || set.size === 0) return;
      for (const listener of set) {
        try {
          listener(frame);
        } catch (err: any) {
          console.error("[ObservationBus] listener error:", err?.message ?? err);
        }
      }
    },

    subscribe(agentName, listener) {
      let set = listeners.get(agentName);
      if (!set) {
        set = new Set();
        listeners.set(agentName, set);
      }
      set.add(listener);
      return () => {
        set!.delete(listener);
        if (set!.size === 0) listeners.delete(agentName);
      };
    },

    replay(agentName) {
      return [...(buffers.get(agentName) ?? [])];
    },

    transcript(agentName, maxChars = 60000) {
      const buf = buffers.get(agentName);
      if (!buf || buf.length === 0) return "";
      const text = buf.map(renderFrame).join("\n");
      return text.length > maxChars ? text.slice(-maxChars) : text;
    },

    clear(agentName) {
      buffers.delete(agentName);
      listeners.delete(agentName);
    },

    listenerCount(agentName) {
      return listeners.get(agentName)?.size ?? 0;
    },
  };
};

/** 供 streamEventToFrames 使用的全局序号分配器（每 bus 一个，保证帧序号单调） */
export const createSeqAllocator = (): (() => number) => {
  let seq = 0;
  return () => ++seq;
};
