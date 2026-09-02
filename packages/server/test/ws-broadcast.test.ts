import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { PubSub } from "../src/lib/pubsub.js";
import {
  broadcast,
  broadcastToDaemons,
  deliver,
  sendToDaemon,
  sendToUser,
  setPubSub,
  setWsPg,
} from "../src/ws/handler.js";

// P0.2 回归（docs/2026-08-28/01-server-evaluation-report.md）：
// broadcast() 在频道类型/成员解析失败时必须 fail-closed（丢弃事件），
// 而不是退回全发——否则 DB 抖动窗口内私有频道/DM 的明文事件会广播给全部浏览器。
// P1.22 回归：① 私有频道/DM 的 daemon 侧收敛（信封带 allowedDaemonUserIds，
// 按 agent 成员归属用户定向）；② pubsub 按事件形态/userId 分频道；③ deliver 背压。
// 纯单元测试：fake wsPg + fake PubSub，可离线跑。

interface FakePg {
  channels: Map<string, { type: string }>;
  /** channelId -> human 成员 id 列表 */
  members: Map<string, string[]>;
  /** channelId -> agent 成员归属的 user_id 列表 */
  agentOwners?: Map<string, string[]>;
  failChannels?: boolean;
  failMembers?: boolean;
  failAgentOwners?: boolean;
}

function makeFakePg(f: FakePg) {
  return {
    query: async (text: string, params: unknown[]) => {
      if (/FROM channels WHERE id/.test(text)) {
        if (f.failChannels) throw new Error("db jitter");
        const row = f.channels.get(String(params[0]));
        return { rows: row ? [row] : [] };
      }
      // P1.22：daemon 定向查询（channel_members cm JOIN agents a）先于人类成员查询匹配
      if (/JOIN agents/.test(text)) {
        if (f.failAgentOwners) throw new Error("db jitter");
        const owners = f.agentOwners?.get(String(params[0])) ?? [];
        return { rows: owners.map((user_id) => ({ user_id })) };
      }
      if (/FROM channel_members/.test(text)) {
        if (f.failMembers) throw new Error("db jitter");
        const ids = f.members.get(String(params[0])) ?? [];
        return { rows: ids.map((id) => ({ member_id: id })) };
      }
      throw new Error(`unexpected sql: ${text}`);
    },
  };
}

type ChannelEnvelope = {
  kind: "channel";
  channelId: string;
  allowedHumanIds: string[] | null;
  allowedDaemonUserIds: string[] | null;
  event: unknown;
};

function makeFakePubSub() {
  const published: { channel: string; envelope: ChannelEnvelope }[] = [];
  const pubsub: PubSub = {
    publish: (channel, payload) => published.push({ channel, envelope: payload as ChannelEnvelope }),
    subscribe: () => () => {},
    close: async () => {},
  };
  return { published, pubsub };
}

// message:delete 是 WsChannelBroadcast 允许的最小事件形状（见 messages.ts 删除路径）
const evt = { type: "message:delete", message: { id: "m-1" } } as const;

afterEach(() => {
  vi.restoreAllMocks();
  // 摘掉 fake 依赖，避免跨用例污染（每个用例自带注入）
  setWsPg(null);
});

