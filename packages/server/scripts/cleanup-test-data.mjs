// 测试数据清理：删 zz_test_ 前缀（vitest helpers TEST_PREFIX）与 zzp/@probe.local（探针）账号
// 及其 FK 关联数据。清理口径对齐 test/helpers.ts cleanupTestData（本机直连密码问题导致
// afterAll 清理长期跑不成，残留靠本脚本兜底）。
//
// 安全口径：
// - 种子频道（general/random/engineering）永不删除——即使 created_by 是测试用户也只报不删；
// - audit 哈希链不动（追加型审计，删行会断链）；
// - 默认 dry-run 只盘点；APPLY=1 才实际删除。
//
// 用法（在 packages/server 下，.env 提供 DATABASE_URL，凭证不落终端）：
//   node scripts/cleanup-test-data.mjs          # 盘点
//   APPLY=1 node scripts/cleanup-test-data.mjs  # 执行
import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set (run from packages/server so .env loads)");
  process.exit(1);
}
const APPLY = process.env.APPLY === "1";
const SEED_CHANNELS = ["general", "random", "engineering"];
const sql = postgres(url, { max: 1 });

// 测试成员：vitest zz_test_ 前缀 + 历史遗留的 zz_tenant_（tenant.test）与 zzsched
// （reminder-scheduler.test，两者 2026-09-16 起已改走 TEST_PREFIX）+ 探针 zzp/@probe.local
// （zz_tenant/zzsched 是各测试自定的句柄前缀，cleanupTestData 的 zz_test_ 口径覆盖不到）
const users = await sql`
  SELECT id, handle FROM users
   WHERE handle LIKE 'zz_test_%'
      OR handle LIKE 'zz_tenant_%'
      OR handle LIKE 'zzsched%'
      OR (handle LIKE 'zzp%' AND email LIKE '%@probe.local')`;
const uids = users.map((r) => String(r.id));
console.log(`[inventory] test users: ${users.length}`);
if (users.length)
  console.log(
    "  sample:",
    users
      .slice(0, 10)
      .map((r) => r.handle)
      .join(", "),
  );

if (uids.length === 0) {
  console.log("nothing to do");
  await sql.end({ timeout: 3 });
  process.exit(0);
}

// 待删 server：测试用户创建/持有的社区（tenant 测试每轮建一个）。
// 关键：channels.server_id 无级联——这些 server 里的频道（含它们的 #general）不先删，
// DELETE FROM servers 会撞 FK。种子守卫因此必须按「server 是否待删」判定：
// 只有 server 不在待删集里的 general/random/engineering 才是真种子频道。
const doomedServers = await sql`
  SELECT id, name FROM servers WHERE created_by::text = ANY(${uids}) OR owner_id::text = ANY(${uids})`;
const doomedServerIds = new Set(doomedServers.map((r) => String(r.id)));
console.log(`[inventory] servers owned by test users: ${doomedServers.length}`);

// 测试频道：待删 server 内的全部频道 ∪ 测试用户创建的/有测试用户混入的频道
const chans = await sql`
  SELECT c.id, c.name, c.type, c.server_id::text AS server_id, c.created_by::text AS created_by FROM channels c
   WHERE c.server_id::text = ANY(${doomedServerIds.size ? [...doomedServerIds] : ["00000000-0000-0000-0000-000000000000"]})
      OR c.created_by::text = ANY(${uids})
      OR c.id IN (SELECT channel_id FROM channel_members WHERE member_id::text = ANY(${uids}))`;
const isSeed = (c) => SEED_CHANNELS.includes(c.name) && c.type !== "dm" && !doomedServerIds.has(String(c.server_id));
const seedHit = chans.filter(isSeed);
const doomed = chans.filter((c) => !isSeed(c));
console.log(`[inventory] channels touched: ${chans.length} → delete ${doomed.length}, keep seed ${seedHit.length}`);
if (seedHit.length) {
  console.log("  [guard] seed channels NOT deleted:", seedHit.map((c) => c.name).join(", "));
}
console.log(
  "  channels to delete:",
  doomed
    .slice(0, 20)
    .map((c) => `${c.name}(${c.type})`)
    .join(", ") || "(none)",
);

