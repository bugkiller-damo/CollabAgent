// P1.23 行为探针：提醒可靠性（认领门控 + 消漂移重排）。
// 前置：NODE_ENV=test 的 server 跑在 3001（test 模式跳过限流），本地 PG 可用。
// 用法：node scripts/probe-p123-reminder.mjs
// 断言：
//   A. owner daemon 在线  → 到期一次性提醒被认领并 fire（WS 收到 reminder.fire）
//   B. owner daemon 离线  → 提醒保持 scheduled（旧代码会标 fired 且静默丢失）
//   C. every:30s 重排锚定原 fire_at（fireCount=2 时 fire_at ≈ 到期时刻 + 60s，无处理延迟累积）
//   D. timezone 显式入库（DTO 回显非空）
// 探针数据（zzp123_ 前缀用户/agent/提醒/令牌）在 finally 中全部清理，无需手动善后。
import { readFileSync } from "node:fs";
import postgres from "postgres";
import WebSocket from "ws";

const BASE = "http://localhost:3001";
const WS_URL = "ws://localhost:3001/ws";
const TAG = `zzp123_${Date.now().toString(36)}`;

// .env 在 packages/server（server 进程 cwd）；与 helpers.ts 同回退
function loadDbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const env = readFileSync(new URL("../.env", import.meta.url), "utf-8");
    const m = /^DATABASE_URL=(.*)$/m.exec(env);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch {
    /* fallthrough */
  }
  return "postgresql://postgres:postgres@localhost:5432/collabagent";
}
const sql = postgres(loadDbUrl(), { max: 2 });

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.cookie) headers["cookie"] = opts.cookie;
  if (opts.csrf && opts.cookie) headers["x-csrf-token"] = opts.csrf;
  const res = await fetch(BASE + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-json */
  }
  const setCookie =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : res.headers.get("set-cookie")
        ? [res.headers.get("set-cookie")]
        : [];
  return { status: res.status, data, cookie: setCookie.map((c) => c.split(";")[0]).join("; ") };
}

