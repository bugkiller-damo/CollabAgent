import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createObservationBus } from "../src/agent-observation.js";
import { DaemonCore } from "../src/daemon-core.js";

/**
 * P0.8：daemon-core WS 消息路由单测。
 *
 * 不起真实 WebSocket / 不 spawn 进程：直接调私有 handleMessage（运行时换假），
 * sendWs 换成数组捕获，断言「入信 → runtime 调用 / 出站消息」的路由逻辑。
 * 覆盖 handleMessage 的全部 case：agent:start / agent:deliver（force/DM/mention/
 * triage/防自环）/ agent:stop / agent:duty / reminder.fire / terminal:* /
 * workspace:read / ping。
 */

const AGENT = "zz_dc_agent";
const AGENT_ID = "dddddddd-4444-4444-4444-444444444444";
const MGR = "zz_dc_manager";

interface FakeRuntime {
  [key: string]: ReturnType<typeof vi.fn>;
}

const makeFakeRuntime = (obsBus: ReturnType<typeof createObservationBus>): FakeRuntime => {
  const fakeManager = { getRun: vi.fn(() => undefined), resizeRun: vi.fn() };
  return {
    registerAgent: vi.fn(),
    unregisterAgent: vi.fn(),
    resolveAgentName: vi.fn((id: string) => (id === AGENT_ID ? AGENT : null)),
    resolveAgentId: vi.fn((name: string) => (name === AGENT ? AGENT_ID : null)),
    hasAgent: vi.fn((name: string) => name === AGENT || name === MGR),
    getAgentInfo: vi.fn(() => ({ displayName: "DC Agent" })),
    runAgent: vi.fn(async () => {}),
    runAgentDm: vi.fn(async () => {}),
    runAgentReminder: vi.fn(async () => {}),
    runAgentTriage: vi.fn(async () => {}),
    findMentionedAgent: vi.fn(() => null),
    setPreferredTermSize: vi.fn(),
    getAgentState: vi.fn(() => "idle"),
    listAgentNames: vi.fn(() => [AGENT]),
    __getRunId: vi.fn(() => null),
    __getAgentManager: vi.fn(() => fakeManager),
    __getObservationBus: vi.fn(() => obsBus),
  };
};

