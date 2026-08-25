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
let drivers: PersistentClaude[];

const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const makeDriver = (overrides: Partial<PersistentClaudeOpts> = {}) => {
  const d = new PersistentClaude({
    cwd: "D:\\tmp",
    env: {},
    label: "T",
    turnTimeoutMs: 5000, // 默认给足，避免误触发沉默超时；超时用例会显式覆盖
    startupDelayMs: 1,
    ...overrides,
  });
  drivers.push(d);
  return d;
};

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
    drivers = [];
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      const p = new FakeProc();
      procs.push(p);
      return p as never;
    });
  });

  afterEach(() => {
    for (const d of drivers) d.stop();
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

  it("沉默超时 kill：立即 reject 当前回合；后续消息换新进程继续排空", async () => {
    const d = makeDriver({ turnTimeoutMs: 80 });
    const p1 = d.send("m1");
    const p1Rejected = expect(p1).rejects.toThrow(/mid-turn/);
    await flush(20); // m1 in-flight，80ms 沉默计时启动
    await flush(100); // 超时 → settle + kill，不再等 exit
    expect(lastProc().kill).toHaveBeenCalledTimes(1);
    await p1Rejected;

    // 后续消息应触发一次新 spawn（旧进程已死）
    const p2 = d.send("m2");
    await flush(30);
    expect(procs).toHaveLength(2);
    emitLine(lastProc(), { type: "result" });
    await expect(p2).resolves.toBeUndefined();
    d.stop();
  });

  it("P0.1：旧进程迟到的 exit/stdout 不得 reject/resolve 新回合，也不得触发 onExit", async () => {
    const onExit = vi.fn();
    const onStreamEvent = vi.fn();
    // 200ms 超时：给「杀旧 → 启新 → 灌迟到事件 → result」留出窗口，避免新回合自己超时
    const d = makeDriver({ turnTimeoutMs: 200, startupDelayMs: 1, onExit, onStreamEvent });
    const p1 = d.send("m1");
    const p2 = d.send("m2");
    const p1Rejected = expect(p1).rejects.toThrow(/silence-timeout|mid-turn/);
    await flush(20);
    const oldProc = lastProc();
    expect(procs).toHaveLength(1);

    await flush(220); // 沉默超时：settle m1、kill P1、pump 换 P2
    await p1Rejected;
    await flush(30); // 等 P2 spawn + startupDelay + 写出 m2
    expect(procs).toHaveLength(2);
    const newProc = lastProc();
    expect(newProc).not.toBe(oldProc);
    expect(newProc.stdin.write).toHaveBeenCalledTimes(1);

    // 旧进程迟到事件（真实 kill 后 exit/stdout 可能在新回合 in-flight 之后才到）
    oldProc.emit("exit", 143);
    emitLine(oldProc, { type: "result" });
    await flush(10);

    expect(onExit).not.toHaveBeenCalled();
    // 新回合必须仍可正常完结——若旧 exit 误 reject / 旧 result 误 resolve，这里会失败
    emitLine(newProc, { type: "result" });
    await expect(p2).resolves.toBeUndefined();
    expect(onStreamEvent).toHaveBeenCalled();
    d.stop();
  });

  it("P0.1：旧进程迟到 exit 发生在新进程 starting 窗口内，不得 cleanup 掉新进程", async () => {
    const onExit = vi.fn();
    const d = makeDriver({ turnTimeoutMs: 80, startupDelayMs: 80, onExit });
    const p1 = d.send("m1");
    const p2 = d.send("m2");
    const p1Rejected = expect(p1).rejects.toThrow(/mid-turn/);
    await flush(20);
    const oldProc = lastProc();

    await flush(100); // 超时 → pump → spawn P2，但 80ms startup 尚未结束
    await p1Rejected;
    expect(procs).toHaveLength(2);
    const newProc = lastProc();

    oldProc.emit("exit", 143); // starting 窗口内的迟到 exit
    await flush(10);
    expect(onExit).not.toHaveBeenCalled();

    await flush(100); // 等 startupDelay 结束并写出 m2
    expect(newProc.stdin.write).toHaveBeenCalledTimes(1);
    emitLine(newProc, { type: "result" });
    await expect(p2).resolves.toBeUndefined();
    d.stop();
  });

  it("P0.1：同进程下一回合不被上一回合迟到的沉默超时误杀", async () => {
    // 200ms 给 m2 足够窗口；m1 result 后等 100ms 越过「若只比 gen、旧 timer 回调已入队」的窗口
    const d = makeDriver({ turnTimeoutMs: 200 });
    const p1 = d.send("m1");
    const p2 = d.send("m2");
    await flush(20);
    emitLine(lastProc(), { type: "result" }); // m1 完结，同进程立刻写 m2 并重新武装 timer
    await expect(p1).resolves.toBeUndefined();
    await flush(5);
    expect(procs).toHaveLength(1);
    expect(lastProc().stdin.write).toHaveBeenCalledTimes(2);

    await flush(100);
    expect(lastProc().kill).not.toHaveBeenCalled();
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
