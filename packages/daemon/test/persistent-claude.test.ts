import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { PersistentClaude, type PersistentClaudeOpts } from "../src/drivers/persistent-claude.js";

/**
 * PersistentClaude 回合级语义（以 src/drivers/persistent-claude.ts 实现为准）：
 * - send() 返回回合级 Promise：stream-json `result` 事件 → resolve；
 * - 进程 mid-turn 退出（含沉默超时 kill）→ reject（供 A1 队列重试）；
 * - stop() 拒绝活跃回合 + 全部排队消息；
 * - 每实例串行：一回合结束再发下一条。
 *
 * spawn 全 mock，不需要真 Claude CLI；用真实短延时计时器（同 dispatch-queue 测试风格）。
 */

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: vi.fn() };
  kill = vi.fn(); // 真实 kill 后 exit 异步到达——测试里由用例显式 emit("exit")
}

const spawnMock = vi.mocked(spawn);
let procs: FakeProc[];

const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const makeDriver = (overrides: Partial<PersistentClaudeOpts> = {}) =>
  new PersistentClaude({
    cwd: "D:\\tmp",
    env: {},
    label: "T",
    turnTimeoutMs: 5000, // 默认给足，避免误触发沉默超时；超时用例会显式覆盖
    startupDelayMs: 1,
    ...overrides,
  });

const lastProc = () => procs[procs.length - 1]!;

const emitLine = (proc: FakeProc, ev: unknown) => {
  proc.stdout.emit("data", `${JSON.stringify(ev)}\n`);
};

describe("PersistentClaude", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    procs = [];
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      const p = new FakeProc();
      procs.push(p);
      return p as never;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("result 事件 resolve 回合 Promise；stdin 收到 stream-json user 帧", async () => {
    const d = makeDriver();
    const p1 = d.send("m1");
    await flush(20);
    expect(procs).toHaveLength(1);
    expect(lastProc().stdin.write).toHaveBeenCalledTimes(1);
    const payload = String(lastProc().stdin.write.mock.calls[0]![0]);
    expect(JSON.parse(payload)).toEqual({ type: "user", message: { role: "user", content: "m1" } });

    emitLine(lastProc(), { type: "assistant", message: { content: [] } }); // 回合中事件
    emitLine(lastProc(), { type: "result" });
    await expect(p1).resolves.toBeUndefined();
    d.stop();
  });

  it("串行：上一回合未 result，下一条不写 stdin；result 后自动排空", async () => {
    const d = makeDriver();
    const p1 = d.send("m1");
    const p2 = d.send("m2");
    await flush(20);
    expect(lastProc().stdin.write).toHaveBeenCalledTimes(1); // 只有 m1

    emitLine(lastProc(), { type: "result" }); // m1 完结 → m2 写出
    await expect(p1).resolves.toBeUndefined();
    await flush(5);
    expect(lastProc().stdin.write).toHaveBeenCalledTimes(2);

    emitLine(lastProc(), { type: "result" });
    await expect(p2).resolves.toBeUndefined();
    d.stop();
  });

  it("进程 mid-turn 退出：回合 Promise reject 并触发 onExit", async () => {
    const onExit = vi.fn();
    const d = makeDriver({ onExit });
    const p1 = d.send("m1");
    await flush(20);
    lastProc().emit("exit", 1);
    await expect(p1).rejects.toThrow(/mid-turn/);
    expect(onExit).toHaveBeenCalledTimes(1);
    d.stop();
  });

  it("沉默超时 kill：回合随 exit reject；后续消息换新进程继续排空", async () => {
    const d = makeDriver({ turnTimeoutMs: 30 });
    const p1 = d.send("m1");
    await flush(20); // m1 in-flight，30ms 沉默计时启动
    await flush(60); // 超时 → kill
    expect(lastProc().kill).toHaveBeenCalledTimes(1);

    lastProc().emit("exit", 143); // kill 后的 exit → m1 reject
    await expect(p1).rejects.toThrow(/mid-turn/);

    // 后续消息应触发一次新 spawn（旧进程已死）
    const p2 = d.send("m2");
    await flush(30);
    expect(procs).toHaveLength(2);
    emitLine(lastProc(), { type: "result" });
    await expect(p2).resolves.toBeUndefined();
    d.stop();
  });

  it("沉默超时被事件续命：持续有事件则不 kill", async () => {
    const d = makeDriver({ turnTimeoutMs: 40 });
    const p1 = d.send("m1");
    await flush(20);
    // 每 20ms 一个事件，跨 80ms 窗口——每次事件都重置 40ms 计时
    for (let i = 0; i < 4; i++) {
      emitLine(lastProc(), { type: "assistant", message: { content: [] } });
      await flush(20);
    }
    expect(lastProc().kill).not.toHaveBeenCalled();
    emitLine(lastProc(), { type: "result" });
    await expect(p1).resolves.toBeUndefined();
    d.stop();
  });

  it("stop() 拒绝活跃回合与全部排队消息", async () => {
    const d = makeDriver();
    const p1 = d.send("m1"); // 将成 in-flight
    const p2 = d.send("m2"); // 排队
    await flush(20);
    d.stop();
    await expect(p1).rejects.toThrow(/stopped/);
    await expect(p2).rejects.toThrow(/stopped/);
    expect(lastProc().kill).toHaveBeenCalled();
  });

  it("spawn 抛错：回合 reject「cannot spawn」", async () => {
    spawnMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const d = makeDriver();
    await expect(d.send("m1")).rejects.toThrow(/cannot spawn/);
  });

  it("stdout 分片到达：跨 chunk 的 JSON 行正确解析", async () => {
    const d = makeDriver();
    const p1 = d.send("m1");
    await flush(20);
    const line = `${JSON.stringify({ type: "result" })}\n`;
    lastProc().stdout.emit("data", line.slice(0, 5));
    lastProc().stdout.emit("data", line.slice(5));
    await expect(p1).resolves.toBeUndefined();
    d.stop();
  });

  it("非 JSON 行被忽略，不污染回合", async () => {
    const d = makeDriver();
    const p1 = d.send("m1");
    await flush(20);
    lastProc().stdout.emit("data", "this is not json\n");
    emitLine(lastProc(), { type: "result" });
    await expect(p1).resolves.toBeUndefined();
    d.stop();
  });
});