function csrfFrom(cookie) {
  for (const part of cookie.split(";")) {
    const i = part.indexOf("=");
    if (i >= 0 && part.slice(0, i).trim() === "csrf_token") return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// 建探针用户 + agent（duty on）+ 机器令牌，返回 {userId, cookie, csrf, agentId, token}
async function makeProbeUser(suffix) {
  const handle = `${TAG}_${suffix}`;
  const r = await api("/api/auth/register", {
    method: "POST",
    body: { email: `${handle}@probe.local`, handle, password: "Probe1234" },
  });
  if (r.status !== 200) throw new Error(`register ${handle} failed: ${JSON.stringify(r.data)}`);
  const cookie = r.cookie;
  const csrf = csrfFrom(cookie);
  const userId = r.data.user.id;
  const name = suffix.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16);
  const a = await api("/api/agents", {
    method: "POST",
    cookie,
    csrf,
    body: { name: `p123${name}`, runtime: "claude", model: "sonnet" },
  });
  if (a.status !== 200) throw new Error(`create agent failed: ${JSON.stringify(a.data)}`);
  const agentId = a.data.agent.id;
  const d = await api(`/api/agents/${agentId}/duty`, { method: "POST", cookie, csrf, body: { duty: "on" } });
  if (d.status !== 200) throw new Error(`duty on failed: ${JSON.stringify(d.data)}`);
  const t = await api("/api/profile/machine-token", { method: "POST", cookie, csrf, body: {} });
  if (t.status !== 200) throw new Error(`machine-token failed: ${JSON.stringify(t.data)}`);
  return { handle, userId, cookie, csrf, agentId, token: t.data.token };
}

const createReminder = (agentId, cookie, csrf, body) =>
  api(`/internal/agent/${agentId}/reminders`, { method: "POST", cookie, csrf, body });

const listReminders = (agentId, cookie) => api(`/internal/agent/${agentId}/reminders?status=all`, { cookie });

async function cleanup(userIds) {
  try {
    if (!userIds.length) return;
    const rows = await sql`SELECT id FROM users WHERE handle LIKE ${TAG + "%"} OR id::text = ANY(${userIds})`;
    const ids = rows.map((r) => String(r.id));
    if (!ids.length) return;
    await sql`DELETE FROM reminder_events WHERE reminder_id IN (SELECT id FROM reminders WHERE owner_id IN (SELECT id FROM agents WHERE user_id::text = ANY(${ids})))`;
    await sql`DELETE FROM reminders WHERE owner_id IN (SELECT id FROM agents WHERE user_id::text = ANY(${ids}))`;
    await sql`DELETE FROM agent_credentials WHERE agent_id IN (SELECT id FROM agents WHERE user_id::text = ANY(${ids}))`;
    await sql`DELETE FROM machine_tokens WHERE user_id::text = ANY(${ids})`;
    await sql`DELETE FROM agents WHERE user_id::text = ANY(${ids})`;
    await sql`DELETE FROM channel_members WHERE member_id::text = ANY(${ids})`;
    await sql`DELETE FROM channels WHERE created_by::text = ANY(${ids})`;
    await sql`DELETE FROM server_members WHERE user_id::text = ANY(${ids})`;
    await sql`DELETE FROM servers WHERE owner_id::text = ANY(${ids}) OR created_by::text = ANY(${ids})`;
    await sql`DELETE FROM user_sessions WHERE user_id::text = ANY(${ids})`;
    await sql`DELETE FROM users WHERE id::text = ANY(${ids})`;
  } catch (err) {
    console.warn(`cleanup warning: ${err.message}（如残留请手动清 ${TAG} 前缀用户）`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const health = await api("/api/health");
  if (health.status !== 200 || health.data?.db !== true) {
    throw new Error(`server on ${BASE} not healthy（需 NODE_ENV=test 起 server）: ${JSON.stringify(health.data)}`);
  }

  const A = await makeProbeUser("a"); // daemon 在线
  const B = await makeProbeUser("b"); // daemon 离线
  const wsFired = []; // 收到的 reminder.fire reminder id

  const ws = new WebSocket(WS_URL, { headers: { authorization: `Bearer ${A.token}` } });
  const wsOpen = new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
    setTimeout(() => reject(new Error("daemon ws connect timeout")), 8000);
  });
  try {
    await wsOpen;
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw));
        if (m?.type === "reminder.fire") wsFired.push(m.reminder?.id);
      } catch {
        /* ignore */
      }
    });

    const due = new Date(Date.now() - 2000).toISOString();
    const a1 = await createReminder(A.agentId, A.cookie, A.csrf, { title: `${TAG}_oneshot_A`, fireAt: due });
    const a2 = await createReminder(A.agentId, A.cookie, A.csrf, {
      title: `${TAG}_repeat_A`,
      repeat: "every:30s",
      fireAt: due,
    });
    const b1 = await createReminder(B.agentId, B.cookie, B.csrf, { title: `${TAG}_oneshot_B`, fireAt: due });
    check(
      "创建探针提醒(A1 one-shot / A2 every:30s / B1 离线 one-shot)",
      a1.status === 200 && a2.status === 200 && b1.status === 200,
    );
    check("D. timezone 显式入库", !!a2.data?.reminder?.timezone, `tz=${a2.data?.reminder?.timezone}`);
    const dueMs = new Date(due).getTime();

    // 轮询到 A2 fireCount>=2（fire1 ~20s 内，重排 +30s，fire2 ~50-70s）
    let a2row = null;
    const deadline = Date.now() + 100000;
    while (Date.now() < deadline) {
      await sleep(5000);
      const list = await listReminders(A.agentId, A.cookie);
      a2row = list.data?.reminders?.find((x) => x.id === a2.data.reminder.id);
      if (a2row && (a2row.fireCount ?? 0) >= 2) break;
    }
    const a1list = await listReminders(A.agentId, A.cookie);
    const a1row = a1list.data?.reminders?.find((x) => x.id === a1.data.reminder.id);
    const blist = await listReminders(B.agentId, B.cookie);
    const b1row = blist.data?.reminders?.find((x) => x.id === b1.data.reminder.id);

    check(
      "A. 在线 owner 的一次性提醒被认领 fire",
      a1row?.status === "fired" && (a1row?.fireCount ?? 0) === 1,
      `status=${a1row?.status} fireCount=${a1row?.fireCount}`,
    );
    check(
      "A'. WS 收到 reminder.fire（含 A1）",
      wsFired.includes(a1.data.reminder.id),
      `fired=${JSON.stringify(wsFired)}`,
    );
    check(
      "C. every:30s 重排锚定原 fire_at（无处理延迟累积）",
      (() => {
        if (!a2row || (a2row.fireCount ?? 0) < 2) return false;
        const expected = dueMs + 30000 * a2row.fireCount;
        const actual = new Date(a2row.fireAt).getTime();
        return Math.abs(actual - expected) < 2500;
      })(),
      a2row ? `fireCount=${a2row.fireCount} fireAt=${a2row.fireAt}` : "no row",
    );
    check("B. 离线 owner 的提醒保持 scheduled（不静默丢）", b1row?.status === "scheduled", `status=${b1row?.status}`);
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    await cleanup([A.userId, B.userId]);
    await sql.end({ timeout: 5 });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? "\nP1.23 probe: ALL PASS" : `\nP1.23 probe: ${failed.length} FAILED`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("probe error:", err.message);
  process.exit(2);
});
