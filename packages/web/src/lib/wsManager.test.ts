import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWsManager, type WebSocketLike, type WsConnStatus } from "./wsManager";

// O16：wsManager 生命周期单测——fake socket + fake timers，全确定性。

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
  // 测试驱动
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

function setup(overrides: {
  onEvent?: (m: any) => void;
  onConnect?: (isReconnect: boolean) => void;
  onStatus?: (s: WsConnStatus, attempt: number) => void;
  minReconnectDelayMs?: number;
  inboundWatchdogMs?: number;
}) {
  const events: any[] = [];
  const statuses: [WsConnStatus, number][] = [];
  const connects: boolean[] = [];
  const mgr = createWsManager({
    url: "ws://test/ws/chat",
    minReconnectDelayMs: 100,
    maxReconnectDelayMs: 400,
    inboundWatchdogMs: 1000,
    createSocket: (url) => new FakeSocket(url),
    onEvent: overrides.onEvent ?? ((m) => events.push(m)),
    onStatus: overrides.onStatus ?? ((s, a) => statuses.push([s, a])),
    onConnect: overrides.onConnect ?? ((r) => connects.push(r)),
  });
  return { mgr, events, statuses, connects };
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("wsManager", () => {
  it("start 建连并置 connected；onConnect(false) 表示首连", () => {
    const { mgr, statuses, connects } = setup({});
    mgr.start();
    expect(statuses[0]).toEqual(["connecting", 0]);
    FakeSocket.instances[0].open();
    expect(mgr.isConnected()).toBe(true);
    expect(statuses.at(-1)).toEqual(["connected", 0]);
    expect(connects).toEqual([false]);
  });

  it("ping 自动回 pong 且不进入 onEvent；普通消息进 onEvent", () => {
    const { mgr, events } = setup({});
    mgr.start();
    const sock = FakeSocket.instances[0];
    sock.open();
    sock.emit({ type: "ping" });
    expect(sock.sent).toEqual([JSON.stringify({ type: "pong" })]);
    expect(events).toEqual([]);
    sock.emit({ type: "agent:status", agentName: "a" });
    expect(events).toEqual([{ type: "agent:status", agentName: "a" }]);
  });

  it("断开后指数退避重连（100→200→400 封顶），重连成功 onConnect(true)", () => {
    const { mgr, connects, statuses } = setup({});
    mgr.start();
    FakeSocket.instances[0].open();
    FakeSocket.instances[0].close();
    expect(statuses.at(-1)).toEqual(["reconnecting", 1]);

    vi.advanceTimersByTime(100); // 第一次重连触发
    expect(FakeSocket.instances.length).toBe(2);
    FakeSocket.instances[1].open();
    expect(connects).toEqual([false, true]);

    // 再断：退避从 100 重来（onopen 已重置），再断一次观察翻倍
    FakeSocket.instances[1].close();
    vi.advanceTimersByTime(100);
    expect(FakeSocket.instances.length).toBe(3); // 100ms 后第 3 条
    FakeSocket.instances[2].close(); // 未 open 直接关
    vi.advanceTimersByTime(199);
    expect(FakeSocket.instances.length).toBe(3); // 翻倍到 200ms，199 时不该连
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances.length).toBe(4);
  });

  it("看门狗：入站静默超过 watchdogMs → 主动 close 触发重连；任何入站（含 ping）都重置", () => {
    const { mgr } = setup({});
    mgr.start();
    const sock = FakeSocket.instances[0];
    sock.open();
    vi.advanceTimersByTime(999);
    sock.emit({ type: "ping" }); // 重置看门狗
    vi.advanceTimersByTime(999);
    expect(sock.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sock.closed).toBe(true); // 静默满 1000ms 被踢
    expect(FakeSocket.instances.length).toBe(1); // 重连定时器已排，尚未触发
  });

  it("send 仅在 OPEN 时发送，断开期间静默丢弃", () => {
    const { mgr } = setup({});
    mgr.start();
    const sock = FakeSocket.instances[0];
    mgr.send({ type: "noop" }); // CONNECTING 状态
    expect(sock.sent).toEqual([]);
    sock.open();
    mgr.send({ type: "terminal:watch", agentName: "a" });
    expect(sock.sent).toEqual([JSON.stringify({ type: "terminal:watch", agentName: "a" })]);
  });

  it("stop 后不再重连，状态 disconnected", () => {
    const { mgr, statuses } = setup({});
    mgr.start();
    const sock = FakeSocket.instances[0];
    sock.open();
    mgr.stop();
    expect(sock.closed).toBe(true);
    vi.advanceTimersByTime(10000);
    expect(FakeSocket.instances.length).toBe(1);
    expect(statuses.at(-1)).toEqual(["disconnected", 0]);
  });

  it("start 幂等：重复 start 不产生第二条连接", () => {
    const { mgr } = setup({});
    mgr.start();
    mgr.start();
    expect(FakeSocket.instances.length).toBe(1);
  });
});
