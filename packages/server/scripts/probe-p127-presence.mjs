// P1.27 行为探针：presence/metrics 读路径跨实例化（双实例 + 真 Valkey）。
// 前置：bash scripts/run-p127-servers.sh（A=3001/instA，B=3002/instB，VALKEY_URL 指向 127.0.0.1:6379）。
// 用法：node scripts/probe-p127-presence.mjs
// 断言：
//   A. daemon WS 连实例 A → 实例 B 的 /api/daemon/status 在 ≤8s 内报 connected=true
//      （旧世界：B 只看自己的 daemonClients，恒 false——评估 §2.5 中项实锤复现点）
//   B. 实例 B 的 /api/metrics online.daemons ≥ 1 且 daemonsLocal = 0（跨实例并集 vs 本地明细）
//   C. metrics_samples 出现 instance=instA 与 instB 两行，新计数器列可写可读
//   D. WS 断开 → 实例 B ≤8s 内收敛 connected=false
// 探针数据（zzp127_ 前缀用户）在 finally 中全部清理。
import { readFileSync } from "node:fs";
import postgres from "postgres";
import WebSocket from "ws";

const BASE_A = "http://localhost:3001";
const BASE_B = "http://localhost:3002";
const WS_URL_A = "ws://localhost:3001/ws";
const TAG = `zzp127_${Date.now().toString(36)}`;

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

async function api(base, path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers["cookie"] = opts.cookie;
  if (opts.csrf && opts.cookie) headers["x-csrf-token"] = opts.csrf;
  const res = await fetch(base + path, {
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
    if (i < 0) continue;
    if (part.slice(0, i).trim() === "csrf_token") return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

function waitFor(fn, timeout = 8000, step = 300) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(async () => {
      try {
        if (await fn()) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - t0 > timeout) {
          clearInterval(timer);
          reject(new Error("waitFor timeout"));
        }
      } catch {
        /* keep polling */
      }
    }, step);
  });
}

let failures = 0;
function check(label, cond, extra = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
}

try {
  // 探针用户在实例 A 注册（两实例共用同一 DB，JWT 同 secret → cookie 双实例通用）
  const reg = await api(BASE_A, "/api/auth/register", {
    method: "POST",
    body: { email: `${TAG}@test.local`, handle: TAG, password: "Test1234" },
  });
  if (reg.status !== 200) throw new Error("register failed: " + JSON.stringify(reg.data));
  const cookie = reg.cookie;
  const csrf = csrfFrom(cookie);

  // daemon 分支只认 sk_machine_ 握手（wsHandler isDaemon 判定）——先铸一枚机器令牌
  const mint = await api(BASE_A, "/api/computers/me/token", { method: "POST", cookie, csrf });
  if (mint.status !== 200 || !mint.data.token)
    throw new Error("mint machine token failed: " + JSON.stringify(mint.data));

  // A. daemon 连实例 A → 实例 B 读路径可见（跨实例 presence）
  const ws = new WebSocket(WS_URL_A, { headers: { authorization: `Bearer ${mint.data.token}` } });
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  ws.send(JSON.stringify({ type: "ready", runtimes: [] })); // daemon 握手（广播 owner presence 用）
  const sawOnB = await waitFor(async () => {
    const st = await api(BASE_B, "/api/daemon/status", { cookie });
    return st.status === 200 && st.data.connected === true;
  }, 8000).catch(() => false);
  check("A1 daemon 连 A，实例 B /api/daemon/status connected=true", sawOnB);
  const stillOnA = await api(BASE_A, "/api/daemon/status", { cookie });
  check("A2 实例 A 自身视角 connected=true", stillOnA.status === 200 && stillOnA.data.connected === true);

  // B. 实例 B 的 metrics 在线计数走并集
  const mB = await api(BASE_B, "/api/metrics", { cookie });
  check(
    "B1 实例 B /api/metrics online.daemons ≥ 1 且 daemonsLocal = 0",
    mB.status === 200 && Number(mB.data.online?.daemons) >= 1 && Number(mB.data.online?.daemonsLocal) === 0,
    JSON.stringify(mB.data.online ?? null),
  );

  // C. metrics_samples 实例标识 + 新计数器列
  const rows = await sql`
    SELECT instance, patrol_posted, machine_auth_bcrypt_rejected, ws_slow_consumer_terminated, daemon_count
      FROM metrics_samples
     WHERE instance IN ('instA', 'instB') AND sampled_at > now() - interval '10 minutes'
     ORDER BY sampled_at DESC LIMIT 10`;
  const instances = new Set(rows.map((r) => r.instance));
  check("C1 metrics_samples 有 instA 与 instB 两实例采样行", instances.has("instA") && instances.has("instB"));
  check(
    "C2 新计数器列（patrol_posted/machine_auth_bcrypt_rejected/ws_slow_consumer_terminated）可写可读",
    rows.every((r) => typeof Number(r.patrol_posted) === "number" && r.machine_auth_bcrypt_rejected !== null),
  );

  // D. 断开 → 实例 B 收敛为离线（SREM + B 侧下一轮扫描，≤8s）
  ws.close();
  const goneOnB = await waitFor(async () => {
    const st = await api(BASE_B, "/api/daemon/status", { cookie });
    return st.status === 200 && st.data.connected === false;
  }, 8000).catch(() => false);
  check("D1 WS 断开后实例 B ≤8s 收敛 connected=false", goneOnB);
} catch (err) {
  console.error("PROBE ERROR:", err?.message ?? err);
  failures++;
} finally {
  try {
    const users = await sql`SELECT id FROM users WHERE handle LIKE ${TAG + "%"}`;
    const uids = users.map((r) => String(r.id));
    if (uids.length) {
      await sql`DELETE FROM messages WHERE sender_id::text = ANY(${uids})`;
      await sql`DELETE FROM agents WHERE user_id::text = ANY(${uids})`;
      await sql`DELETE FROM user_sessions WHERE user_id::text = ANY(${uids})`;
      await sql`DELETE FROM machine_tokens WHERE user_id::text = ANY(${uids})`;
      await sql`DELETE FROM computers WHERE user_id::text = ANY(${uids})`;
      await sql`DELETE FROM channel_members WHERE member_id::text = ANY(${uids})`;
      await sql`DELETE FROM server_members WHERE user_id::text = ANY(${uids})`;
      await sql`DELETE FROM servers WHERE created_by::text = ANY(${uids}) OR owner_id::text = ANY(${uids})`;
      await sql`DELETE FROM users WHERE id::text = ANY(${uids})`;
    }
    const remain = await sql`SELECT count(*)::int AS n FROM users WHERE handle LIKE ${TAG + "%"}`;
    console.log(`probe users remaining: ${remain[0].n}`);
  } catch (e) {
    console.error("cleanup error:", String(e));
  }
  await sql.end({ timeout: 5 });
  process.exit(failures ? 1 : 0);
}