describe("ws broadcast: fail-closed on channel resolve failure (P0.2)", () => {
  it("drops the event when the channel type query fails (DB jitter)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { published, pubsub } = makeFakePubSub();
    setPubSub(pubsub);
    setWsPg(makeFakePg({ channels: new Map(), members: new Map(), failChannels: true }));

    await broadcast("11111111-1111-4111-8111-111111111111", evt);

    expect(published).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/fail-closed/));
  });

  it("drops the event when the member query fails after type=private resolved", async () => {
    // 关键半途失败场景：类型已判定 private，成员查询抖动——绝不允许退回全发
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { published, pubsub } = makeFakePubSub();
    setPubSub(pubsub);
    setWsPg(
      makeFakePg({
        channels: new Map([["ch-priv", { type: "private" }]]),
        members: new Map(),
        failMembers: true,
      }),
    );

    await broadcast("ch-priv", evt);

    expect(published).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/fail-closed/));
  });

  it("drops the event when the channel does not exist (unknown type)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { published, pubsub } = makeFakePubSub();
    setPubSub(pubsub);
    setWsPg(makeFakePg({ channels: new Map(), members: new Map() }));

    await broadcast("ch-missing", evt);

    expect(published).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/fail-closed/));
  });

  it("drops the event when wsPg is not injected or channelId is empty", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { published, pubsub } = makeFakePubSub();
    setPubSub(pubsub);
    setWsPg(null); // 无法解析类型 → 不可当作公开频道处理

    await broadcast("ch-any", evt);
    expect(published).toHaveLength(0);

    setWsPg(makeFakePg({ channels: new Map([["ch-pub", { type: "public" }]]), members: new Map() }));
    await broadcast("", evt); // 空 channelId 同样 fail-closed
    expect(published).toHaveLength(0);

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("drops the event for unknown channel type values", async () => {
    // type 列暂无 CHECK 约束（P1.32）：未知值按解析失败处理，不当作公开
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { published, pubsub } = makeFakePubSub();
    setPubSub(pubsub);
    setWsPg(makeFakePg({ channels: new Map([["ch-x", { type: "announcement" }]]), members: new Map() }));

    await broadcast("ch-x", evt);

    expect(published).toHaveLength(0);
  });
});

describe("ws broadcast: normal delivery unchanged", () => {
  it("public channel publishes with allowedHumanIds = null (unrestricted)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { published, pubsub } = makeFakePubSub();
    setPubSub(pubsub);
    setWsPg(makeFakePg({ channels: new Map([["ch-pub", { type: "public" }]]), members: new Map() }));

    await broadcast("ch-pub", evt);

    expect(published).toHaveLength(1);
    expect(published[0].channel).toBe("slock:ws:v1:channel");
    expect(published[0].envelope).toMatchObject({
      kind: "channel",
      channelId: "ch-pub",
      allowedHumanIds: null,
      allowedDaemonUserIds: null, // 公开频道 daemon 不定向（@提及自动入圈依赖广播面）
      event: evt,
    });
  });

  it("private channel publishes restricted to its human members", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { published, pubsub } = makeFakePubSub();
    setPubSub(pubsub);
    setWsPg(
      makeFakePg({
        channels: new Map([["ch-priv", { type: "private" }]]),
        members: new Map([["ch-priv", ["user-a", "user-b"]]]),
      }),
    );

    await broadcast("ch-priv", evt);

    expect(published).toHaveLength(1);
    expect(published[0].envelope).toMatchObject({
      kind: "channel",
      channelId: "ch-priv",
      allowedHumanIds: ["user-a", "user-b"],
      allowedDaemonUserIds: [], // 无 agent 成员 → 不投任何 daemon
    });
  });

  it("dm channel publishes restricted to participants", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { published, pubsub } = makeFakePubSub();
    setPubSub(pubsub);
    setWsPg(
      makeFakePg({
        channels: new Map([["ch-dm", { type: "dm" }]]),
        members: new Map([["ch-dm", ["user-a"]]]),
      }),
    );

    await broadcast("ch-dm", evt);

    expect(published).toHaveLength(1);
    expect(published[0].envelope).toMatchObject({
      kind: "channel",
      channelId: "ch-dm",
      allowedHumanIds: ["user-a"],
      allowedDaemonUserIds: [],
    });
  });
});

