import { describe, expect, it, vi } from "vitest";

/**
 * Phase 0：Claude runtime driver 适配器单测。
 *
 * - createClaudeEventNormalizer：Claude stream-json → AgentRuntimeEvent
 *   （块顺序 / session 映射 / tool_result 文本化 / 累计成本→本回合增量）。
 * - createClaudeRuntimeDriver：persistent 返回真实 PersistentClaude 实例、
 *   oneshot 包装 claudePrint 为 AgentRuntimeSession，两路共享 normalizer 状态。
 *
 * PersistentClaude / claudePrint 用 vi.mock 换成可控假实现（不启真实 claude）。
 */

const { FakePersistentClaude, claudePrintMock, claudePrintImpl } = vi.hoisted(() => {
  class FakePersistentClaude {
    static instances: FakePersistentClaude[] = [];
    static reset(): void {
      FakePersistentClaude.instances = [];
    }
    opts: any;
    sent: string[] = [];
    alive = true;
    stopped = false;
    constructor(opts: unknown) {
      this.opts = opts;
      FakePersistentClaude.instances.push(this);
    }
    send(text: string): Promise<void> {
      this.sent.push(text);
      return Promise.resolve();
    }
    /** 测试辅助：模拟一条原始 stream-json 事件到达 */
    emit(ev: unknown): void {
      this.opts.onStreamEvent?.(ev);
    }
    stop(): void {
      this.stopped = true;
      this.alive = false;
    }
  }
  const claudePrintImpl = async (...args: unknown[]) => {
    const onStreamEvent = args[5];
    if (typeof onStreamEvent === "function") {
      (onStreamEvent as (ev: unknown) => void)({
        type: "result",
        subtype: "success",
        total_cost_usd: 0.02,
        duration_ms: 7,
        num_turns: 1,
      });
    }
    return { reply: "ok", sessionId: "sess-print-1" };
  };
  const claudePrintMock = vi.fn(claudePrintImpl);
  return { FakePersistentClaude, claudePrintMock, claudePrintImpl };
});

vi.mock("../src/drivers/persistent-claude.js", () => ({ PersistentClaude: FakePersistentClaude }));
vi.mock("../src/claude-print.js", () => ({ claudePrint: claudePrintMock }));

import { createClaudeEventNormalizer, createClaudeRuntimeDriver } from "../src/drivers/claude-runtime.js";

const openOpts = (overrides: Record<string, unknown> = {}) => ({
  agentName: "alice",
  mode: "persistent" as const,
  cwd: "D:/tmp",
  env: {},
  onEvent: vi.fn(),
  ...overrides,
});

