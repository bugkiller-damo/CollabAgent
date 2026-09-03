import { describe, expect, it } from "vitest";
import { parseWsInbound, wsFromBrowserSchema, wsFromDaemonSchema } from "../src/ws/validate.js";

// P1.28：WS 入站帧运行时校验（离线纯单测，无需 server/DB）。
// 逐 union 成员给出「最小合法帧」，确保 schema 与 shared union 的每个 type 对齐：
// 若未来 shared 加了 type 而这里漏改，本文件的成员清单即是最小对齐清单。
// 在线行为（畸形帧不断连、合法帧中继）由 ws.test.ts 的 P1.28 用例覆盖。

/** daemon→server 全部 12 个 type 的最小合法帧 */
const DAEMON_FRAMES: Record<string, unknown> = {
  ready: { type: "ready", capabilities: ["send"], runtimes: ["node:20"], hostname: "h", daemonVersion: "0.1.0" },
  "agent:status": { type: "agent:status", agentId: "a", agentName: "x", status: "running", detail: "" },
  "agent:delivery-queued": { type: "agent:delivery-queued", agentName: "x", channelName: "#general" },
  "agent:delivery-dead-letter": {
    type: "agent:delivery-dead-letter",
    agentName: "x",
    channelName: "#general",
    error: "boom",
  },
  "agent:tool-call": {
    type: "agent:tool-call",
    agentName: "x",
    agentId: "a",
    toolName: "Bash",
    toolUseId: "t1",
    status: "pending",
    text: null,
    time: new Date().toISOString(),
  },
  "terminal:frame": {
    type: "terminal:frame",
    agentName: "x",
    screen: "...",
    status: "running",
    time: new Date().toISOString(),
  },
  "terminal:obs-frame": { type: "terminal:obs-frame", agentName: "x", frame: { seq: 1, kind: "text" } },
  "terminal:obs-history": { type: "terminal:obs-history", agentName: "x", frames: [{ seq: 1 }, { seq: 2 }] },
  "terminal:history": { type: "terminal:history", agentName: "x", text: "log line" },
  "agent:progress": {
    type: "agent:progress",
    agentName: "x",
    channelName: "#general",
    headline: "h",
    phase: "update",
  },
  "workspace:result": { type: "workspace:result", requestId: "r1", agentName: "x", exists: true, files: [] },
  pong: { type: "pong" },
};

/** browser→server 全部 5 个 type 的最小合法帧 */
const BROWSER_FRAMES: Record<string, unknown> = {
  "terminal:watch": { type: "terminal:watch", agentName: "x" },
  "terminal:unwatch": { type: "terminal:unwatch", agentName: "x" },
  "terminal:history": { type: "terminal:history", agentName: "x" },
  "terminal:resize": { type: "terminal:resize", agentName: "x", cols: 120, rows: 40 },
  pong: { type: "pong" },
};

function parseDaemon(raw: string): unknown | null {
  return parseWsInbound(raw, wsFromDaemonSchema, "daemon-test");
}

describe("WS 入站校验：daemon→server 逐 type 对齐", () => {
  for (const [type, frame] of Object.entries(DAEMON_FRAMES)) {
    it(`合法帧通过：${type}`, () => {
      const out = parseDaemon(JSON.stringify(frame));
      expect(out).toMatchObject({ type });
    });
  }

  it("未知 type → 丢帧", () => {
    expect(parseDaemon(JSON.stringify({ type: "agent:activity", activity: "x" }))).toBeNull();
    expect(parseDaemon(JSON.stringify({ type: "hello" }))).toBeNull();
  });

  it("非 JSON / 非对象 / 缺 type → 丢帧", () => {
    expect(parseDaemon("not-json{{")).toBeNull();
    expect(parseDaemon(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parseDaemon(JSON.stringify({ nope: 1 }))).toBeNull();
  });

  it("已知 type 但关键字段错型/缺失 → 丢帧", () => {
    // agent:status 缺 agentId
    expect(parseDaemon(JSON.stringify({ type: "agent:status", agentName: "x", status: "s", detail: "" }))).toBeNull();
    // tool-call status 非枚举值
    expect(
      parseDaemon(
        JSON.stringify({
          type: "agent:tool-call",
          agentName: "x",
          agentId: "a",
          toolName: null,
          toolUseId: null,
          status: "started",
          text: null,
          time: new Date().toISOString(),
        }),
      ),
    ).toBeNull();
    // progress phase 非枚举
    expect(
      parseDaemon(
        JSON.stringify({ type: "agent:progress", agentName: "x", channelName: "#g", headline: "h", phase: "mid" }),
      ),
    ).toBeNull();
    // workspace:result exists 非布尔
    expect(
      parseDaemon(JSON.stringify({ type: "workspace:result", requestId: "r", agentName: "x", exists: "yes" })),
    ).toBeNull();
    // agentId 为数字（应 string）
    expect(
      parseDaemon(JSON.stringify({ type: "agent:status", agentId: 7, agentName: "x", status: "s", detail: "" })),
    ).toBeNull();
  });

  it("多余字段放行（passthrough 前向兼容）", () => {
    const out = parseDaemon(JSON.stringify({ type: "pong", extra: "future-field" }));
    expect(out).toMatchObject({ type: "pong" });
  });

  it("ready 字段全 optional：最小握手帧（probe-p127 形态）通过", () => {
    expect(parseDaemon(JSON.stringify({ type: "ready", runtimes: [] }))).toMatchObject({ type: "ready" });
  });
});

describe("WS 入站校验：browser→server 逐 type 对齐", () => {
  for (const [type, frame] of Object.entries(BROWSER_FRAMES)) {
    it(`合法帧通过：${type}`, () => {
      const out = parseWsInbound(JSON.stringify(frame), wsFromBrowserSchema, "browser-test");
      expect(out).toMatchObject({ type });
    });
  }

  it("browser 帧投到 daemon schema → 丢帧（方向隔离）", () => {
    // terminal:watch 只存在于 browser 面
    expect(parseDaemon(JSON.stringify(BROWSER_FRAMES["terminal:watch"]))).toBeNull();
  });

  it("terminal:resize cols/rows 错型 → 丢帧", () => {
    const out = parseWsInbound(
      JSON.stringify({ type: "terminal:resize", agentName: "x", cols: "wide" }),
      wsFromBrowserSchema,
      "browser-test",
    );
    expect(out).toBeNull();
  });
});
