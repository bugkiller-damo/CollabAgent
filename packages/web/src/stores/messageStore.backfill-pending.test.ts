import type { Message } from "@collabagent/shared";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

// mock api 层：fetchHistory/backfill 走 apiGet，发送走 apiPost（共享契约见任务说明）
vi.mock("../api", () => ({
  apiClient: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

import { apiGet, apiPost } from "../api";
import { useMessageStore } from "./messageStore";

const apiGetMock = vi.mocked(apiGet);
const apiPostMock = vi.mocked(apiPost);

// ---- harness：对齐 messageStore.sync.test.ts 的 localStorage stub 风格 ----
let lsData: Map<string, string>;

function stubLocalStorage() {
  lsData = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => lsData.get(k) ?? null,
    setItem: (k: string, v: string) => void lsData.set(k, String(v)),
    removeItem: (k: string) => void lsData.delete(k),
    clear: () => lsData.clear(),
    key: () => null,
    get length() {
      return lsData.size;
    },
  } as Storage;
}

function msg(target: string, seq: number, id = `m-${target}-${seq}`): Message {
  return {
    id,
    seq,
    channelId: target,
    senderId: "u-1",
    senderName: "Alice",
    senderType: "human",
    content: `hello ${seq}`,
    time: new Date().toISOString(),
  } as Message;
}

function pendingStorage(): Record<string, { nonce: string; status: string }[]> {
  return JSON.parse(lsData.get("pending_msgs_v1") || "{}");
}

beforeEach(() => {
  stubLocalStorage();
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe("backfill 断线增量补拉", () => {
  it("单页补齐：按 seq 排序、按 id 去重、推进 lastSeenSeq", async () => {
    const store = useMessageStore();
    store.receiveMessage(msg("#a", 1));
    store.receiveMessage(msg("#a", 3)); // lastSeenSeq = 3
    // 服务端按升序返回，这里故意给乱序 + 一条已存在的重复 id
    apiGetMock.mockResolvedValueOnce({
      messages: [msg("#a", 5), msg("#a", 4), msg("#a", 3)],
      hasMore: false,
    } as any);

    await store.backfillTarget("#a");

    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(apiGetMock).toHaveBeenCalledWith("/api/messages/history", {
      channel: "#a",
      after: "3",
      limit: "200",
    });
    const list = store.messagesByTarget["#a"];
    expect(list.map((m) => m.seq)).toEqual([1, 3, 4, 5]); // 升序且 m-#a-3 未重复入列
    expect(store.lastSeenSeq["#a"]).toBe(5);
  });

  it("多页 hasMore 循环：after 游标随页推进，hasMore=false 即止", async () => {
    const store = useMessageStore();
    apiGetMock.mockImplementation(async (url: string, params?: Record<string, string>) => {
      expect(url).toBe("/api/messages/history");
      const after = Number(params?.after || 0);
      if (after === 0) return { messages: [msg("#a", 1), msg("#a", 2)], hasMore: true } as any;
      if (after === 2) return { messages: [msg("#a", 3), msg("#a", 4)], hasMore: true } as any;
      if (after === 4) return { messages: [msg("#a", 5)], hasMore: false } as any;
      throw new Error(`unexpected after=${after}`);
    });

    await store.backfillTarget("#a");

    expect(apiGetMock).toHaveBeenCalledTimes(3);
    expect(store.messagesByTarget["#a"].map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(store.lastSeenSeq["#a"]).toBe(5);
  });

  it("空页即止，不继续翻页", async () => {
    const store = useMessageStore();
    apiGetMock.mockResolvedValueOnce({ messages: [], hasMore: true } as any);

    await store.backfillTarget("#a");

    expect(apiGetMock).toHaveBeenCalledTimes(1);
  });

  it("失败静默：不抛出、不推进 lastSeenSeq、保留 live-only", async () => {
    const store = useMessageStore();
    store.receiveMessage(msg("#a", 7));
    apiGetMock.mockRejectedValueOnce(new Error("network down"));

    await expect(store.backfillTarget("#a")).resolves.toBeUndefined();

    expect(store.lastSeenSeq["#a"]).toBe(7);
    expect(store.messagesByTarget["#a"].map((m) => m.seq)).toEqual([7]);
  });

  it("in-flight 护栏：重入只发一次请求", async () => {
    const store = useMessageStore();
    let release!: (v: unknown) => void;
    apiGetMock.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));

    const p1 = store.backfillTarget("#a");
    const p2 = store.backfillTarget("#a"); // 重入直接返回
    release({ messages: [msg("#a", 1)], hasMore: false });
    await Promise.all([p1, p2]);

    expect(apiGetMock).toHaveBeenCalledTimes(1);
    // 护栏已释放，下一轮可正常补拉
    apiGetMock.mockResolvedValueOnce({ messages: [], hasMore: false } as any);
    await store.backfillTarget("#a");
    expect(apiGetMock).toHaveBeenCalledTimes(2);
  });

  it("fetchHistory 推进 lastSeenSeq；before 翻旧页不回退", async () => {
    const store = useMessageStore();
    apiGetMock.mockImplementation(async (url: string, params?: Record<string, string>) => {
      expect(url).toBe("/api/messages");
      if (params?.before) return { messages: [msg("#a", 4), msg("#a", 5)] } as any;
      return { messages: [msg("#a", 9), msg("#a", 10)] } as any;
    });

    await store.fetchHistory("#a");
    expect(store.lastSeenSeq["#a"]).toBe(10);

    await store.fetchHistory("#a", { before: 6, limit: 50 });
    expect(store.lastSeenSeq["#a"]).toBe(10); // 旧页 max=5，不回退
  });

  it("backfillAll 对全部 target 补拉（worker-pool 并发）", async () => {
    const store = useMessageStore();
    store.receiveMessage(msg("#a", 1));
    store.receiveMessage(msg("#b", 2));
    apiGetMock.mockImplementation(async (_url: string, params?: Record<string, string>) => {
      const seq = params?.channel === "#a" ? 2 : 3;
      return { messages: [msg(params?.channel || "", seq)], hasMore: false } as any;
    });

    await store.backfillAll();

    expect(apiGetMock).toHaveBeenCalledTimes(2);
    expect(store.messagesByTarget["#a"].map((m) => m.seq)).toEqual([1, 2]);
    expect(store.messagesByTarget["#b"].map((m) => m.seq)).toEqual([2, 3]);
  });
});

describe("pending 乐观发送队列", () => {
  it("enqueue 生成 tempId/nonce 并持久化 queued", () => {
    const store = useMessageStore();
    const item = store.enqueuePending("#a", "hi");

    expect(item.tempId).toMatch(/^tmp-\d+-[a-z0-9]{4}$/);
    expect(item.nonce).toMatch(/^n-[a-z0-9]{24}$/);
    expect(store.pendingByTarget["#a"]).toHaveLength(1);
    expect(pendingStorage()["#a"][0]).toMatchObject({ nonce: item.nonce, status: "queued" });
  });

  it("flush 成功：apiPost 带 clientNonce，移除队列并清空持久化", async () => {
    const store = useMessageStore();
    const item = store.enqueuePending("#a", "hello");
    apiPostMock.mockResolvedValueOnce({ state: "ok", messageId: "m1", messageSeq: 1 } as any);

    await store.flushPending("#a");

    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock.mock.calls[0][0]).toBe("/api/messages/send");
    expect(apiPostMock.mock.calls[0][1]).toMatchObject({
      target: "#a",
      content: "hello",
      clientNonce: item.nonce,
    });
    expect(store.pendingByTarget["#a"]).toBeUndefined();
    expect(pendingStorage()).toEqual({}); // 成功后持久化清空
  });

  it("flush 串行：多条 queued 按序发送", async () => {
    const store = useMessageStore();
    const i1 = store.enqueuePending("#a", "one");
    const i2 = store.enqueuePending("#a", "two");
    apiPostMock.mockResolvedValue({ state: "ok" } as any);

    await store.flushPending("#a");

    expect(apiPostMock).toHaveBeenCalledTimes(2);
    expect(apiPostMock.mock.calls[0][1]).toMatchObject({ clientNonce: i1.nonce });
    expect(apiPostMock.mock.calls[1][1]).toMatchObject({ clientNonce: i2.nonce });
    expect(store.pendingByTarget["#a"]).toBeUndefined();
  });

  it("flush 失败：标 failed 并中断本轮，持久化为 failed", async () => {
    const store = useMessageStore();
    store.enqueuePending("#a", "one");
    store.enqueuePending("#a", "two");
    apiPostMock.mockRejectedValueOnce(new Error("boom"));

    await store.flushPending("#a");

    const list = store.pendingByTarget["#a"];
    expect(list.map((p) => p.status)).toEqual(["failed", "queued"]); // 失败后剩余保持 queued
    expect(pendingStorage()["#a"].map((p) => p.status)).toEqual(["failed", "queued"]);
  });

  it("retry 沿用同一 nonce 重发，成功后移除", async () => {
    const store = useMessageStore();
    const item = store.enqueuePending("#a", "again");
    apiPostMock.mockRejectedValueOnce(new Error("boom"));
    await store.flushPending("#a");
    expect(store.pendingByTarget["#a"][0].status).toBe("failed");

    apiPostMock.mockResolvedValueOnce({ state: "ok", deduplicated: true } as any);
    await store.retryPending("#a", item.tempId);

    expect(apiPostMock).toHaveBeenCalledTimes(2);
    expect(apiPostMock.mock.calls[1][1]).toMatchObject({ clientNonce: item.nonce }); // 同一 nonce
    expect(store.pendingByTarget["#a"]).toBeUndefined();
  });

  it("discard 移除指定项并同步持久化", () => {
    const store = useMessageStore();
    const i1 = store.enqueuePending("#a", "one");
    store.enqueuePending("#a", "two");

    store.discardPending("#a", i1.tempId);

    expect(store.pendingByTarget["#a"].map((p) => p.content)).toEqual(["two"]);
    expect(pendingStorage()["#a"]).toHaveLength(1);
  });

  it("持久化恢复：queued/failed 原样恢复，sending 归 queued", () => {
    lsData.set(
      "pending_msgs_v1",
      JSON.stringify({
        "#a": [
          { tempId: "t1", nonce: "n-a", content: "q", status: "queued" },
          { tempId: "t2", nonce: "n-b", content: "f", status: "failed" },
          { tempId: "t3", nonce: "n-c", content: "s", status: "sending" },
        ],
      }),
    );
    setActivePinia(createPinia()); // 重新建 store 触发恢复
    const store = useMessageStore();

    expect(store.pendingByTarget["#a"].map((p) => p.status)).toEqual(["queued", "failed", "queued"]);
  });

  it("ackPendingByNonce 移除匹配乐观行（跨 target），不影响其他项", () => {
    const store = useMessageStore();
    const a = store.enqueuePending("#a", "from-a");
    store.enqueuePending("#b", "from-b");

    store.ackPendingByNonce(a.nonce);

    expect(store.pendingByTarget["#a"]).toBeUndefined();
    expect(store.pendingByTarget["#b"]).toHaveLength(1);
    expect(pendingStorage()["#a"]).toBeUndefined();

    store.ackPendingByNonce("n-not-exist"); // 无匹配不动作
    expect(store.pendingByTarget["#b"]).toHaveLength(1);
  });

  it("flushAllPending 补发全部 target（上会话恢复的 queued）", async () => {
    const store = useMessageStore();
    store.enqueuePending("#a", "one");
    store.enqueuePending("dm:x", "two");
    apiPostMock.mockResolvedValue({ state: "ok" } as any);

    await store.flushAllPending();

    expect(apiPostMock).toHaveBeenCalledTimes(2);
    expect(store.pendingByTarget).toEqual({});
  });
});