describe("ws broadcast: daemon targeting by agent membership (P1.22)", () => {
  it("private channel resolves agent-member owners into allowedDaemonUserIds", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { published, pubsub } = makeFakePubSub();
    setPubSub(pubsub);
    setWsPg(
      makeFakePg({
        channels: new Map([["ch-priv", { type: "private" }]]),
        members: new Map([["ch-priv", ["user-a"]]]),
        agentOwners: new Map([["ch-priv", ["owner-1", "owner-2"]]]),
      }),
    );

    await broadcast("ch-priv", evt);

    expect(published).toHaveLength(1);
    expect(published[0].envelope).toMatchObject({
      kind: "channel",
      channelId: "ch-priv",
      allowedHumanIds: ["user-a"],
      allowedDaemonUserIds: ["owner-1", "owner-2"],
    });
  });

  it("dm channel resolves agent participants' owners", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { published, pubsub } = makeFakePubSub();
    setPubSub(pubsub);
    setWsPg(
      makeFakePg({
        channels: new Map([["ch-dm", { type: "dm" }]]),
        members: new Map([["ch-dm", ["user-a"]]]),
        agentOwners: new Map([["ch-dm", ["owner-dm"]]]),
      }),
    );

    await broadcast("ch-dm", evt);

    expect(published).toHaveLength(1);
    expect(published[0].envelope).toMatchObject({
      allowedHumanIds: ["user-a"],
      allowedDaemonUserIds: ["owner-dm"],
    });
  });

  it("drops the whole event when the agent-owner query fails (fail-closed, daemon never falls back to full send)", async () => {
    // daemon 维度绝不退回全发：agent 成员归属解析失败 = 整个事件丢弃（可经 REST 补拉）
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { published, pubsub } = makeFakePubSub();
    setPubSub(pubsub);
    setWsPg(
      makeFakePg({
        channels: new Map([["ch-priv", { type: "private" }]]),
        members: new Map([["ch-priv", ["user-a"]]]),
        failAgentOwners: true,
      }),
    );

    await broadcast("ch-priv", evt);

    expect(published).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/fail-closed/));
  });
});

describe("pubsub channel routing by envelope kind (P1.22)", () => {
  it("routes user/daemon envelopes to the per-user channel, channel/all-daemons to global channels", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { published, pubsub } = makeFakePubSub();
    setPubSub(pubsub);
    setWsPg(makeFakePg({ channels: new Map([["ch-pub", { type: "public" }]]), members: new Map() }));

    sendToUser("u-1", { type: "agent:status", agentId: "a", agentName: "n", status: "s", detail: "d" });
    sendToDaemon("u-1", { type: "agent:stop", agentId: "a" });
    broadcastToDaemons({ type: "x" });
    await broadcast("ch-pub", evt);

    expect(published.map((p) => p.channel)).toEqual([
      "slock:ws:v1:u:u-1", // user → 定向频道
      "slock:ws:v1:u:u-1", // daemon → 同一用户定向频道
      "slock:ws:v1:all", // all-daemons → 全局
      "slock:ws:v1:channel", // 频道广播 → 全局广播面
    ]);
  });

  it("setPubSub subscribes both global channels up front", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const subscribed: string[] = [];
    const pubsub: PubSub = {
      publish: () => {},
      subscribe: (channel) => {
        subscribed.push(channel);
        return () => {};
      },
      close: async () => {},
    };
    setPubSub(pubsub);
    expect(subscribed).toEqual(expect.arrayContaining(["slock:ws:v1:channel", "slock:ws:v1:all"]));
  });
});

describe("deliver backpressure (P1.22)", () => {
  function fakeWs(bufferedAmount: number): WebSocket & { sent: string[]; terminated: boolean } {
    const ws = {
      bufferedAmount,
      sent: [] as string[],
      terminated: false,
      send(payload: string) {
        ws.sent.push(payload);
      },
      terminate() {
        ws.terminated = true;
      },
    };
    return ws as unknown as WebSocket & { sent: string[]; terminated: boolean };
  }

  it("sends normally when bufferedAmount is under the threshold", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ws = fakeWs(1024);
    deliver([ws], "hello");
    expect(ws.sent).toEqual(["hello"]);
    expect(ws.terminated).toBe(false);
  });

  it("terminates a slow consumer instead of queueing into an unbounded buffer", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ws = fakeWs(64 * 1024 * 1024); // 远超 4MB 阈值
    deliver([ws], "hello");
    expect(ws.sent).toHaveLength(0);
    expect(ws.terminated).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/slow consumer/));
  });

  it("keeps delivering to other sockets when one is over the threshold", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const slow = fakeWs(64 * 1024 * 1024);
    const healthy = fakeWs(0);
    deliver([slow, healthy], "hello");
    expect(slow.terminated).toBe(true);
    expect(healthy.sent).toEqual(["hello"]);
  });
});
