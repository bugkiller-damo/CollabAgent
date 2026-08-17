import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, cleanupTestData, closeSql, registerUser } from "./helpers.js";

// O9：messages.seq 并发正确性——
// seq 是 BIGSERIAL（PG 序列）：nextval 原子、全局唯一、按取值单调，空洞允许（回滚/跨频道）。
// 本套件用真并发验证验收语义：同频道并发 N 条 → seq 无重复、严格可排、
// 断线补拉语义（after 游标分页）能完整收齐全部 N 条（无遗漏）；
// 双频道交叉并发 → 各频道内部子序列各自严格递增；
// 同 nonce 并发双发 → 幂等成立（恰好一条）。
// 另：/send 事务内已加同频道 advisory 锁（pg_advisory_xact_lock(hashtextextended(channel_id))），
// 保证「提交顺序 == seq 赋值顺序」，消除 BIGSERIAL 的提交乱序可见性窗口。

afterAll(async () => {
  await cleanupTestData();
  await closeSql();
});

// after 游标分页收齐某频道内 content 以 marker 开头的全部消息（模拟 O15 断线补拉语义）
async function collectViaBackfill(ck: string, channel: string, marker: string) {
  const collected: any[] = [];
  let after = 0;
  for (let page = 0; page < 20; page++) {
    const r = await api(`/api/messages/history?channel=${encodeURIComponent(channel)}&after=${after}&limit=7`, {
      cookie: ck,
    });
    expect(r.status).toBe(200);
    const msgs = (r.data.messages || []) as any[];
    for (const m of msgs) if (m.content.startsWith(marker)) collected.push(m);
    if (!r.data.hasMore || msgs.length === 0) break;
    after = msgs[msgs.length - 1].seq;
  }
  return collected;
}

describe("messages: seq 并发正确性（O9）", () => {
  let ck: string;
  const runId = randomUUID().replace(/-/g, "").slice(0, 8);
  const chanA = `zzseqa${runId}`;
  const chanB = `zzseqb${runId}`;

  beforeAll(async () => {
    const u = await registerUser();
    ck = u.cookie;
    for (const name of [chanA, chanB]) {
      const c = await api("/api/channels", { method: "POST", cookie: ck, body: { name } });
      expect(c.status).toBe(200);
    }
  });

  it("同频道并发 20 条 → seq 无重复，after 游标分页完整收齐且严格升序", async () => {
    const N = 20;
    const marker = `seq-A-${runId}-`;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        api("/api/messages/send", {
          method: "POST",
          cookie: ck,
          body: { target: `#${chanA}`, content: `${marker}${i}` },
        }),
      ),
    );
    for (const r of results) expect(r.status).toBe(200);

    // 响应侧：seq 全局唯一
    const seqs = results.map((r) => Number(r.data.messageSeq));
    expect(new Set(seqs).size).toBe(N);

    // 补拉侧：after=0 起分页收齐恰好 N 条，且按 seq 严格升序、无重复
    // （seq 是 BIGSERIAL，history 经 JSON 返回为字符串，比较前转 Number）
    const collected = await collectViaBackfill(ck, `#${chanA}`, marker);
    expect(collected.length).toBe(N);
    for (let i = 1; i < collected.length; i++) {
      expect(Number(collected[i].seq)).toBeGreaterThan(Number(collected[i - 1].seq));
    }
    expect(new Set(collected.map((m) => m.seq)).size).toBe(N);
    // 响应 seq 集合与补拉 seq 集合一致（无幽灵/无遗漏）
    expect(new Set(collected.map((m) => Number(m.seq)))).toEqual(new Set(seqs));
  });

  it("双频道交叉并发 → 各频道内部 seq 子序列各自严格递增且无重复", async () => {
    const N = 10;
    const markerA = `seq-B1-${runId}-`;
    const markerB = `seq-B2-${runId}-`;
    const sends = [
      ...Array.from({ length: N }, (_, i) => ({ target: `#${chanA}`, content: `${markerA}${i}` })),
      ...Array.from({ length: N }, (_, i) => ({ target: `#${chanB}`, content: `${markerB}${i}` })),
    ];
    const results = await Promise.all(
      sends.map((b) => api("/api/messages/send", { method: "POST", cookie: ck, body: b })),
    );
    for (const r of results) expect(r.status).toBe(200);

    // 全局 seq 跨频道交叉也唯一
    expect(new Set(results.map((r) => Number(r.data.messageSeq))).size).toBe(2 * N);

    for (const [chan, marker] of [
      [`#${chanA}`, markerA],
      [`#${chanB}`, markerB],
    ] as const) {
      const collected = await collectViaBackfill(ck, chan, marker);
      expect(collected.length).toBe(N);
      for (let i = 1; i < collected.length; i++) {
        expect(Number(collected[i].seq)).toBeGreaterThan(Number(collected[i - 1].seq));
      }
    }
  });

  it("同 nonce 并发双发 → 幂等成立：同 messageId、恰好一条、恰一个 deduplicated", async () => {
    const nonce = randomUUID();
    const marker = `seq-C-${runId}-`;
    const [r1, r2] = await Promise.all([
      api("/api/messages/send", {
        method: "POST",
        cookie: ck,
        body: { target: `#${chanA}`, content: `${marker}0`, clientNonce: nonce },
      }),
      api("/api/messages/send", {
        method: "POST",
        cookie: ck,
        body: { target: `#${chanA}`, content: `${marker}0`, clientNonce: nonce },
      }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.data.messageId).toBe(r2.data.messageId);
    expect(r1.data.messageSeq).toBe(r2.data.messageSeq);
    // 恰一个为重放（唯一索引保证一个获胜一个等待后 DO NOTHING）
    const dedupCount = [r1, r2].filter((r) => r.data.deduplicated === true).length;
    expect(dedupCount).toBe(1);

    const collected = await collectViaBackfill(ck, `#${chanA}`, marker);
    expect(collected.length).toBe(1);
  });
});
