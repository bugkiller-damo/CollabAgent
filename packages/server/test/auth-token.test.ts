import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import {
  type MachineTokenGuardLike,
  type TokenPg,
  verifyBrowserToken,
  verifyMachineToken,
} from "../src/lib/auth-token.js";
import { metricsSnapshot } from "../src/lib/metrics.js";

/**
 * 评估报告 P1.15：令牌校验收敛（lib/auth-token.ts，HTTP/WS 共用）。
 * 全部离线：fake pg（按调用次序出队脚本化行 + 记录 SQL）、fake jwt、注入 stub
 * 护栏——不连 DB、不起 server。覆盖机器令牌快路径/续期策略/护栏拒绝/legacy 命中，
 * 以及浏览器 JWT 的强制 sid + 会话回查 fail-closed 行为。
 */

const DAY = 86_400_000;

/** 脚本化 fake pg：每次 query 按序弹出一段 { rows }，并记录 SQL/参数供断言 */
function fakePg(script: Array<{ rows: any[] }>): TokenPg & { calls: { sql: string; params?: unknown[] }[] } {
  const calls: { sql: string; params?: unknown[] }[] = [];
  let i = 0;
  return {
    calls,
    query: async (text: string, params?: unknown[]) => {
      calls.push({ sql: text, params });
      const step = script[i];
      i += 1;
      return { rows: step?.rows ?? [] };
    },
  };
}

/** stub 护栏：记录 tryEnter/release 次数，verdict 可注入 */
function stubGuard(verdict: "allowed" | "rate_limited" | "busy" = "allowed") {
  const state = { tryEnter: 0, release: 0 };
  const g: MachineTokenGuardLike = {
    async tryEnter() {
      state.tryEnter += 1;
      return verdict;
    },
    release() {
      state.release += 1;
    },
  };
  return { guard: g, state };
}

function updateCalls(pg: ReturnType<typeof fakePg>): number {
  return pg.calls.filter((c) => c.sql.includes("UPDATE machine_tokens")).length;
}

describe("verifyMachineToken：快路径与续期策略（P1.15 离线）", () => {
  it('renewal="threshold" 且剩余有效期充裕 → 认证成功且不发续期 UPDATE', async () => {
    const pg = fakePg([
      { rows: [{ id: "tok-1", user_id: "u-1", scope: "machine", expires_at: new Date(Date.now() + 80 * DAY) }] },
      { rows: [{ id: "u-1", handle: "amy" }] },
    ]);
    const v = await verifyMachineToken(pg, "sk_machine_fresh", { renewal: "threshold" });
    expect(v).toMatchObject({ ok: true, userId: "u-1", scope: "machine", handle: "amy", legacy: false });
    expect(updateCalls(pg)).toBe(0);
  });

  it('renewal="threshold" 且临近过期（<30 天）→ 发一条 +90 天续期 UPDATE', async () => {
    const pg = fakePg([
      { rows: [{ id: "tok-1", user_id: "u-1", scope: "machine", expires_at: new Date(Date.now() + 10 * DAY) }] },
      { rows: [{ id: "u-1", handle: "amy" }] },
      { rows: [] },
    ]);
    const v = await verifyMachineToken(pg, "sk_machine_due", { renewal: "threshold" });
    expect(v.ok).toBe(true);
    expect(updateCalls(pg)).toBe(1);
    expect(pg.calls[2]!.params).toEqual(["tok-1"]);
  });

  it('renewal="always"（WS 连接即续期）→ 即使有效期充裕也无条件 UPDATE', async () => {
    const pg = fakePg([
      { rows: [{ id: "tok-1", user_id: "u-1", scope: "machine", expires_at: new Date(Date.now() + 80 * DAY) }] },
      { rows: [{ id: "u-1", handle: "amy" }] },
      { rows: [] },
    ]);
    const v = await verifyMachineToken(pg, "sk_machine_ws", { renewal: "always" });
    expect(v.ok).toBe(true);
    expect(updateCalls(pg)).toBe(1);
  });

  it("快路径命中但用户行缺失 → invalid（且不产生续期写）", async () => {
    const pg = fakePg([
      { rows: [{ id: "tok-1", user_id: "u-gone", scope: "machine", expires_at: new Date(Date.now() + 10 * DAY) }] },
      { rows: [] },
    ]);
    const v = await verifyMachineToken(pg, "sk_machine_orphan", { renewal: "threshold" });
    expect(v).toEqual({ ok: false, reason: "invalid" });
    expect(updateCalls(pg)).toBe(0);
  });
});

