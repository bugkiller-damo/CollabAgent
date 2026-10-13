import { describe, expect, it } from "vitest";
import {
  decodeSarpWorkerFrame,
  encodeSarpFrame,
  mapWireError,
  SARP_MAX_FRAME_BYTES,
  SARP_PROTOCOL,
  SARP_VERSION,
  SarpInbound,
  SarpProtocolError,
} from "../src/sarp-protocol.js";

/**
 * Phase 2：SARP/1 线格式与校验（design §8）。
 * 纪律：stdout 只走协议帧；未知消息必须显式 optional 才忽略；wire 错误码
 * 经显式映射表进 DispatchError，未映射码收敛 worker-error（永久）。
 */

let seq = 0;
const frame = (fields: Record<string, unknown>): string =>
  JSON.stringify({
    protocol: SARP_PROTOCOL,
    version: SARP_VERSION,
    seq: ++seq,
    timestamp: new Date().toISOString(),
    ...fields,
  });

const decodeErr = (line: string): SarpProtocolError => {
  try {
    decodeSarpWorkerFrame(line);
  } catch (e) {
    expect(e).toBeInstanceOf(SarpProtocolError);
    return e as SarpProtocolError;
  }
  throw new Error("expected decode to throw");
};

describe("encodeSarpFrame", () => {
  it("带信封字段 + 尾部换行", () => {
    const line = encodeSarpFrame(
      {
        type: "turn.start",
        fields: {
          turnId: "t1",
          conversationId: "slock:v1:a:thread:t",
          attempt: 1,
          source: { kind: "message" },
          prompt: "hi",
        },
      },
      7,
    );
    expect(line.endsWith("\n")).toBe(true);
    const o = JSON.parse(line);
    expect(o).toMatchObject({
      protocol: SARP_PROTOCOL,
      version: SARP_VERSION,
      type: "turn.start",
      seq: 7,
      turnId: "t1",
    });
    expect(typeof o.timestamp).toBe("string");
  });
});

describe("decodeSarpWorkerFrame — 信封", () => {
  it("runtime.ready 完整解析", () => {
    const msg = decodeSarpWorkerFrame(
      frame({
        type: "runtime.ready",
        requestId: "init_1",
        runtime: { id: "bridge", frameworkVersion: "0.6", bridgeVersion: "1" },
        capabilities: { durableThreads: true, maxConcurrency: 1, usage: "cost" },
        model: { selected: "gpt-x", overrides: true },
      }),
    );
    expect(msg).toMatchObject({
      type: "runtime.ready",
      requestId: "init_1",
      runtime: { id: "bridge" },
      capabilities: { durableThreads: true, maxConcurrency: 1 },
      model: { overrides: true },
    });
  });

  it("protocol/version/seq/timestamp 缺失或非法 → 信封错误", () => {
    expect(decodeErr(JSON.stringify({ type: "x", seq: 1, timestamp: "t" })).reason).toBe("invalid-envelope");
    expect(decodeErr(frame({ type: "runtime.stopped" }).replace('"version":1', '"version":2')).reason).toBe(
      "unsupported-version",
    );
    expect(
      decodeErr(JSON.stringify({ protocol: SARP_PROTOCOL, version: 1, type: "x", seq: 0, timestamp: "t" })).reason,
    ).toBe("invalid-envelope");
    expect(decodeErr(JSON.stringify({ protocol: SARP_PROTOCOL, version: 1, type: "x", seq: 1 })).reason).toBe(
      "invalid-envelope",
    );
  });

  it("非 JSON / 非对象 → invalid-json / invalid-envelope", () => {
    expect(decodeErr("{oops").reason).toBe("invalid-json");
    expect(decodeErr("[1,2]").reason).toBe("invalid-envelope");
  });

  it("超 1MiB → frame-too-large", () => {
    const big = frame({ type: "assistant.delta", turnId: "t", eventSeq: 1, text: "x".repeat(SARP_MAX_FRAME_BYTES) });
    expect(decodeErr(big).reason).toBe("frame-too-large");
  });
});

