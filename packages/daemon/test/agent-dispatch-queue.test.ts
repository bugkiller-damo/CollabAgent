import { describe, expect, it, vi } from "vitest";
import { createAgentDispatchQueue, type DispatchQueueItem } from "../src/agent-dispatch-queue.js";

/** 等所有微任务 + 一小段真实时间（队列退避用的小延迟） */
const flush = async (ms = 20): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};

const makeItem = () => ({ agentName: "alice", channelName: "general", content: "hello" });

describe("agent-dispatch-queue", () => {
  it("空闲时入队立即投递", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const q = createAgentDispatchQueue({ deliver });
    const res = q.enqueue(makeItem());
    expect(res.status).toBe("queued");
    await flush();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][1]).toHaveLength(1);
    expect(deliver.mock.calls[0][1][0].content).toBe("hello");
    q.dispose();
  });

  it("忙碌时排队，空闲后积压合并为一批投递", async () => {
    let release!: () => void;
    const deliver = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
      .mockResolvedValue(undefined);
    const onMerged = vi.fn();
    const q = createAgentDispatchQueue({ deliver, onMerged });

    q.enqueue({ ...makeItem(), content: "m1" });
    await flush(5); // m1 进入 in-flight（挂住）
    q.enqueue({ ...makeItem(), content: "m2" });
    q.enqueue({ ...makeItem(), content: "m3" });
    expect(q.depth("alice")).toBe(2);
    expect(q.isBusy("alice")).toBe(true);

    release(); // m1 投递完成 → m2+m3 合并排空
    await flush();
    expect(deliver).toHaveBeenCalledTimes(2);
    const secondBatch: DispatchQueueItem[] = deliver.mock.calls[1][1];
    expect(secondBatch.map((i) => i.content)).toEqual(["m2", "m3"]);
    expect(onMerged).toHaveBeenCalledTimes(1);
    expect(q.depth("alice")).toBe(0);
    q.dispose();
  });

  it("投递失败按退避重试，成功后不再重试", async () => {
    const deliver = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const onRetry = vi.fn();
    const q = createAgentDispatchQueue({ deliver, onRetry, baseDelayMs: 5, maxDelayMs: 10 });
    q.enqueue(makeItem());
    await flush(50);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    q.dispose();
  });

  it("重试耗尽进死信并上报", async () => {
    const deliver = vi.fn().mockRejectedValue(new Error("always fails"));
    const onDeadLetter = vi.fn();
    const q = createAgentDispatchQueue({
      deliver,
      onDeadLetter,
      baseDelayMs: 5,
      maxDelayMs: 10,
      maxRetries: 2,
    });
    q.enqueue(makeItem());
    await flush(100);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(onDeadLetter).toHaveBeenCalledTimes(1);
    const [, item, err] = onDeadLetter.mock.calls[0];
    expect(item.attempts).toBe(2);
    expect(String(err)).toContain("always fails");
    q.dispose();
  });

  it("in-flight 超时不 resolve 也算失败并按重试处理", async () => {
    const deliver = vi.fn().mockImplementation(() => new Promise<void>(() => {})); // 永不 resolve
    const onDeadLetter = vi.fn();
    const q = createAgentDispatchQueue({
      deliver,
      onDeadLetter,
      inflightMs: 30,
      maxRetries: 1, // 第一次失败即死信
    });
    q.enqueue(makeItem());
    await flush(80);
    expect(onDeadLetter).toHaveBeenCalledTimes(1);
    expect(String(onDeadLetter.mock.calls[0][2])).toContain("in-flight timeout");
    q.dispose();
  });

  it("dedup：窗口内同 agent 同内容的重复入队被吞掉", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const q = createAgentDispatchQueue({ deliver });
    expect(q.enqueue(makeItem()).status).toBe("queued");
    expect(q.enqueue(makeItem()).status).toBe("deduped");
    await flush();
    expect(deliver).toHaveBeenCalledTimes(1);
    q.dispose();
  });

  it("dedup 窗口外的同内容消息正常投递", async () => {
    let t = 1000;
    const deliver = vi.fn().mockResolvedValue(undefined);
    const q = createAgentDispatchQueue({ deliver, now: () => t, dedupWindowMs: 100 });
    q.enqueue(makeItem());
    await flush();
    t += 200; // 窗口外
    expect(q.enqueue(makeItem()).status).toBe("queued");
    await flush();
    expect(deliver).toHaveBeenCalledTimes(2);
    q.dispose();
  });

  it("isDeliverable=false 时入队即死信，不投递不重试", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const onDeadLetter = vi.fn();
    const q = createAgentDispatchQueue({ deliver, onDeadLetter, isDeliverable: () => false });
    const res = q.enqueue(makeItem());
    expect(res.status).toBe("dead");
    await flush();
    expect(deliver).not.toHaveBeenCalled();
    expect(onDeadLetter).toHaveBeenCalledTimes(1);
    q.dispose();
  });

  it("clear 丢弃 pending，dispose 清掉退避定时器", async () => {
    let release!: () => void;
    const deliver = vi.fn().mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const q = createAgentDispatchQueue({ deliver });
    q.enqueue({ ...makeItem(), content: "m1" });
    await flush(5);
    q.enqueue({ ...makeItem(), content: "m2" });
    expect(q.clear("alice")).toBe(1);
    release();
    await flush();
    expect(deliver).toHaveBeenCalledTimes(1); // m2 不会再投
    q.dispose();
  });

  it("clear 后 in-flight 失败不再重试（P0.3 epoch）", async () => {
    let reject!: (err: Error) => void;
    const deliver = vi.fn().mockImplementationOnce(() => new Promise<void>((_, rej) => (reject = rej)));
    const onRetry = vi.fn();
    const onDeadLetter = vi.fn();
    const q = createAgentDispatchQueue({
      deliver,
      onRetry,
      onDeadLetter,
      baseDelayMs: 5,
      maxDelayMs: 10,
      maxRetries: 3,
    });
    q.enqueue(makeItem());
    await flush(5);
    expect(q.clear("alice")).toBe(0); // in-flight 已 splice 出 pending
    reject(new Error("stopped"));
    await flush(50);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(onDeadLetter).not.toHaveBeenCalled();
    q.dispose();
  });

  it("一批中部分死信：attempts 独立计费", async () => {
    // m1 第一次投递失败后重试时，m2 入队被合并进同一批；
    // 批再失败时 m1 attempts=2 死信，m2 attempts=1 继续重试
    const deliver = vi.fn().mockRejectedValue(new Error("x"));
    const dead: string[] = [];
    const q = createAgentDispatchQueue({
      deliver,
      baseDelayMs: 5,
      maxDelayMs: 10,
      maxRetries: 2,
      onDeadLetter: (_a, item) => dead.push(item.content),
    });
    q.enqueue({ ...makeItem(), content: "m1" });
    await flush(5); // m1 失败 attempts=1，进入退避
    q.enqueue({ ...makeItem(), content: "m2" });
    await flush(100); // 退避结束合并批 [m1,m2] 再失败：m1 死信，m2 attempts=1 → 再退避 → 再失败死信
    expect(dead).toContain("m1");
    expect(dead).toContain("m2");
    q.dispose();
  });
});
