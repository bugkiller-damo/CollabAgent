// P1.25 探针用户清理：删 zzp 前缀 + @probe.local 的测试账号（探针反复跑出的残留）。
// 探针发 DM 会创建 channels（created_by 指向用户、无级联），须按 FK 安全顺序先清频道侧。
// 用法：DATABASE_URL=... node scripts/cleanup-p125-probe-users.mjs
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const sql = postgres(url, { max: 1 });
const rows = await sql`SELECT id, handle FROM users WHERE email LIKE '%@probe.local' AND handle LIKE 'zzp%'`;
console.log("probe users found:", rows.length);
if (rows.length) {
  const uids = rows.map((r) => String(r.id));
  // FK 安全顺序（对齐 test/helpers.ts cleanupTestData）：频道 → 频道内容 → 成员/会话 → 用户
  const chans = await sql`
    SELECT id FROM channels
     WHERE created_by::text = ANY(${uids})
        OR id IN (SELECT channel_id FROM channel_members WHERE member_id::text = ANY(${uids}))`;
  const cids = chans.map((r) => String(r.id));
  if (cids.length) {
    await sql`DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE channel_id::text = ANY(${cids}))`;
    await sql`DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id::text = ANY(${cids}))`;
    await sql`DELETE FROM messages WHERE channel_id::text = ANY(${cids})`;
    await sql`DELETE FROM channel_members WHERE channel_id::text = ANY(${cids})`;
    await sql`DELETE FROM channels WHERE id::text = ANY(${cids})`;
  }
  await sql`DELETE FROM messages WHERE sender_id::text = ANY(${uids})`;
  await sql`DELETE FROM message_reactions WHERE user_id::text = ANY(${uids})`;
  await sql`DELETE FROM channel_members WHERE member_id::text = ANY(${uids})`;
  await sql`DELETE FROM notifications WHERE user_id::text = ANY(${uids})`;
  await sql`DELETE FROM reminders WHERE owner_id::text = ANY(${uids})`;
  await sql`DELETE FROM computers WHERE user_id::text = ANY(${uids})`;
  await sql`DELETE FROM machine_tokens WHERE user_id::text = ANY(${uids})`;
  await sql`DELETE FROM user_sessions WHERE user_id::text = ANY(${uids})`;
  await sql`DELETE FROM server_members WHERE user_id::text = ANY(${uids})`;
  await sql`DELETE FROM users WHERE id::text = ANY(${uids})`;
  console.log("deleted:", rows.map((r) => r.handle).join(","));
}
const left = await sql`SELECT count(*)::int AS n FROM users WHERE email LIKE '%@probe.local'`;
console.log("remaining probe users:", left[0].n);
await sql.end({ timeout: 3 });