describe("decodeSarpWorkerFrame — schema 与未知消息", () => {
  it("缺必填字段 → invalid-schema", () => {
    expect(decodeErr(frame({ type: "assistant.delta", turnId: "t", eventSeq: 1 })).reason).toBe("invalid-schema");
    expect(decodeErr(frame({ type: "turn.end", turnId: "t", eventSeq: 1, status: "weird" })).reason).toBe(
      "invalid-schema",
    );
    expect(decodeErr(frame({ type: "tool.end", turnId: "t", eventSeq: 1, callId: "c", ok: "yes" })).reason).toBe(
      "invalid-schema",
    );
  });

  it("tool.start/tool.end：callId 顶层 + tool 内 name/provider/operation", () => {
    const s = decodeSarpWorkerFrame(
      frame({
        type: "tool.start",
        turnId: "t",
        eventSeq: 1,
        callId: "c1",
        tool: { name: "send_message", provider: "slock", operation: "send_message" },
        input: { channel: "x" },
      }),
    );
    expect(s).toMatchObject({
      type: "tool.start",
      callId: "c1",
      tool: { name: "send_message", provider: "slock", operation: "send_message" },
      input: { channel: "x" },
    });
    const e = decodeSarpWorkerFrame(
      frame({ type: "tool.end", turnId: "t", eventSeq: 2, callId: "c1", tool: { name: "send_message" }, ok: true }),
    );
    expect(e).toMatchObject({ type: "tool.end", callId: "c1", ok: true });
  });

  it("未知 type + optional:true → null（忽略）；无 optional → unexpected-message", () => {
    const opt = JSON.parse(frame({ type: "future.thing", optional: true }));
    expect(decodeSarpWorkerFrame(JSON.stringify(opt))).toBeNull();
    expect(decodeErr(frame({ type: "future.thing" })).reason).toBe("unexpected-message");
  });

  it("已知 type 即使 optional:true 也必须过 schema（§8.1.6）", () => {
    const bad = JSON.parse(frame({ type: "assistant.delta", turnId: "t", eventSeq: 1, optional: true }));
    // 缺 text → 仍然 invalid-schema，不因 optional 放行
    expect(decodeErr(JSON.stringify(bad)).reason).toBe("invalid-schema");
  });

  it("turn.interrupt / turn.end.error / usage 解析", () => {
    expect(
      decodeSarpWorkerFrame(
        frame({
          type: "turn.interrupt",
          turnId: "t",
          eventSeq: 1,
          interruptId: "i9",
          resumeToken: "r7",
          prompt: "批准?",
        }),
      ),
    ).toMatchObject({ type: "turn.interrupt", interruptId: "i9", resumeToken: "r7" });
    expect(
      decodeSarpWorkerFrame(
        frame({
          type: "turn.end",
          turnId: "t",
          eventSeq: 2,
          status: "error",
          error: { code: "MODEL_RATE_LIMITED", message: "rl", retryable: true, retryAfterMs: 30000 },
        }),
      ),
    ).toMatchObject({ type: "turn.end", status: "error", error: { code: "MODEL_RATE_LIMITED", retryAfterMs: 30000 } });
    expect(
      decodeSarpWorkerFrame(
        frame({ type: "usage", turnId: "t", eventSeq: 3, usage: { inputTokens: 5, costUsd: 0.01 } }),
      ),
    ).toMatchObject({ type: "usage", usage: { inputTokens: 5, costUsd: 0.01 } });
  });
});

