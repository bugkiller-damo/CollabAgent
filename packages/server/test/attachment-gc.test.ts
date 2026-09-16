import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runGcSweep } from "../src/lib/attachment-gc.js";
import { getStorage, UPLOAD_DIR } from "../src/lib/storage.js";
import { closeSql, sql, TEST_PREFIX } from "./helpers.js";

// F1 附件孤儿 GC（评估零覆盖：attachment-gc.ts 新模块）。
// 离线直测（不起 server）：runGcSweep(假 app, { graceHours, batch }) 直接驱动单轮清扫；
// 数据直插真库（DELETE ... NOT EXISTS 子查询 + RETURNING 纯 mock 打不出）；
// 对象字节走真实 local storage（getStorage().save 落 UPLOAD_DIR，sweep 后 existsSync 断言）。
//
// 时钟说明：孤儿判定 `created_at < now() - 宽限` 是 PG 侧时钟——测试通过「DB 侧插入
// 过去/现在 created_at」控制（这才是 sweep 真正服从的时钟），不碰 vitest 假时钟。
//
// 覆盖：老孤儿删行+删字节 / 新孤儿宽限内保留 / 被引用老附件保留 / 字节缺失行照删 /
// batch 限量生效。

// TAG 统一走 TEST_PREFIX（zz_test_）：残留行在 cleanupTestData/清理脚本口径内
// （helpers cleanup 已补 attachments 维度，2026-09-16）。
const TAG = TEST_PREFIX + "gc" + Date.now().toString(36);
let uploaderId = "";
let serverId = "";
let channelId = "";
let messageId = "";

/** 假 app：pg 用 helpers.sql 真库，log.warn/error 透传控制台（sweep 兜底若静音会退化成「行没了字节没删」的无声事故） */
function fakeApp() {
  return {
    pg: {
      query: async (t: string, p?: unknown[]) => ({ rows: await sql.unsafe(t, (p || []) as any[]) }),
    },
    log: {
      info: () => {},
      warn: (...a: unknown[]) => console.warn("[gc-warn]", ...a),
      error: (...a: unknown[]) => console.error("[gc-error]", ...a),
    },
  } as any;
}

/** 直插附件行；old=true 时 created_at 回拨 2 小时（越过测试用 1h 宽限）。返回 { id, key }。 */
async function insertAttachment(name: string, opts: { old?: boolean; writeBytes?: boolean } = {}) {
  const key = `${TAG}/${name}`;
  if (opts.writeBytes !== false) await getStorage().save(key, Buffer.from("gc-test:" + name));
  const rows = await sql<{ id: string }[]>`
    INSERT INTO attachments (uploader_id, uploader_type, filename, mime_type, size_bytes, storage_key, storage_url, created_at)
    VALUES (${uploaderId}, 'human', ${name}, 'text/plain', 10, ${key}, ${"/files/" + key},
            ${opts.old ? sql`now() - interval '2 hours'` : sql`now()`})
    RETURNING id`;
  return { id: String(rows[0].id), key };
}

const fileExists = (key: string) => existsSync(join(UPLOAD_DIR, key));

beforeAll(async () => {
  uploaderId = crypto.randomUUID(); // attachments.uploader_id 无 FK（schema 000:145），随机 UUID 即可
  // 引用测试用的最小 server/channel/message 链（messages.server_id/channel_id 有 FK）
  const sv = await sql<{ id: string }[]>`INSERT INTO servers (name, created_by) VALUES (${TAG}, NULL) RETURNING id`;
  serverId = String(sv[0].id);
  const ch = await sql<
    { id: string }[]
  >`INSERT INTO channels (server_id, name) VALUES (${serverId}, ${TAG}) RETURNING id`;
  channelId = String(ch[0].id);
  const msg = await sql<{ id: string }[]>`
    INSERT INTO messages (channel_id, server_id, sender_id, sender_type, content)
    VALUES (${channelId}, ${serverId}, ${uploaderId}, 'human', ${TAG}) RETURNING id`;
  messageId = String(msg[0].id);
});

afterAll(async () => {
  // FK 安全顺序：映射 → 消息 → 附件行 → 频道/社区；对象字节 best-effort 兜底
  await sql`DELETE FROM message_attachments WHERE message_id = ${messageId}`;
  await sql`DELETE FROM messages WHERE id = ${messageId}`;
  const leftover = await sql<{ storage_key: string }[]>`
    DELETE FROM attachments WHERE uploader_id = ${uploaderId} RETURNING storage_key`;
  for (const r of leftover)
    await getStorage()
      .remove(String(r.storage_key))
      .catch(() => {});
  await sql`DELETE FROM channels WHERE id = ${channelId}`;
  await sql`DELETE FROM servers WHERE id = ${serverId}`;
  await closeSql();
});

describe("attachment GC sweep", () => {
  it("删除越过宽限期的孤儿：行与对象字节都清掉", async () => {
    const { id, key } = await insertAttachment("old-orphan.txt", { old: true });
    expect(fileExists(key)).toBe(true);
    const r = await runGcSweep(fakeApp(), { graceHours: 1 });
    expect(r.rows).toBeGreaterThanOrEqual(1);
    const rows = await sql`SELECT 1 FROM attachments WHERE id = ${id}`;
    expect(rows.length).toBe(0);
    expect(fileExists(key)).toBe(false);
  });

  it("宽限期内的孤儿保留（上传后尚未随消息发出的正常在途窗口）", async () => {
    const { id, key } = await insertAttachment("fresh-orphan.txt", { old: false });
    await runGcSweep(fakeApp(), { graceHours: 24 });
    const rows = await sql`SELECT 1 FROM attachments WHERE id = ${id}`;
    expect(rows.length).toBe(1);
    expect(fileExists(key)).toBe(true);
  });

  it("被消息引用的老附件保留（NOT EXISTS 引用判定）", async () => {
    const { id, key } = await insertAttachment("referenced.txt", { old: true });
    await sql`INSERT INTO message_attachments (message_id, attachment_id) VALUES (${messageId}, ${id})`;
    await runGcSweep(fakeApp(), { graceHours: 1 });
    const rows = await sql`SELECT 1 FROM attachments WHERE id = ${id}`;
    expect(rows.length).toBe(1);
    expect(fileExists(key)).toBe(true);
    await sql`DELETE FROM message_attachments WHERE message_id = ${messageId} AND attachment_id = ${id}`;
  });

  it("对象字节已缺失的行照删（storage.remove 幂等，不误报失败）", async () => {
    const { id } = await insertAttachment("no-bytes.txt", { old: true, writeBytes: false });
    const r = await runGcSweep(fakeApp(), { graceHours: 1 });
    const rows = await sql`SELECT 1 FROM attachments WHERE id = ${id}`;
    expect(rows.length).toBe(0);
    expect(r.bytesFailed).toBe(0);
  });

  it("batch 限量生效：3 个老孤儿 batch=2 只删 2 行", async () => {
    const a = await insertAttachment("batch-a.txt", { old: true });
    const b = await insertAttachment("batch-b.txt", { old: true });
    const c = await insertAttachment("batch-c.txt", { old: true });
    const r = await runGcSweep(fakeApp(), { graceHours: 1, batch: 2 });
    expect(r.rows).toBe(2);
    const remaining = await sql`SELECT id FROM attachments WHERE id = ANY(${[a.id, b.id, c.id]})`;
    expect(remaining.length).toBe(1);
    // 收尾：把最后一行也扫掉，不给后续用例留污染
    await runGcSweep(fakeApp(), { graceHours: 1, batch: 10 });
  });
});
