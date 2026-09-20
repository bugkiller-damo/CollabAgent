/**
 * 结构化观察帧总线（改造方案 B1，见 docs/2026-08-18/03-slock-modification-plan.md §2.B1）。
 *
 * 背景：终端观察面板历来只消费 PTY 帧（screenText 截屏）。headless 路径
 * （PersistentClaude / stream-json）没有 PTY，围观能力为零——这是 O13 路线里
 * 「headless 转正」的硬前置。本模块把 stream-json 输出事件转成结构化观察帧
 * （对齐 buzz buzz-acp/observer.rs 的 ObserverEvent 思路）：
 *
 * - streamEventToFrames：纯函数，规范化 `AgentRuntimeEvent` → ObservationFrame[]
 *   （Phase 0 起 provider 私有事件在 driver 边界内已转换完毕，本模块不再认
 *   Claude stream-json）
 * - ObservationBus：per-agent 发布/订阅 + 环形 replay buffer（对齐 pty-output-bus
 *   的纪律：按 key 索引、unsubscribe 清理、监听器抛错不影响他人）
 * - renderTranscript：把 replay buffer 渲染成纯文本 transcript——当前直接复用
 *   现有 terminal:frame 通道推给浏览器（web 侧零改动即可获得 headless 围观能力），
 *   后续 web 的结构化流视图（tool_use 折叠卡片）改为直接消费帧
 */

// ObservationFrame 规范定义在 @collabagent/shared（WS 线协议 terminal:obs-frame
// 的载荷类型，2026-08-20 S2.3 收敛）。此处 re-export，既有 import 方不用改路径。
import type { ObservationFrame } from "@collabagent/shared";
import type { AgentRuntimeEvent } from "./agent-runtime-events.js";
import { errMessage } from "./errors.js";
import { redactDeep, redactSecrets } from "./redact.js";

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

/** 单帧 payload 文本截断（对齐 buzz-dev-mcp 的截断纪律：LLM/观众看摘要，完整内容在本地落盘）。
 *  P1.15：先脱敏再截断——截断可能把 token 切成不匹配模式的两半，半截 token 仍是泄露。 */
const truncate = (s: string, max: number): string => {
  const clean = redactSecrets(s);
  return clean.length > max ? clean.slice(0, max) + `…(+${clean.length - max} chars)` : clean;
};

/**
 * 规范化 runtime 事件 → 观察帧。纯函数便于单测。
 * 事件形态见 agent-runtime-events.ts（各 driver 边界内已从 provider 私有
 * 协议转换完成，例如 Claude stream-json → drivers/claude-runtime.ts）：
 * - session(subtype=init)   会话初始化
 * - text / thinking         assistant 输出（按块顺序逐个到达）
 * - tool.start / tool.end   工具调用与结果回灌
 * - turn.end                回合结束（精确边界）
 */
export const streamEventToFrames = (
  agentName: string,
  ev: AgentRuntimeEvent | null | undefined,
  allocSeq: () => number,
): ObservationFrame[] => {
  const frames: ObservationFrame[] = [];
  const base = { agentName, timestamp: Date.now() };
  const push = (kind: ObservationFrame["kind"], turnId: string | null, payload: ObservationFrame["payload"]): void => {
    // P1.15：payload 整体过一遍递归脱敏（覆盖 system/turn_end 等不走 truncate 的文本
    // 与 tool_use 的结构化 toolInput）；文本字段在 truncate 里已脱敏，此处是兜底。
    frames.push({ ...base, seq: allocSeq(), kind, turnId, payload: redactDeep(payload) });
  };

  switch (ev?.type) {
    case "session":
      if (ev.subtype === "init") {
        push("system", null, { text: `session ${ev.sessionRef ?? "?"} (model=${ev.model ?? "?"})` });
      }
      break;
    case "text":
      push("text", ev.turnId ?? null, { text: truncate(ev.text, 4000) });
      break;
    case "thinking":
      push("thinking", ev.turnId ?? null, { text: truncate(ev.text, 1000) });
      break;
    case "tool.start":
      push("tool_use", ev.turnId ?? null, {
        toolName: ev.toolName,
        toolUseId: ev.toolUseId,
        toolInput: ev.input,
        text: truncate(JSON.stringify(ev.input ?? {}), 500),
      });
      break;
    case "tool.end":
      push("tool_result", ev.turnId ?? null, {
        toolName: ev.toolName,
        toolUseId: ev.toolUseId,
        text: truncate(ev.output, 1000),
      });
      break;
    case "turn.end": {
      // usage 数值只进 summary 字符串；落库在
      // agent-runtime-dispatch-stream 的 handleStreamEvent（D3 / Step 4）。
      // 注意 costUsd 是本回合增量（driver 边界已做累计→差值），非会话累计。
      const ok = ev.status === "success";
      const summary = [
        ok ? "success" : `error (${ev.subtype ?? "?"})`,
        ev.usage.durationMs != null ? `${(ev.usage.durationMs / 1000).toFixed(1)}s` : null,
        ev.usage.costUsd != null ? `$${ev.usage.costUsd.toFixed(4)}` : null,
        ev.usage.numTurns != null ? `${ev.usage.numTurns} turns` : null,
      ]
        .filter(Boolean)
        .join(", ");
      push("turn_end", null, { summary, text: ok ? undefined : truncate(ev.result ?? "", 500) });
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
        } catch (err) {
          console.error("[ObservationBus] listener error:", errMessage(err));
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
