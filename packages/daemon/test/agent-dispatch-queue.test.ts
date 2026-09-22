import { describe, expect, it, vi } from "vitest";
import { createAgentDispatchQueue, type DispatchQueueItem } from "../src/agent-dispatch-queue.js";
import { DispatchError } from "../src/errors.js";

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

  it("A4：in-flight 超时视为仍在跑——不重投不死信，等真实 settle（§8.13⑦）", async () => {
    let release!: () => void;
    const deliver = vi.fn().mockImplementation(() => new Promise<void>((r) => (release = r)));
    const onDeadLetter = vi.fn();
    const onRetry = vi.fn();
    const q = createAgentDispatchQueue({
      deliver,
      onDeadLetter,
      onRetry,
      inflightMs: 30,
      maxRetries: 1,
    });
    const res = q.enqueue(makeItem());
    if (res.status !== "queued") throw new Error("expected queued");
    await flush(80); // 越过 inflightMs——旧语义此刻已超时重投/死信
    expect(deliver).toHaveBeenCalledTimes(1); // 不重投
    expect(onRetry).not.toHaveBeenCalled();
    expect(onDeadLetter).not.toHaveBeenCalled();
    expect(q.isBusy("alice")).toBe(true); // 仍在跑
    release(); // 真实 settle（迟到正常完成）→ delivered
    await res.done;
    await flush();
    expect(q.isBusy("alice")).toBe(false);
    q.dispose();
  });

  it("A4：in-flight 超时后真实失败（进程死）仍按可重试路径重投", async () => {
    let reject!: (err: Error) => void;
    const deliver = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((_, rej) => (reject = rej)))
      .mockResolvedValue(undefined);
    const onRetry = vi.fn();
    const onDeadLetter = vi.fn();
    const q = createAgentDispatchQueue({
      deliver,
      onRetry,
      onDeadLetter,
      inflightMs: 30,
      baseDelayMs: 5,
      maxDelayMs: 10,
      maxRetries: 2,
    });
    q.enqueue(makeItem());
    await flush(60); // 越过 inflightMs：只告警，不重投
    expect(deliver).toHaveBeenCalledTimes(1);
    reject(new Error("persistent process exited mid-turn (code=1)")); // 真实失败才走重试
    await flush(50);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDeadLetter).not.toHaveBeenCalled();
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

  it("P0.6：deliveryGate 阻塞时 drain 丢弃批次——不投递、不重试、done 照常 resolve", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const onDeliveryBlocked = vi.fn();
    const onRetry = vi.fn();
    const q = createAgentDispatchQueue({
      deliver,
      onDeliveryBlocked,
      onRetry,
      deliveryGate: () => ({ blocked: true, reason: "cost circuit-break" }),
    });
    const res = q.enqueue(makeItem());
    expect(res.status).toBe("queued"); // 入队不查 gate，drain 时才拦
    if (res.status !== "queued") throw new Error("expected queued");
    await flush();
    expect(deliver).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
    expect(onDeliveryBlocked).toHaveBeenCalledTimes(1);
    expect(onDeliveryBlocked.mock.calls[0][1]).toHaveLength(1);
    expect(onDeliveryBlocked.mock.calls[0][2]).toBe("cost circuit-break");
    await expect(res.done).resolves.toBeUndefined(); // await 方不挂住
    expect(q.depth("alice")).toBe(0);
    q.dispose();
  });

  it("P0.6：退避期间预算耗尽——重试出队前被 gate 拦下", async () => {
    // 第一次投递失败进入退避；退避结束后 drain 重估 gate，此时已熔断 → 丢弃而非重投
    const deliver = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const onDeliveryBlocked = vi.fn();
    let blocked = false;
    const q = createAgentDispatchQueue({
      deliver,
      onDeliveryBlocked,
      // 退避窗口 40–60ms（50 ±20% jitter），与下方 flush(10)/flush(150) 拉开安全距离
      baseDelayMs: 50,
      maxDelayMs: 50,
      maxRetries: 3,
      deliveryGate: () => ({ blocked, reason: "cost circuit-break" }),
    });
    q.enqueue(makeItem());
    await flush(10);
    expect(deliver).toHaveBeenCalledTimes(1); // 首投失败
    blocked = true; // 退避期间预算耗尽
    await flush(150); // 等退避结束触发 drain
    expect(deliver).toHaveBeenCalledTimes(1); // 没有重投
    expect(onDeliveryBlocked).toHaveBeenCalledTimes(1);
    expect(q.isBusy("alice")).toBe(false);
    q.dispose();
  });

  it("P0.6：gate 解除后新消息正常投递（阻塞不污染队列状态）", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    let blocked = true;
    const q = createAgentDispatchQueue({ deliver, deliveryGate: () => ({ blocked }) });
    q.enqueue({ ...makeItem(), content: "m1" });
    await flush();
    expect(deliver).not.toHaveBeenCalled();
    blocked = false;
    q.enqueue({ ...makeItem(), content: "m2" });
    await flush();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][1][0].content).toBe("m2");
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

  it("P1.14：非可重试 DispatchError（agent-stopped）首次失败即死信，不空转退避", async () => {
    const deliver = vi.fn().mockRejectedValue(new DispatchError("agent-stopped", "is stopped"));
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
    await flush(50);
    expect(deliver).toHaveBeenCalledTimes(1); // 只投一次
    expect(onRetry).not.toHaveBeenCalled();
    expect(onDeadLetter).toHaveBeenCalledTimes(1);
    expect(onDeadLetter.mock.calls[0][2]).toBeInstanceOf(DispatchError);
    q.dispose();
  });

  it("P1.14：可重试 DispatchError（inflight-timeout）保持退避重试语义", async () => {
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(new DispatchError("inflight-timeout", "dispatch in-flight timeout"))
      .mockResolvedValue(undefined);
    const onRetry = vi.fn();
    const onDeadLetter = vi.fn();
    const q = createAgentDispatchQueue({
      deliver,
      onRetry,
      onDeadLetter,
      baseDelayMs: 5,
      maxDelayMs: 10,
    });
    q.enqueue(makeItem());
    await flush(50);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDeadLetter).not.toHaveBeenCalled();
    q.dispose();
  });

  it("P1.14：未分类普通 Error 视为可重试（冻结 PTY 路径等未迁移抛点行为不变）", async () => {
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
    expect(deliver).toHaveBeenCalledTimes(2); // 与旧「一律重试」行为一致
    expect(onDeadLetter).toHaveBeenCalledTimes(1);
    q.dispose();
  });

  it("A4：跨频道不合并——不同 channel 的 pending 各自成批、按到达序排空", async () => {
    let release!: () => void;
    const deliver = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
      .mockResolvedValue(undefined);
    const onMerged = vi.fn();
    const q = createAgentDispatchQueue({ deliver, onMerged });
    q.enqueue({ ...makeItem(), content: "m1" }); // #general 在途挂住
    await flush(5);
    q.enqueue({ ...makeItem(), content: "m2" }); // #general 积压
    q.enqueue({ ...makeItem(), channelName: "other", content: "m3" }); // #other 积压
    release();
    await flush();
    expect(deliver).toHaveBeenCalledTimes(3);
    const batch2: DispatchQueueItem[] = deliver.mock.calls[1][1];
    const batch3: DispatchQueueItem[] = deliver.mock.calls[2][1];
    // m2 与 m3 分属不同桶——绝不拼进同一批
    expect(batch2.map((i) => i.content)).toEqual(["m2"]);
    expect(batch2[0].channelName).toBe("general");
    expect(batch3.map((i) => i.content)).toEqual(["m3"]);
    expect(batch3[0].channelName).toBe("other");
    expect(onMerged).not.toHaveBeenCalled();
    q.dispose();
  });

  it("A4：分诊不与 @ 合并——kind 不同的同频道 pending 各自成批", async () => {
    let release!: () => void;
    const deliver = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
      .mockResolvedValue(undefined);
    const q = createAgentDispatchQueue({ deliver });
    q.enqueue({ ...makeItem(), content: "@alice 看下这个" });
    await flush(5);
    q.enqueue({ ...makeItem(), content: "【频道分诊】#general 来了一条新消息", kind: "triage" });
    release();
    await flush();
    expect(deliver).toHaveBeenCalledTimes(2);
    const batch2: DispatchQueueItem[] = deliver.mock.calls[1][1];
    expect(batch2).toHaveLength(1);
    expect(batch2[0].kind).toBe("triage"); // kind 随 item 透传
    q.dispose();
  });

  it("A4：死信后重发不被吞——去重后写，死信不占 dedup 窗口", async () => {
    const deliver = vi.fn().mockRejectedValue(new Error("always fails"));
    const onDeadLetter = vi.fn();
    const q = createAgentDispatchQueue({
      deliver,
      onDeadLetter,
      baseDelayMs: 5,
      maxDelayMs: 10,
      maxRetries: 1, // 首次失败即死信
    });
    q.enqueue(makeItem());
    await flush(30);
    expect(onDeadLetter).toHaveBeenCalledTimes(1);
    // 同一内容在 dedup 窗口内重发——必须放行（消息实际从未送达）
    deliver.mockResolvedValue(undefined);
    const res = q.enqueue(makeItem());
    expect(res.status).toBe("queued");
    await flush();
    expect(deliver).toHaveBeenCalledTimes(2);
    q.dispose();
  });

  it("A4：clear 丢弃 pending 走死信回调（频道可见未送达）", async () => {
    let release!: () => void;
    const deliver = vi.fn().mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const onDeadLetter = vi.fn();
    const q = createAgentDispatchQueue({ deliver, onDeadLetter });
    q.enqueue({ ...makeItem(), content: "m1" });
    await flush(5);
    q.enqueue({ ...makeItem(), content: "m2" });
    q.enqueue({ ...makeItem(), channelName: "other", content: "m3" });
    expect(q.clear("alice")).toBe(2);
    expect(onDeadLetter).toHaveBeenCalledTimes(2);
    const deadContents = onDeadLetter.mock.calls.map((c) => c[1].content);
    expect(deadContents).toEqual(expect.arrayContaining(["m2", "m3"]));
    release();
    await flush();
    expect(deliver).toHaveBeenCalledTimes(1); // 丢弃的不会再投
    q.dispose();
  });

  it("A4：同频道不同线程不合并——threadId 参与桶键", async () => {
    let release!: () => void;
    const deliver = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
      .mockResolvedValue(undefined);
    const q = createAgentDispatchQueue({ deliver });
    q.enqueue({ ...makeItem(), content: "m1" });
    await flush(5);
    q.enqueue({ ...makeItem(), content: "m2", threadId: "t-1" });
    q.enqueue({ ...makeItem(), content: "m3" });
    release();
    await flush();
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(deliver.mock.calls[1][1].map((i: DispatchQueueItem) => i.content)).toEqual(["m3"]); // 顶层桶先到的 head
    expect(deliver.mock.calls[2][1].map((i: DispatchQueueItem) => i.content)).toEqual(["m2"]);
    expect(deliver.mock.calls[2][1][0].threadId).toBe("t-1");
    q.dispose();
  });

  it("Phase 2：turnId 首次入队生成且跨重试稳定，attempts 随失败递增", async () => {
    const deliver = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const q = createAgentDispatchQueue({ deliver, baseDelayMs: 5, maxDelayMs: 10 });
    const res = q.enqueue({ ...makeItem(), sender: "alice" });
    expect(res.status).toBe("queued");
    if (res.status !== "queued") return;
    const turnId = res.item.turnId;
    expect(turnId).toMatch(/^turn-/);
    expect(res.item.sender).toBe("alice");
    await flush(60);
    expect(deliver).toHaveBeenCalledTimes(2);
    // 两次投递同一 turnId（同一对象引用——首次投递后 attempts 被原地 +1，
    // 只能断言重投时的 attempts=1 与 turnId 稳定）。
    expect(deliver.mock.calls[0][1][0].turnId).toBe(turnId);
    expect(deliver.mock.calls[1][1][0].turnId).toBe(turnId);
    expect(deliver.mock.calls[1][1][0].attempts).toBe(1);
    q.dispose();
  });

  it("Phase 2：DispatchError.retryAfterMs 抬升重试等待（§15.2 取 max(退避, 声明) 并封顶 maxDelay）", async () => {
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(new DispatchError("provider-rate-limited", "rate limited", { retryAfterMs: 80 }));
    const onRetry = vi.fn();
    const q = createAgentDispatchQueue({ deliver, onRetry, baseDelayMs: 5, maxDelayMs: 60 });
    q.enqueue(makeItem());
    await flush(40); // 第一次失败已发生；退避 max(~5ms,80ms)→60ms（封顶，clamp 后无 jitter）
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][3]).toBe(60);
    q.dispose();
  });

  it("Phase 2：retryAfterMs 未超 maxDelay 时声明值生效（大于指数退避取声明）", async () => {
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(new DispatchError("provider-rate-limited", "rate limited", { retryAfterMs: 40 }));
    const onRetry = vi.fn();
    const q = createAgentDispatchQueue({ deliver, onRetry, baseDelayMs: 5, maxDelayMs: 60 });
    q.enqueue(makeItem());
    await flush(30);
    expect(onRetry.mock.calls[0][3]).toBe(40); // max(~5, 40) = 40
    q.dispose();
  });

  it("Phase 5：turnId 跨 daemon 重启唯一——重启后不与历史 journal 记录碰撞", async () => {
    // 实机事故（2026-09-22）：纯进程计数器重启归零，新回合 turnId 撞上 worker
    // journal 里昨天的同号终态 → worker 幂等回放旧 error/success，图根本没跑。
    // 模拟「重启」：resetModules 后重新 import = 新进程模块态。
    const deliver1 = vi.fn().mockResolvedValue(undefined);
    const q1 = createAgentDispatchQueue({ deliver: deliver1 });
    const r1 = q1.enqueue(makeItem());
    if (r1.status !== "queued") throw new Error("expected queued");
    q1.enqueue({ ...makeItem(), content: "second" });
    await flush();
    q1.dispose();
    const bootOneIds = new Set<string>([
      r1.item.turnId,
      ...deliver1.mock.calls.flatMap((c) => (c[1] as DispatchQueueItem[]).map((i) => i.turnId)),
    ]);
    expect(bootOneIds.size).toBeGreaterThan(0);

    vi.resetModules();
    const fresh = await import("../src/agent-dispatch-queue.js");
    const deliver2 = vi.fn().mockResolvedValue(undefined);
    const q2 = fresh.createAgentDispatchQueue({ deliver: deliver2 });
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const r = q2.enqueue({ ...makeItem(), content: `post-restart-${i}` });
      if (r.status !== "queued") throw new Error("expected queued");
      seen.add(r.item.turnId);
    }
    await flush();
    for (const c of deliver2.mock.calls) for (const item of c[1]) seen.add(item.turnId);
    q2.dispose();
    vi.resetModules();

    for (const id of bootOneIds) expect(seen.has(id)).toBe(false);
    expect([...seen].every((id) => id.startsWith("turn-"))).toBe(true);
  });
});