describe("daemon-core 消息路由", () => {
  let core: DaemonCore;
  let runtime: FakeRuntime;
  let sent: Array<Record<string, unknown>>;
  let obsBus: ReturnType<typeof createObservationBus>;

  const call = (msg: Record<string, unknown>): Promise<void> =>
    (core as unknown as { handleMessage(m: unknown): Promise<void> }).handleMessage(msg);

  beforeEach(() => {
    delete process.env.SLOCK_USE_PTY;
    obsBus = createObservationBus();
    // 真实构造（headless 懒加载，无 node-pty / 无 spawn），随后换掉 runtime 与 sendWs
    core = new DaemonCore({ serverUrl: "http://fake-server.test", apiKey: "test-key" });
    runtime = makeFakeRuntime(obsBus);
    sent = [];
    Object.assign(core as unknown as Record<string, unknown>, {
      runtime,
      sendWs: (ev: unknown) => sent.push(ev as Record<string, unknown>),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("agent:start", () => {
    it("agent 变体：id/name/model 直取", async () => {
      await call({
        type: "agent:start",
        agent: { id: AGENT_ID, name: AGENT, displayName: "D", description: "d", model: "sonnet" },
      });
      expect(runtime.registerAgent).toHaveBeenCalledWith(AGENT_ID, AGENT, {
        displayName: "D",
        description: "d",
        model: "sonnet",
      });
    });

    it("config 变体：model 从 runtime_profile 兜底", async () => {
      await call({ type: "agent:start", config: { name: AGENT, runtime_profile: { model: "haiku" } } });
      expect(runtime.registerAgent).toHaveBeenCalledWith("", AGENT, {
        displayName: AGENT,
        description: "",
        model: "haiku",
      });
    });

    it("无名消息被忽略", async () => {
      await call({ type: "agent:start", agent: { id: AGENT_ID } });
      expect(runtime.registerAgent).not.toHaveBeenCalled();
    });
  });

  describe("agent:deliver", () => {
    it("forceDeliverTo 直路由：replyTarget 线程格式 + 消息 id 透传", async () => {
      await call({
        type: "agent:deliver",
        message: {
          content: "派发任务",
          forceDeliverTo: AGENT,
          channelId: "#ops",
          threadId: "abcdef1234567890",
          senderName: "boss",
          id: "msg-1",
        },
      });
      expect(runtime.runAgent).toHaveBeenCalledWith(
        AGENT,
        "ops",
        "#ops:abcdef12",
        "boss",
        "派发任务",
        "abcdef1234567890",
        "msg-1",
      );
    });

    it("forceDeliverTo 目标不在本机 → 不路由", async () => {
      await call({ type: "agent:deliver", message: { content: "x", forceDeliverTo: "ghost", channelId: "#ops" } });
      expect(runtime.runAgent).not.toHaveBeenCalled();
    });

    it("senderType=agent 且无 force → 防自环拦截", async () => {
      await call({
        type: "agent:deliver",
        message: { content: "@zz_dc_agent hi", senderType: "agent", channelId: "#ops" },
      });
      expect(runtime.runAgent).not.toHaveBeenCalled();
      expect(runtime.runAgentTriage).not.toHaveBeenCalled();
    });

    it("🤖 前缀内容被忽略", async () => {
      await call({ type: "agent:deliver", message: { content: "🤖 自动消息", channelId: "#ops" } });
      expect(runtime.runAgent).not.toHaveBeenCalled();
    });

    it("DM：只派发给本机托管的接收者，replyTarget=dm:@发送者", async () => {
      await call({
        type: "agent:deliver",
        message: { content: "在吗", dm: true, dmAgentRecipients: [AGENT, "ghost"], senderHandle: "bob" },
      });
      expect(runtime.runAgentDm).toHaveBeenCalledTimes(1);
      expect(runtime.runAgentDm).toHaveBeenCalledWith(AGENT, "dm:@bob", "bob", "在吗");
    });

    it("mentionAgents 白名单：只 spawn 列表内且本机托管的 agent", async () => {
      await call({
        type: "agent:deliver",
        message: { content: "hi", mentionAgents: ["ghost", AGENT], channelId: "#general", senderName: "bob", id: "m2" },
      });
      expect(runtime.runAgent).toHaveBeenCalledWith(AGENT, "general", "#general", "bob", "hi", undefined, "m2");
      // 白名单路径不走本地文本解析
      expect(runtime.findMentionedAgent).not.toHaveBeenCalled();
    });

    it("mentionAgents 空数组：不回落文本解析，直接进 triage", async () => {
      await call({
        type: "agent:deliver",
        message: {
          content: "@zz_dc_agent 但没在白名单",
          mentionAgents: [],
          channelId: "#general",
          triageAgents: ["ghost", MGR],
        },
      });
      expect(runtime.runAgent).not.toHaveBeenCalled();
      expect(runtime.findMentionedAgent).not.toHaveBeenCalled();
      // T8：挑本机托管的经理（ghost 不在本机，跳过）
      expect(runtime.runAgentTriage).toHaveBeenCalledTimes(1);
      expect(runtime.runAgentTriage.mock.calls[0][0]).toBe(MGR);
    });

    it("无 mentionAgents 字段（旧 server）：回落本地 findMentionedAgent", async () => {
      runtime.findMentionedAgent.mockReturnValue(AGENT);
      await call({ type: "agent:deliver", message: { content: "hi", channelId: "#general", senderName: "bob" } });
      expect(runtime.findMentionedAgent).toHaveBeenCalledWith("hi");
      expect(runtime.runAgent).toHaveBeenCalledTimes(1);
    });

    it("线程消息：replyTarget 带 :threadId前8位", async () => {
      await call({
        type: "agent:deliver",
        message: {
          content: "hi",
          mentionAgents: [AGENT],
          channelId: "#general",
          thread_id: "tttt8888ffff",
          senderName: "bob",
        },
      });
      expect(runtime.runAgent).toHaveBeenCalledWith(
        AGENT,
        "general",
        "#general:tttt8888",
        "bob",
        "hi",
        "tttt8888ffff",
        undefined,
      );
    });
  });

  describe("agent:stop / agent:duty / reminder.fire", () => {
    it("agent:stop：id 反查注册名后 unregister", async () => {
      await call({ type: "agent:stop", agentId: AGENT_ID });
      expect(runtime.unregisterAgent).toHaveBeenCalledWith(AGENT);
    });

    it("agent:stop 未知 id：不动", async () => {
      await call({ type: "agent:stop", agentId: "eeeeeeee-5555-5555-5555-555555555555" });
      expect(runtime.unregisterAgent).not.toHaveBeenCalled();
    });

    it("agent:duty off → unregister；on → 带既有 info 重注册", async () => {
      await call({ type: "agent:duty", name: AGENT, duty: "off" });
      expect(runtime.unregisterAgent).toHaveBeenCalledWith(AGENT);

      await call({ type: "agent:duty", name: AGENT, agentId: AGENT_ID, duty: "on" });
      expect(runtime.registerAgent).toHaveBeenCalledWith(AGENT_ID, AGENT, { displayName: "DC Agent" });
    });

    it("reminder.fire：id 反查到本机 agent 才触发", async () => {
      await call({
        type: "reminder.fire",
        agentId: AGENT_ID,
        reminder: { title: "巡检", kind: "patrol", channel: "#ops" },
      });
      expect(runtime.runAgentReminder).toHaveBeenCalledWith(AGENT, { title: "巡检", kind: "patrol", channel: "#ops" });

      runtime.runAgentReminder.mockClear();
      await call({ type: "reminder.fire", agentId: "eeeeeeee-5555-5555-5555-555555555555", reminder: { title: "x" } });
      expect(runtime.runAgentReminder).not.toHaveBeenCalled();
    });
  });

  describe("terminal:*", () => {
    it("watch 推帧（观察帧 transcript 作 screen）→ unwatch 停推并退订", async () => {
      vi.useFakeTimers();
      try {
        await call({ type: "terminal:watch", agentName: AGENT });
        // 立即一帧：无 run 无观察帧 → offline
        const first = sent.filter((m) => m.type === "terminal:frame");
        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({ agentName: AGENT, status: "offline" });

        // 观看期间观察帧原样转发
        obsBus.publish({
          agentName: AGENT,
          seq: 1,
          kind: "text",
          turnId: null,
          payload: { text: "agent 说话了" },
          timestamp: Date.now(),
        } as any);
        expect(sent.some((m) => m.type === "terminal:obs-frame")).toBe(true);

        // 下一拍：headless 用 transcript 作 screen，状态取状态机
        vi.advanceTimersByTime(400);
        const frames = sent.filter((m) => m.type === "terminal:frame");
        expect(frames.length).toBeGreaterThanOrEqual(2);
        expect(frames[frames.length - 1]).toMatchObject({ agentName: AGENT, status: "idle" });
        expect(String(frames[frames.length - 1]!.screen)).toContain("agent 说话了");

        await call({ type: "terminal:unwatch", agentName: AGENT });
        const countAfterUnwatch = sent.length;
        vi.advanceTimersByTime(1200);
        obsBus.publish({
          agentName: AGENT,
          seq: 2,
          kind: "text",
          turnId: null,
          payload: { text: "又一句" },
          timestamp: Date.now(),
        } as any);
        vi.advanceTimersByTime(1200);
        expect(sent.length).toBe(countAfterUnwatch); // 不再推任何帧
      } finally {
        await call({ type: "terminal:unwatch", agentName: AGENT }); // 兜底清定时器
      }
    });

    it("重复 watch 不叠加定时器", async () => {
      vi.useFakeTimers();
      try {
        await call({ type: "terminal:watch", agentName: AGENT });
        await call({ type: "terminal:watch", agentName: AGENT });
        vi.advanceTimersByTime(400);
        const frames = sent.filter((m) => m.type === "terminal:frame" && m.status === "offline");
        expect(frames).toHaveLength(1); // 只有首次 watch 的 immediate tick
      } finally {
        await call({ type: "terminal:unwatch", agentName: AGENT });
      }
    });

    it("resize：钳制到 [20,400]x[5,100]，记偏好；无 run 不调 resizeRun", async () => {
      await call({ type: "terminal:resize", agentName: AGENT, cols: 1000, rows: 2 });
      expect(runtime.setPreferredTermSize).toHaveBeenCalledWith(AGENT, { cols: 400, rows: 5 });
      expect(runtime.__getAgentManager().resizeRun).not.toHaveBeenCalled();
    });

    it("resize：有 run 时实时 resize", async () => {
      runtime.__getRunId.mockReturnValue("run-1");
      await call({ type: "terminal:resize", agentName: AGENT, cols: 120, rows: 40 });
      expect(runtime.__getAgentManager().resizeRun).toHaveBeenCalledWith("run-1", 120, 40);
    });

    it("terminal:history：回传落盘日志尾部", async () => {
      await call({ type: "terminal:history", agentName: "nonexistent-agent" });
      const m = sent.find((x) => x.type === "terminal:history");
      expect(m).toMatchObject({ agentName: "nonexistent-agent" });
      expect(typeof m!.text).toBe("string");
    });
  });

  describe("workspace:read / ping", () => {
    it("读文件：不存在回 exists:false", async () => {
      await call({ type: "workspace:read", requestId: "r1", agentName: "nonexistent-agent", path: "MEMORY.md" });
      const m = sent.find((x) => x.type === "workspace:result");
      expect(m).toMatchObject({ requestId: "r1", agentName: "nonexistent-agent", exists: false, path: "MEMORY.md" });
    });

    it("无 path：列目录", async () => {
      await call({ type: "workspace:read", requestId: "r2", agentName: "nonexistent-agent" });
      const m = sent.find((x) => x.type === "workspace:result");
      expect(m).toMatchObject({ requestId: "r2", exists: false });
      expect(Array.isArray(m!.files)).toBe(true);
    });

    it("ping → pong", async () => {
      await call({ type: "ping" });
      expect(sent).toContainEqual({ type: "pong" });
    });
  });
});
