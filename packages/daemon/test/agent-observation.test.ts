import { describe, expect, it } from "vitest";
import {
  createObservationBus,
  createSeqAllocator,
  type ObservationFrame,
  renderFrame,
  streamEventToFrames,
} from "../src/agent-observation.js";
import type { AgentRuntimeEvent } from "../src/agent-runtime-events.js";

const nullUsage = { costUsd: null, durationMs: null, numTurns: null };

describe("agent-observation", () => {
  describe("streamEventToFrames", () => {
    const seq = createSeqAllocator();

    it("session(init) → system 帧（含 sessionRef）；非 init subtype 不产帧", () => {
      const frames = streamEventToFrames(
        "alice",
        { type: "session", subtype: "init", sessionRef: "s1", model: "claude" },
        seq,
      );
      expect(frames).toHaveLength(1);
      expect(frames[0].kind).toBe("system");
      expect(frames[0].payload.text).toContain("s1");
      expect(streamEventToFrames("alice", { type: "session", subtype: "compact" }, seq)).toEqual([]);
    });

    it("text / thinking / tool.start 按事件序产帧（turnId 透传）", () => {
      const events: AgentRuntimeEvent[] = [
        { type: "thinking", turnId: "msg-1", text: "想一下" },
        { type: "text", turnId: "msg-1", text: "你好" },
        { type: "tool.start", turnId: "msg-1", toolName: "Read", toolUseId: "tu-1", input: { file_path: "a.ts" } },
      ];
      const frames = events.flatMap((ev) => streamEventToFrames("alice", ev, seq));
      expect(frames.map((f) => f.kind)).toEqual(["thinking", "text", "tool_use"]);
      expect(frames[2].payload.toolName).toBe("Read");
      expect(frames[2].payload.toolUseId).toBe("tu-1");
      expect(frames.every((f) => f.turnId === "msg-1")).toBe(true);
    });

    it("tool.end → tool_result 帧（C1 completed 数据源，toolName/turnId 透传）", () => {
      const frames = streamEventToFrames(
        "alice",
        { type: "tool.end", turnId: "msg-1", toolName: "Read", toolUseId: "tu-1", output: "file contents" },
        seq,
      );
      expect(frames).toHaveLength(1);
      expect(frames[0].kind).toBe("tool_result");
      expect(frames[0].turnId).toBe("msg-1");
      expect(frames[0].payload.toolName).toBe("Read");
      expect(frames[0].payload.toolUseId).toBe("tu-1");
      expect(frames[0].payload.text).toBe("file contents");
    });

    it("turn.end → turn_end 帧（含耗时/cost 摘要）", () => {
      const frames = streamEventToFrames(
        "alice",
        {
          type: "turn.end",
          status: "success",
          subtype: "success",
          usage: { costUsd: 0.0123, durationMs: 2300, numTurns: 2 },
        },
        seq,
      );
      expect(frames).toHaveLength(1);
      expect(frames[0].kind).toBe("turn_end");
      expect(frames[0].payload.summary).toContain("success");
      expect(frames[0].payload.summary).toContain("2.3s");
    });

    it("turn.end error → summary 含 subtype，result 进 text 字段", () => {
      const frames = streamEventToFrames(
        "alice",
        { type: "turn.end", status: "error", subtype: "error_max_turns", result: "boom", usage: nullUsage },
        seq,
      );
      expect(frames[0].payload.summary).toContain("error_max_turns");
      expect(frames[0].payload.text).toBe("boom");
    });

    it("超长内容截断（观察帧不扛完整内容）", () => {
      const frames = streamEventToFrames("alice", { type: "text", turnId: "m", text: "x".repeat(10000) }, seq);
      expect(frames[0].payload.text!.length).toBeLessThan(5000);
      expect(frames[0].payload.text).toContain("+6000 chars");
    });

    it("未知事件类型 → 空帧数组（不抛错）", () => {
      expect(streamEventToFrames("alice", { type: "mystery" } as never, seq)).toEqual([]);
      expect(streamEventToFrames("alice", null, seq)).toEqual([]);
    });

    // P1.15：agent 把自己的 scoped token echo 到输出时，观察帧（WS 围观/审计流）必须脱敏
    describe("token 脱敏（P1.15）", () => {
      const TOKEN = "sk_agent_abcd1234abcd1234abcd1234abcd1234";

      it("text / thinking 帧文本脱敏", () => {
        const frames = [
          ...streamEventToFrames("alice", { type: "text", turnId: "m", text: `token: ${TOKEN}` }, seq),
          ...streamEventToFrames("alice", { type: "thinking", turnId: "m", text: `用 ${TOKEN} 调一下` }, seq),
        ];
        expect(frames).toHaveLength(2);
        for (const f of frames) {
          expect(f.payload.text).toContain("sk_agent_***");
          expect(f.payload.text).not.toContain(TOKEN);
        }
      });

      it("tool.start 的截断文本与结构化 toolInput 都脱敏", () => {
        const frames = streamEventToFrames(
          "alice",
          {
            type: "tool.start",
            turnId: "m",
            toolName: "Bash",
            toolUseId: "tu-1",
            input: { command: `TOKEN=${TOKEN} curl x`, nested: { auth: TOKEN } },
          },
          seq,
        );
        const p = frames[0].payload;
        expect(p.text).not.toContain(TOKEN);
        expect(p.text).toContain("sk_agent_***");
        expect(JSON.stringify(p.toolInput)).not.toContain(TOKEN);
        expect(JSON.stringify(p.toolInput)).toContain("sk_agent_***");
      });

      it("tool.end 帧脱敏", () => {
        const frames = streamEventToFrames(
          "alice",
          { type: "tool.end", toolUseId: "tu-1", output: `stdout: ${TOKEN}` },
          seq,
        );
        expect(frames[0].payload.text).not.toContain(TOKEN);
        expect(frames[0].payload.text).toContain("sk_agent_***");
      });
    });
  });

  describe("ObservationBus", () => {
    it("publish/subscribe + replay buffer", () => {
      const bus = createObservationBus();
      const seq = createSeqAllocator();
      const received: ObservationFrame[] = [];
      bus.subscribe("alice", (f) => received.push(f));
      const frames = streamEventToFrames("alice", { type: "turn.end", status: "success", usage: nullUsage }, seq);
      for (const f of frames) bus.publish(f);
      expect(received).toHaveLength(1);
      expect(bus.replay("alice")).toHaveLength(1);
      expect(bus.listenerCount("alice")).toBe(1);
    });

    it("ring buffer 超容量截头", () => {
      const bus = createObservationBus({ bufferSize: 3 });
      let n = 0;
      const seq = () => ++n;
      for (let i = 0; i < 5; i++) {
        bus.publish({
          agentName: "a",
          seq: seq(),
          timestamp: Date.now(),
          kind: "text",
          turnId: null,
          payload: { text: `f${i}` },
        });
      }
      const replay = bus.replay("a");
      expect(replay.map((f) => f.payload.text)).toEqual(["f2", "f3", "f4"]);
    });

    it("transcript 渲染 + 长度截断", () => {
      const bus = createObservationBus();
      let n = 0;
      bus.publish({
        agentName: "a",
        seq: ++n,
        timestamp: Date.now(),
        kind: "tool_use",
        turnId: null,
        payload: { toolName: "Bash", text: "{}" },
      });
      bus.publish({
        agentName: "a",
        seq: ++n,
        timestamp: Date.now(),
        kind: "tool_result",
        turnId: null,
        payload: { text: "ok" },
      });
      const t = bus.transcript("a");
      expect(t).toContain("🔧 Bash");
      expect(t).toContain("↳ ok");
      expect(bus.transcript("a", 10).length).toBeLessThanOrEqual(10);
    });

    it("监听器抛错不影响其他订阅者", () => {
      const bus = createObservationBus();
      const received: string[] = [];
      bus.subscribe("a", () => {
        throw new Error("boom");
      });
      bus.subscribe("a", (f) => received.push(f.kind));
      bus.publish({
        agentName: "a",
        seq: 1,
        timestamp: Date.now(),
        kind: "text",
        turnId: null,
        payload: { text: "hi" },
      });
      expect(received).toEqual(["text"]);
    });

    it("clear 清空 buffer 和监听器", () => {
      const bus = createObservationBus();
      bus.subscribe("a", () => {});
      bus.publish({ agentName: "a", seq: 1, timestamp: Date.now(), kind: "text", turnId: null, payload: {} });
      bus.clear("a");
      expect(bus.replay("a")).toEqual([]);
      expect(bus.listenerCount("a")).toBe(0);
    });
  });

  describe("renderFrame", () => {
    const f = (kind: ObservationFrame["kind"], payload: ObservationFrame["payload"]): ObservationFrame => ({
      agentName: "a",
      seq: 1,
      timestamp: 0,
      kind,
      turnId: null,
      payload,
    });

    it("各 kind 渲染不抛错且非空", () => {
      for (const kind of ["system", "text", "thinking", "tool_use", "tool_result", "turn_end", "error"] as const) {
        expect(renderFrame(f(kind, { text: "t", toolName: "T", summary: "s" })).length).toBeGreaterThan(0);
      }
    });
  });
});