describe("createClaudeEventNormalizer", () => {
  it("system 事件 → session（保留 subtype/sessionRef/model）", () => {
    const n = createClaudeEventNormalizer();
    const out = n.normalize("alice", { type: "system", subtype: "init", session_id: "s1", model: "claude-x" });
    expect(out).toEqual([{ type: "session", subtype: "init", sessionRef: "s1", model: "claude-x" }]);
  });

  it("assistant 消息按块原序拆成 text / thinking / tool.start", () => {
    const n = createClaudeEventNormalizer();
    const out = n.normalize("alice", {
      type: "assistant",
      message: {
        id: "msg-1",
        content: [
          { type: "thinking", thinking: "想一下" },
          { type: "text", text: "你好" },
          { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "a.ts" } },
          { type: "text", text: "读完再说" },
        ],
      },
    });
    expect(out.map((e) => e.type)).toEqual(["thinking", "text", "tool.start", "text"]);
    expect(out.every((e) => e.turnId === "msg-1")).toBe(true);
    const toolStart = out[2]!;
    if (toolStart.type !== "tool.start") throw new Error("unreachable");
    expect(toolStart.toolName).toBe("Read");
    expect(toolStart.toolUseId).toBe("tu-1");
    expect(toolStart.input).toEqual({ file_path: "a.ts" });
  });

  it("user 消息的 tool_result → tool.end（字符串原样透传）", () => {
    const n = createClaudeEventNormalizer();
    const out = n.normalize("alice", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu-1", content: "file contents" }] },
    });
    expect(out).toEqual([{ type: "tool.end", toolUseId: "tu-1", output: "file contents" }]);
  });

  it("tool_result 的块数组 content 按 text 拼接（blockText 语义保持）", () => {
    const n = createClaudeEventNormalizer();
    const out = n.normalize("alice", {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-2",
            content: [
              { type: "text", text: "line1" },
              { type: "text", text: "line2" },
            ],
          },
        ],
      },
    });
    expect(out[0]).toMatchObject({ type: "tool.end", toolUseId: "tu-2", output: "line1\nline2" });
  });

  it("tool_result 的非字符串非数组 content 走 JSON 序列化", () => {
    const n = createClaudeEventNormalizer();
    const out = n.normalize("alice", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu-3", content: { code: 42 } }] },
    });
    expect(out[0]).toMatchObject({ type: "tool.end", output: '{"code":42}' });
  });

  it("result → 恰好一条 turn.end；subtype 非 success 归一为 error 并保留原 subtype", () => {
    const n = createClaudeEventNormalizer();
    const ok = n.normalize("alice", {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.01,
      duration_ms: 2300,
      num_turns: 2,
      result: "done",
    });
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({
      type: "turn.end",
      status: "success",
      subtype: "success",
      result: "done",
      usage: { costUsd: 0.01, durationMs: 2300, numTurns: 2 },
    });

    const bad = n.normalize("alice", { type: "result", subtype: "error_max_turns", result: "boom" });
    expect(bad[0]).toMatchObject({ type: "turn.end", status: "error", subtype: "error_max_turns", result: "boom" });
  });

  it("数值字段接受数字字符串；缺失/非法 → null", () => {
    const n = createClaudeEventNormalizer();
    const out = n.normalize("alice", {
      type: "result",
      subtype: "success",
      total_cost_usd: "0.5",
      duration_ms: "abc",
      // num_turns 缺省
    });
    const usage = out[0]!.type === "turn.end" ? out[0]!.usage : null;
    expect(usage).toEqual({ costUsd: 0.5, durationMs: null, numTurns: null });
  });

  it("会话累计成本换算本回合增量：0.05 → 0.12 记 0.05 → 0.07", () => {
    const n = createClaudeEventNormalizer();
    const first = n.normalize("alice", { type: "result", subtype: "success", total_cost_usd: 0.05 });
    const second = n.normalize("alice", { type: "result", subtype: "success", total_cost_usd: 0.12 });
    const u = (e: (typeof first)[number]) => (e.type === "turn.end" ? e.usage.costUsd : null);
    expect(u(first[0]!)).toBeCloseTo(0.05, 10);
    expect(u(second[0]!)).toBeCloseTo(0.07, 10);
  });

  it("forget 清基线：下一条累计按原值记（新进程首条）", () => {
    const n = createClaudeEventNormalizer();
    n.normalize("alice", { type: "result", subtype: "success", total_cost_usd: 0.05 });
    n.forget("alice");
    const out = n.normalize("alice", { type: "result", subtype: "success", total_cost_usd: 0.08 });
    const usage = out[0]!.type === "turn.end" ? out[0]!.usage.costUsd : null;
    // forget 后按「首条累计」记 0.08；若基线没清则是 0.08 − 0.05 = 0.03。
    expect(usage).toBeCloseTo(0.08, 10);
  });

  it("未知/旁路事件 → 空数组", () => {
    const n = createClaudeEventNormalizer();
    expect(n.normalize("alice", null as never)).toEqual([]);
    expect(n.normalize("alice", { type: "assistant", message: { content: "not-array" } })).toEqual([]);
  });
});

