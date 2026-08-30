import { afterEach, describe, expect, it, vi } from "vitest";
import type { PubSub } from "../src/lib/pubsub.js";
import { broadcast, setPubSub, setWsPg } from "../src/ws/handler.js";

// P0.2 回归（docs/2026-08-28/01-server-evaluation-report.md）：
// broadcast() 在频道类型/成员解析失败时必须 fail-closed（丢弃事件），
// 而不是退回全发——否则 DB 抖动窗口内私有频道/DM 的明文事件会广播给全部浏览器。
// 纯单元测试：fake wsPg + fake PubSub，可离线跑。

interface FakePg {
  channels: Map<string, { type: string }>;
  /** channelId -> human 成员 id 列表 */
  members: Map<string, string[]>;
  failChannels?: boolean;
  failMembers?: boolean;
}

function makeFakePg(f: FakePg) {
  return {
    query: async (text: string, params: unknown[]) => {
      if (/FROM channels WHERE id/.test(text)) {
        if (f.failChannels) throw new Error("db jitter");
        const row = f.channels.get(String(params[0]));
        return { rows: row ? [row] : [] };
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
  event: unknown;
};

function makeFakePubSub() {
  const published: ChannelEnvelope[] = [];
  const pubsub: PubSub = {
    publish: (_channel, payload) => published.push(payload as ChannelEnvelope),
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
    expect(published[0]).toMatchObject({
      kind: "channel",
      channelId: "ch-pub",
      allowedHumanIds: null,
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
    expect(published[0]).toMatchObject({
      kind: "channel",
      channelId: "ch-priv",
      allowedHumanIds: ["user-a", "user-b"],
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
    expect(published[0]).toMatchObject({
      kind: "channel",
      channelId: "ch-dm",
      allowedHumanIds: ["user-a"],
    });
  });
});