describe("SarpInbound — 入向 seq 单调", () => {
  it("seq 递增通过；回退 → unexpected-message", () => {
    const inbound = new SarpInbound();
    expect(inbound.next(frame({ type: "runtime.stopped" }))).toMatchObject({ type: "runtime.stopped" });
    const dup = JSON.stringify({ ...JSON.parse(frame({ type: "runtime.stopped" })), seq: 1 });
    try {
      inbound.next(dup);
      expect.unreachable();
    } catch (e) {
      expect((e as SarpProtocolError).reason).toBe("unexpected-message");
    }
  });

  it("optional 未知帧不消费 seq", () => {
    const inbound = new SarpInbound();
    inbound.next(frame({ type: "runtime.stopped" }));
    expect(inbound.next(JSON.stringify({ ...JSON.parse(frame({ type: "x.y", optional: true })), seq: 99 }))).toBeNull();
    // 之后正常递增帧不受影响
    expect(inbound.next(frame({ type: "runtime.stopped" }))).toMatchObject({ type: "runtime.stopped" });
  });
});

describe("mapWireError — wire 错误映射", () => {
  const map = (code: string, extra: Record<string, unknown> = {}) => mapWireError({ code, message: "m", ...extra });

  it("已知码 → 对应 DispatchErrorCode", () => {
    expect(map("MODEL_RATE_LIMITED").code).toBe("provider-rate-limited");
    expect(map("MODEL_RATE_LIMITED", { retryable: true }).retriable).toBe(true);
    expect(map("PROVIDER_AUTH_FAILED").code).toBe("provider-auth-failed");
    expect(map("PROVIDER_AUTH_FAILED").retriable).toBe(false);
    expect(map("MODEL_NETWORK_FAILED").code).toBe("provider-network-failed");
    expect(map("GRAPH_INPUT_INVALID").code).toBe("graph-input-invalid");
    expect(map("MCP_START_FAILED").code).toBe("mcp-start-failed");
    expect(map("MODEL_NOT_ALLOWED").code).toBe("model-not-allowed");
  });

  it("retryAfterMs 透传且受上限钳制", () => {
    expect(map("MODEL_RATE_LIMITED", { retryable: true, retryAfterMs: 30_000 }).retryAfterMs).toBe(30_000);
    expect(map("MODEL_RATE_LIMITED", { retryable: true, retryAfterMs: 9_999_999 }).retryAfterMs).toBe(120_000);
  });

  it("未映射码 → worker-error（永久）", () => {
    const e = map("SOME_INTERNAL_THING");
    expect(e.code).toBe("worker-error");
    expect(e.retriable).toBe(false);
    expect(e.message).toContain("SOME_INTERNAL_THING");
  });
});