describe("createClaudeRuntimeDriver", () => {
  it("身份：driverId=claude-stream，runtimeIds=[claude]", () => {
    const driver = createClaudeRuntimeDriver();
    expect(driver.driverId).toBe("claude-stream");
    expect(driver.runtimeIds).toEqual(["claude"]);
  });

  it("persistent：返回真实 PersistentClaude 实例，resumeSessionRef→resumeSessionId，回调透传", () => {
    FakePersistentClaude.reset();
    const driver = createClaudeRuntimeDriver();
    const onResumeFailed = vi.fn();
    const onExit = vi.fn();
    const session = driver.openSession(
      openOpts({
        systemPromptFile: "prompt.md",
        label: "@alice",
        model: "haiku",
        resumeSessionRef: "sess-old",
        onResumeFailed,
        onExit,
      }),
    );

    expect(FakePersistentClaude.instances).toHaveLength(1);
    const inst = FakePersistentClaude.instances[0]!;
    expect(session).toBe(inst);
    expect(inst.opts.cwd).toBe("D:/tmp");
    expect(inst.opts.systemPromptFile).toBe("prompt.md");
    expect(inst.opts.label).toBe("@alice");
    expect(inst.opts.model).toBe("haiku");
    expect(inst.opts.resumeSessionId).toBe("sess-old");
    expect(inst.opts.onResumeFailed).toBe(onResumeFailed);
    expect(inst.opts.onExit).toBe(onExit);
    expect(session.alive).toBe(true);
  });

  it("persistent：原始 stream-json 事件经 normalizer 进 onEvent", () => {
    FakePersistentClaude.reset();
    const driver = createClaudeRuntimeDriver();
    const onEvent = vi.fn();
    driver.openSession(openOpts({ onEvent }));
    const inst = FakePersistentClaude.instances[0]!;

    inst.emit({ type: "system", subtype: "init", session_id: "s9", model: "m" });
    inst.emit({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.03,
      duration_ms: 5,
      num_turns: 1,
    });

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent.mock.calls[0]![0]).toEqual({ type: "session", subtype: "init", sessionRef: "s9", model: "m" });
    expect(onEvent.mock.calls[1]![0]).toMatchObject({
      type: "turn.end",
      status: "success",
      usage: { costUsd: 0.03, durationMs: 5, numTurns: 1 },
    });
  });

  it("oneshot：send 包装 claudePrint（原有位参数序），返回 { sessionRef }", async () => {
    claudePrintMock.mockReset().mockImplementation(claudePrintImpl);
    const driver = createClaudeRuntimeDriver();
    const onEvent = vi.fn();
    const session = driver.openSession(
      openOpts({
        mode: "oneshot",
        systemPromptFile: "p.md",
        env: { A: "1" },
        model: "sonnet",
        resumeSessionRef: "sess-prev",
        onEvent,
      }),
    );
    expect(session.alive).toBe(true);

    const result = await session.send("hello");
    expect(result).toEqual({ sessionRef: "sess-print-1" });
    expect(claudePrintMock).toHaveBeenCalledTimes(1);
    const [prompt, sid, promptFile, env, cwd, cb, model] = claudePrintMock.mock.calls[0]!;
    expect(prompt).toBe("hello");
    expect(sid).toBe("sess-prev");
    expect(promptFile).toBe("p.md");
    expect(env).toEqual({ A: "1" });
    expect(cwd).toBe("D:/tmp");
    expect(typeof cb).toBe("function");
    expect(model).toBe("sonnet");
    // 事件回调同样走 normalizer → onEvent
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "turn.end",
        status: "success",
        usage: expect.objectContaining({ costUsd: 0.02 }),
      }),
    );
    // 回合结束后会话即终结（one-shot 进程短命随 send 结束）
    expect(session.alive).toBe(false);
  });

  it("oneshot：claudePrint 无 sessionId 时返回 {}；send 后拒二次 send；stop() 幂等", async () => {
    claudePrintMock.mockReset().mockResolvedValue({ reply: "ok" });
    const driver = createClaudeRuntimeDriver();
    const session = driver.openSession(openOpts({ mode: "oneshot" }));
    const result = await session.send("hi");
    expect(result).toEqual({});
    expect(session.alive).toBe(false);
    // 已完成的会话不能再起第二个 claudePrint 进程
    await expect(session.send("again")).rejects.toThrow("runtime session stopped");
    expect(claudePrintMock).toHaveBeenCalledTimes(1);
    session.stop();
    session.stop();
    expect(session.alive).toBe(false);
  });

  it("oneshot：send 前 stop() 拒投且不 spawn 进程", async () => {
    claudePrintMock.mockReset().mockImplementation(claudePrintImpl);
    const driver = createClaudeRuntimeDriver();
    const session = driver.openSession(openOpts({ mode: "oneshot" }));
    session.stop();
    expect(session.alive).toBe(false);
    await expect(session.send("hi")).rejects.toThrow("runtime session stopped");
    expect(claudePrintMock).not.toHaveBeenCalled();
  });

  it("persistent 与 oneshot 共享 normalizer 状态；forgetAgent 清基线", async () => {
    FakePersistentClaude.reset();
    claudePrintMock.mockReset().mockImplementation(claudePrintImpl);
    const driver = createClaudeRuntimeDriver();

    // persistent 回合记 0.03
    const onEventP = vi.fn();
    driver.openSession(openOpts({ onEvent: onEventP }));
    FakePersistentClaude.instances[0]!.emit({ type: "result", subtype: "success", total_cost_usd: 0.03 });

    // 同一 driver 的 oneshot 回合：claudePrint 报累计 0.02 < 基线 → 回退按原值记
    const onEventO = vi.fn();
    const os = driver.openSession(openOpts({ mode: "oneshot", onEvent: onEventO }));
    await os.send("x");
    expect(onEventO).toHaveBeenCalledWith(
      expect.objectContaining({ type: "turn.end", usage: expect.objectContaining({ costUsd: 0.02 }) }),
    );

    // forgetAgent 后下一条累计按首条处理
    driver.forgetAgent("alice");
    FakePersistentClaude.instances[0]!.emit({ type: "result", subtype: "success", total_cost_usd: 0.04 });
    const last = onEventP.mock.calls.at(-1)![0];
    expect(last).toMatchObject({ type: "turn.end", usage: { costUsd: 0.04 } });
  });
});
