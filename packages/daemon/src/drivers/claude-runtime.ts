/**
 * Phase 0：Claude runtime driver——`PersistentClaude`（常驻 stream-json 会话）与
 * `claudePrint`（one-shot）的统一适配器，是全仓唯一同时 import 二者的模块。
 *
 * 两件事都在本边界内完成：
 * 1. Claude stream-json 事件 → `AgentRuntimeEvent`（createClaudeEventNormalizer）。
 *    原 agent-observation.ts 的 block 拆帧与 blockText 工具结果文本化随事件一起
 *    迁到这里——观察层从此只认规范化事件。
 * 2. `result.total_cost_usd` 会话累计 → 本回合差值（createSessionCostDelta，
 *    P0.5）。turn.end.usage.costUsd 落的就是增量；进程被停/回收后经
 *    `driver.forgetAgent` / `normalizer.forget` 清基线，新进程首条按原值记。
 */

import { createSessionCostDelta } from "../agent-cost-tracker.js";
import type { AgentRuntimeDriver, AgentRuntimeOpenOptions, AgentRuntimeSession } from "../agent-runtime-driver.js";
import type { AgentRuntimeEvent } from "../agent-runtime-events.js";
import { claudePrint } from "../claude-print.js";
import { type ClaudeStreamEvent, isPlainObject } from "../claude-stream.js";
import { PersistentClaude } from "./persistent-claude.js";

/** result 事件上的数值字段：数字或数字字符串照收，缺失/非法 → null（不填 0 冒充已计量）。 */
const asFiniteNumber = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/** tool_result 的 content 文本化（自 agent-observation.ts 迁入，行为不变）。 */
const blockText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (isPlainObject(c) ? String(c.text ?? "") : "")).join("\n");
  }
  return JSON.stringify(content ?? "");
};

export interface ClaudeEventNormalizer {
  normalize(agentName: string, ev: ClaudeStreamEvent): AgentRuntimeEvent[];
  /** 清该 agent 的成本基线（session 被停/回收后新进程按首条累计原值记账）。 */
  forget(agentName: string): void;
}

export const createClaudeEventNormalizer = (): ClaudeEventNormalizer => {
  const costDelta = createSessionCostDelta();
  return {
    normalize(agentName, ev) {
      switch (ev?.type) {
        case "system":
          return [
            {
              type: "session",
              subtype: ev.subtype,
              sessionRef: typeof ev.session_id === "string" ? ev.session_id : undefined,
              model: typeof ev.model === "string" ? ev.model : undefined,
            },
          ];
        case "assistant": {
          const turnId = typeof ev.message?.id === "string" ? ev.message.id : undefined;
          const blocks = Array.isArray(ev.message?.content) ? ev.message.content : [];
          const out: AgentRuntimeEvent[] = [];
          for (const b of blocks) {
            if (!isPlainObject(b)) continue;
            if (b.type === "text" && typeof b.text === "string") {
              out.push({ type: "text", turnId, text: b.text });
            } else if (b.type === "thinking" && typeof b.thinking === "string") {
              out.push({ type: "thinking", turnId, text: b.thinking });
            } else if (b.type === "tool_use") {
              out.push({
                type: "tool.start",
                turnId,
                toolName: typeof b.name === "string" ? b.name : "?",
                toolUseId: typeof b.id === "string" ? b.id : undefined,
                input: b.input,
              });
            }
          }
          return out;
        }
        case "user": {
          // stream-json 里工具结果以 user 消息回灌
          const blocks = Array.isArray(ev.message?.content) ? ev.message.content : [];
          const out: AgentRuntimeEvent[] = [];
          for (const b of blocks) {
            if (!isPlainObject(b)) continue;
            if (b.type === "tool_result") {
              out.push({
                type: "tool.end",
                toolUseId: typeof b.tool_use_id === "string" ? b.tool_use_id : undefined,
                output: blockText(b.content),
              });
            }
          }
          return out;
        }
        case "result":
          return [
            {
              type: "turn.end",
              status: ev.subtype === "success" ? "success" : "error",
              subtype: ev.subtype,
              result: ev.result == null ? undefined : String(ev.result),
              usage: {
                costUsd: costDelta.next(agentName, asFiniteNumber(ev.total_cost_usd)),
                durationMs: asFiniteNumber(ev.duration_ms),
                numTurns: asFiniteNumber(ev.num_turns),
              },
            },
          ];
        default:
          return [];
      }
    },
    forget(agentName) {
      costDelta.forget(agentName);
    },
  };
};

/**
 * one-shot 会话包装：每次 send 起一个新的 `claude --print` 进程。
 * stop() 幂等（只能标记——claudePrint 不暴露子进程句柄，进程短命本就随 send 结束）。
 */
const createClaudeOneshotSession = (
  options: AgentRuntimeOpenOptions,
  normalizer: ClaudeEventNormalizer,
): AgentRuntimeSession => {
  let stopped = false;
  return {
    get alive() {
      return !stopped;
    },
    async send(prompt) {
      if (stopped) throw new Error("runtime session stopped");
      try {
        const result = await claudePrint(
          prompt,
          options.resumeSessionRef,
          options.systemPromptFile,
          options.env,
          options.cwd,
          (ev) => {
            for (const normalized of normalizer.normalize(options.agentName, ev)) {
              options.onEvent(normalized);
            }
          },
          options.model,
        );
        return result.sessionId ? { sessionRef: result.sessionId } : {};
      } finally {
        stopped = true;
      }
    },
    stop() {
      stopped = true;
    },
  };
};

export const createClaudeRuntimeDriver = (): AgentRuntimeDriver => {
  // 同一 driver 内 persistent / oneshot 共享一份 normalizer——agent 的成本基线
  // 与会话形态无关，只按 agentName 累计。
  const normalizer = createClaudeEventNormalizer();
  return {
    driverId: "claude-stream",
    runtimeIds: ["claude"],
    openSession(options) {
      if (options.mode === "oneshot") {
        return createClaudeOneshotSession(options, normalizer);
      }
      return new PersistentClaude({
        cwd: options.cwd,
        systemPromptFile: options.systemPromptFile,
        env: options.env,
        label: options.label,
        model: options.model,
        // A2：温启动——resumeSessionRef → --resume（来源 daemon-agent-sessions.json）
        resumeSessionId: options.resumeSessionRef,
        onResumeFailed: options.onResumeFailed,
        onStreamEvent: (ev) => {
          for (const normalized of normalizer.normalize(options.agentName, ev)) {
            options.onEvent(normalized);
          }
        },
        onExit: options.onExit,
      });
    },
    forgetAgent(agentName) {
      normalizer.forget(agentName);
    },
  };
};