describe("WP7 — interrupt.options 宽容解析（R-UF）", () => {
  const intr = (extra: Record<string, unknown>) =>
    decodeSarpWorkerFrame(
      frame({
        type: "turn.interrupt",
        turnId: "t",
        eventSeq: 1,
        interruptId: "i1",
        resumeToken: "r1",
        prompt: "审批?",
        ...extra,
      }),
    ) as { options?: unknown };

  it("完整 options：decisions 白名单 + actions 保序", () => {
    const msg = intr({
      options: {
        decisions: ["approve", "reject", "respond", "edit"],
        actions: [{ name: "send_email", args: { to: "a@b.c" }, description: "发邮件" }, { name: "cleanup" }],
      },
    });
    expect(msg.options).toEqual({
      decisions: ["approve", "reject", "respond", "edit"],
      actions: [{ name: "send_email", args: { to: "a@b.c" }, description: "发邮件" }, { name: "cleanup" }],
    });
  });

  it("非法 decision 枚举项丢弃；全部非法 → options 省略", () => {
    const msg = intr({ options: { decisions: ["approve", "hack", "maybe", "reject"] } });
    expect(msg.options).toEqual({ decisions: ["approve", "reject"] });
    const none = intr({ options: { decisions: ["hack", 42, null] } });
    expect(none.options).toBeUndefined();
  });

  it("缺/空 name 的 action 丢弃；description 非字符串省略", () => {
    const msg = intr({
      options: {
        actions: [
          { name: "ok_action" },
          { args: {} }, // 缺 name → 丢
          { name: "" }, // 空 name → 丢
          { name: "with_bad_desc", description: 7 },
          "not-an-object",
        ],
      },
    });
    expect(msg.options).toEqual({
      actions: [{ name: "ok_action" }, { name: "with_bad_desc" }],
    });
  });

  it("actions 超过 10 条截断", () => {
    const actions = Array.from({ length: 15 }, (_, i) => ({ name: `a${i}` }));
    const msg = intr({ options: { actions } });
    const opts = msg.options as { actions: Array<{ name: string }> };
    expect(opts.actions).toHaveLength(10);
    expect(opts.actions[9].name).toBe("a9");
  });

  it("options 非对象 / 空对象 → 不抛错、字段缺省", () => {
    expect(intr({ options: "bogus" }).options).toBeUndefined();
    expect(intr({ options: 42 }).options).toBeUndefined();
    expect(intr({ options: {} }).options).toBeUndefined();
    // 无 options 字段的旧帧一切照旧
    expect(intr({}).options).toBeUndefined();
  });

  it("turn.end.interrupt.options 同样解析（args 原样保留）", () => {
    const msg = decodeSarpWorkerFrame(
      frame({
        type: "turn.end",
        turnId: "t",
        eventSeq: 1,
        status: "interrupted",
        interrupt: {
          interruptId: "i1",
          resumeToken: "r1",
          prompt: "p",
          options: {
            decisions: ["approve", "edit"],
            actions: [{ name: "mutate", args: { secret: "v", n: 1 } }],
          },
        },
      }),
    ) as { interrupt?: { options?: { decisions?: string[]; actions?: Array<{ args?: unknown }> } } };
    expect(msg.interrupt?.options?.decisions).toEqual(["approve", "edit"]);
    // 解析层不脱敏——args 原样到 dispatch（出站摘要由 daemon-core 处理）
    expect(msg.interrupt?.options?.actions?.[0]?.args).toEqual({ secret: "v", n: 1 });
  });
});

describe("WP7 — turn.start 新字段编码（daemon→worker）", () => {
  it("message/contextText/resume.decision 按存在性进帧", () => {
    const line = encodeSarpFrame(
      {
        type: "turn.start",
        fields: {
          turnId: "t1",
          conversationId: "slock:v1:a:channel:c",
          attempt: 1,
          source: { kind: "message", channel: "c", sender: "u1" },
          prompt: "assembled",
          message: {
            text: "原始消息",
            sender: "u1",
            messageId: "m-9",
            attachments: [
              { id: "att-1", filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 10, url: "/api/att-1" },
            ],
          },
          contextText: "<history/>",
          resume: {
            interruptId: "i1",
            resumeToken: "r1",
            value: "批准",
            decision: { type: "edit", args: { x: 1 } },
          },
        },
      },
      1,
    );
    const o = JSON.parse(line);
    expect(o.message).toEqual({
      text: "原始消息",
      sender: "u1",
      messageId: "m-9",
      attachments: [{ id: "att-1", filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 10, url: "/api/att-1" }],
    });
    expect(o.contextText).toBe("<history/>");
    expect(o.resume).toEqual({
      interruptId: "i1",
      resumeToken: "r1",
      value: "批准",
      decision: { type: "edit", args: { x: 1 } },
    });
  });

  it("可选字段缺省时不进帧（向后兼容：旧 worker 解码不变）", () => {
    const line = encodeSarpFrame(
      {
        type: "turn.start",
        fields: {
          turnId: "t1",
          conversationId: "c1",
          attempt: 1,
          source: { kind: "message" },
          prompt: "hi",
          resume: { interruptId: "i", resumeToken: "r", value: "v" },
        },
      },
      1,
    );
    const o = JSON.parse(line);
    expect("message" in o).toBe(false);
    expect("contextText" in o).toBe(false);
    expect(o.resume).toEqual({ interruptId: "i", resumeToken: "r", value: "v" });
  });
});