describe("verifyMachineToken：护栏与 legacy 兼容路径（P1.15 离线）", () => {
  it("stub guard 返回 rate_limited → guard-rejected，不触达兼容路径查询且不 release", async () => {
    const pg = fakePg([{ rows: [] }]); // 只有快路径查询，兼容路径查询不应发生
    const { guard, state } = stubGuard("rate_limited");
    const before = metricsSnapshot().counters.machineAuthBcryptRejected;
    const v = await verifyMachineToken(pg, "sk_machine_probe", { clientIp: "10.0.0.9", renewal: "threshold", guard });
    expect(v).toEqual({ ok: false, reason: "guard-rejected", guardVerdict: "rate_limited" });
    expect(state.tryEnter).toBe(1);
    expect(state.release).toBe(0); // 未获准进入，无 release 配对
    expect(pg.calls.length).toBe(1); // 兼容路径的 BCRYPT_TOKEN_PREDICATE 查询未发出
    expect(pg.calls[0]!.sql).toContain("token_hash = $1");
    const after = metricsSnapshot().counters.machineAuthBcryptRejected;
    expect(after).toBeGreaterThanOrEqual(before + 1); // machineAuthBcryptRejected 在此处 inc
  });

  it("legacy bcrypt 令牌命中 → ok 且 legacy:true，warn 被调用，release 恰好一次（try/finally）", async () => {
    const token = "sk_machine_legacy_p1_15";
    const hash = bcrypt.hashSync(token, 4); // cost 4 仅为测试速度；isBcryptHash 只认前缀
    const pg = fakePg([
      { rows: [] }, // 快路径未命中
      { rows: [{ user_id: "u-2", scope: "machine", token_hash: hash }] }, // 兼容路径预过滤命中
      { rows: [{ id: "u-2", handle: "bob" }] },
    ]);
    const warns: { obj: unknown; msg: string }[] = [];
    const { guard, state } = stubGuard("allowed");
    const v = await verifyMachineToken(pg, token, {
      clientIp: "10.0.0.10",
      renewal: "always",
      guard,
      log: { warn: (obj, msg) => warns.push({ obj, msg }) },
    });
    expect(v).toMatchObject({ ok: true, userId: "u-2", scope: "machine", handle: "bob", legacy: true });
    expect(warns.length).toBe(1); // 命中即 warn（退役指引文案）
    expect(warns[0]!.msg).toContain("08-bcrypt-token-retirement.md");
    expect(state.release).toBe(1); // finally 释放并发额度
  });

  it("legacy 行全不匹配（假令牌）→ invalid，release 仍被调用", async () => {
    const hash = bcrypt.hashSync("sk_machine_other_token", 4);
    const pg = fakePg([{ rows: [] }, { rows: [{ user_id: "u-2", scope: "machine", token_hash: hash }] }]);
    const { guard, state } = stubGuard("allowed");
    const v = await verifyMachineToken(pg, "sk_machine_wrong", { renewal: "always", guard });
    expect(v).toEqual({ ok: false, reason: "invalid" });
    expect(state.release).toBe(1);
  });
});

describe("verifyBrowserToken：强制 sid + 会话回查（P1.15 离线）", () => {
  const fakeJwt = (payload: unknown) => ({
    verify: (t: string) => {
      if (t === "bad") throw new Error("signature mismatch");
      return payload;
    },
  });

  it("verify 抛错 → null（且不触达会话回查）", async () => {
    const pg = fakePg([]);
    const u = await verifyBrowserToken(fakeJwt(null), pg, "bad");
    expect(u).toBeNull();
    expect(pg.calls.length).toBe(0);
  });

  it("payload 无 sub → null", async () => {
    const pg = fakePg([]);
    const u = await verifyBrowserToken(fakeJwt({ sid: "s" }), pg, "tok");
    expect(u).toBeNull();
    expect(pg.calls.length).toBe(0);
  });

  it("无 sid → null（P1.15 强制 sid fail-closed，存量旧 token 不再跳过会话回查）", async () => {
    const pg = fakePg([]);
    const u = await verifyBrowserToken(fakeJwt({ sub: "u-1" }), pg, "tok");
    expect(u).toBeNull();
    expect(pg.calls.length).toBe(0); // 直接拒绝，连回查都不发
  });

  it("sid 对应会话已吊销（回查空行）→ null", async () => {
    const pg = fakePg([{ rows: [] }]); // user_sessions 查询 0 行
    const u = await verifyBrowserToken(fakeJwt({ sub: "u-1", sid: "sid-revoked-1", tv: "tv-1" }), pg, "tok");
    expect(u).toBeNull();
    expect(pg.calls.length).toBe(1);
    expect(pg.calls[0]!.sql).toContain("user_sessions");
  });

  it("会话有效（tv 匹配）→ 返回 userId/sid/tv/handle，payload 原字段随摊开保留", async () => {
    const pg = fakePg([{ rows: [{ ok: 1 }] }, { rows: [{ ok: 1 }] }]); // sessions + token_version 校验
    const u = await verifyBrowserToken(fakeJwt({ sub: "u-1", sid: "sid-ok-1", tv: "tv-1", handle: "amy" }), pg, "tok");
    expect(u).not.toBeNull();
    expect(u!.userId).toBe("u-1");
    expect(u!.sid).toBe("sid-ok-1");
    expect(u!.tv).toBe("tv-1");
    expect(u!.handle).toBe("amy");
    expect(pg.calls.length).toBe(2);
  });

  it("jwt / pg / token 任一缺失 → null（fail-closed）", async () => {
    const pg = fakePg([]);
    expect(await verifyBrowserToken(undefined, pg, "tok")).toBeNull();
    expect(await verifyBrowserToken(fakeJwt({ sub: "u-1", sid: "s" }), null, "tok")).toBeNull();
    expect(await verifyBrowserToken(fakeJwt({ sub: "u-1", sid: "s" }), pg, null)).toBeNull();
    expect(await verifyBrowserToken(fakeJwt({ sub: "u-1", sid: "s" }), pg, "")).toBeNull();
    expect(pg.calls.length).toBe(0);
  });
});