// 影响面盘点
const doomIds = doomed.map((c) => String(c.id));
const msgInChans = doomIds.length
  ? await sql`SELECT count(*)::int AS n FROM messages WHERE channel_id::text = ANY(${doomIds})`
  : [{ n: 0 }];
const msgByUsers = await sql`SELECT count(*)::int AS n FROM messages WHERE sender_id::text = ANY(${uids})`;
const agents = await sql`SELECT count(*)::int AS n FROM agents WHERE user_id::text = ANY(${uids})`;
console.log(
  `[inventory] messages in doomed channels: ${msgInChans[0].n}; messages by test users (any channel): ${msgByUsers[0].n}; agents owned by test users: ${agents[0].n}`,
);

if (!APPLY) {
  console.log("\ndry-run only. Re-run with APPLY=1 to delete.");
  await sql.end({ timeout: 3 });
  process.exit(0);
}

const cids = doomIds;
// FK 安全顺序（对齐 cleanupTestData）：频道内容 → 频道 → 用户维度数据 → 用户
if (cids.length) {
  await sql`DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE channel_id::text = ANY(${cids}))`;
  await sql`DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id::text = ANY(${cids}))`;
  await sql`DELETE FROM messages WHERE channel_id::text = ANY(${cids})`;
  await sql`DELETE FROM action_cards WHERE channel_id::text = ANY(${cids})`;
  await sql`DELETE FROM dispatches WHERE channel_id::text = ANY(${cids})`;
  await sql`DELETE FROM channel_members WHERE channel_id::text = ANY(${cids})`;
  await sql`DELETE FROM channels WHERE id::text = ANY(${cids})`;
  console.log(`[apply] deleted ${cids.length} channels and their content`);
}
await sql`DELETE FROM messages WHERE sender_id::text = ANY(${uids})`;
await sql`DELETE FROM action_cards WHERE created_by::text = ANY(${uids}) OR target_user::text = ANY(${uids})`;
await sql`DELETE FROM message_reactions WHERE user_id::text = ANY(${uids})`;
await sql`DELETE FROM channel_members WHERE member_id::text = ANY(${uids})`;
await sql`DELETE FROM notifications WHERE user_id::text = ANY(${uids})`;
await sql`DELETE FROM reminders WHERE owner_id::text = ANY(${uids})`;
await sql`DELETE FROM computers WHERE user_id::text = ANY(${uids})`;
await sql`DELETE FROM machine_tokens WHERE user_id::text = ANY(${uids})`;
await sql`DELETE FROM user_sessions WHERE user_id::text = ANY(${uids})`;
await sql`DELETE FROM agent_credentials WHERE agent_id IN (SELECT id FROM agents WHERE user_id::text = ANY(${uids}))`;
await sql`DELETE FROM agent_logins WHERE agent_id IN (SELECT id FROM agents WHERE user_id::text = ANY(${uids}))`;
await sql`DELETE FROM dispatches WHERE from_agent_id IN (SELECT id FROM agents WHERE user_id::text = ANY(${uids}))
   OR to_agent_id IN (SELECT id FROM agents WHERE user_id::text = ANY(${uids}))`;
await sql`DELETE FROM agents WHERE user_id::text = ANY(${uids})`;
await sql`DELETE FROM server_members WHERE user_id::text = ANY(${uids})`;
// 待删 server 的残留成员行/频道引用已清完（频道在上面按 server 维度删过），删 server 本体
if (doomedServerIds.size) {
  const sids = [...doomedServerIds];
  await sql`DELETE FROM server_members WHERE server_id::text = ANY(${sids})`;
  await sql`DELETE FROM servers WHERE id::text = ANY(${sids})`;
}
await sql`DELETE FROM users WHERE id::text = ANY(${uids})`;
console.log(`[apply] deleted ${users.length} test users, ${doomedServerIds.size} test servers and associated data`);

const left = await sql`
  SELECT count(*)::int AS n FROM users
   WHERE handle LIKE 'zz_test_%' OR handle LIKE 'zz_tenant_%' OR handle LIKE 'zzsched%'
      OR (handle LIKE 'zzp%' AND email LIKE '%@probe.local')`;
console.log(`[verify] remaining test users: ${left[0].n}`);
await sql.end({ timeout: 3 });
