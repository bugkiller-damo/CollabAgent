// P1.26 行为探针：dispatch 闭环 + 离线黑洞告警。
// 前置：NODE_ENV=test 的 server 跑在 3001（test 模式跳过限流），本地 PG 可用。
// 用法：node scripts/probe-p126-dispatch.mjs
// 断言：
//   A. 经理派发（worker daemon 离线）→ 经理 owner 浏览器 WS 收到
//      agent:delivery-dead-letter（reason="daemon-offline"）告警帧
//   B. dispatch 台账 open + 卡片 in_progress/assignee + task_events created
//   C. worker 回报 → reported + 卡片 in_review
//   D. 验收闭环：completed + completed_at + 卡片 done + 重复验收 404
//   E. 人工经 /api/tasks/update-status 置 done → linked dispatch 回向 completed；
//      置 closed → cancelled（双向同步另一半）
//   F. GET /dispatches status=completed 过滤与 completed_at 回显
//   G. 非经理派发 403 / worker 验收 404
// 探针数据（zzp126_ 前缀用户/agent/频道）在 finally 中全部清理，无需手动善后。
import { readFileSync } from "node:fs";
import postgres from "postgres";
import WebSocket from "ws";

const BASE = "http://localhost:3001";
const WS_URL = "ws://localhost:3001/ws";
const TAG = `zzp126_${Date.now().toString(36)}`;

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
    if (i < 0) continue;
    if (part.slice(0, i).trim() === "csrf_token") return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

function collectWs(cookie) {
  const ws = new WebSocket(WS_URL, { headers: { cookie } });
  const queue = [];
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg?.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (msg?.type === "connected") return;
      queue.push(msg);
    } catch {
      /* ignore */
    }
  });
  ws.on("error", () => {});
  return {
    queue,
    nextOfType(type, timeout = 8000) {
      return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const timer = setInterval(() => {
          const i = queue.findIndex((m) => m?.type === type);
          if (i >= 0) {
            clearInterval(timer);
            resolve(queue.splice(i, 1)[0]);
          } else if (Date.now() - t0 > timeout) {
            clearInterval(timer);
            reject(new Error(`WS ${type} timeout; queue types=${queue.map((m) => m?.type).join(",")}`));
          }
        }, 50);
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}

let failures = 0;
function check(label, cond, extra = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
}

try {
  // ── 数据准备 ─────────────────────────────────────────────
  const mgr = await api("/api/auth/register", {
    method: "POST",
    body: { email: `${TAG}_m@test.local`, handle: `${TAG}_m`, password: "Test1234" },
  });
  const wrk = await api("/api/auth/register", {
    method: "POST",
    body: { email: `${TAG}_w@test.local`, handle: `${TAG}_w`, password: "Test1234" },
  });
  const mgrCsrf = csrfFrom(mgr.cookie);
  const wrkCsrf = csrfFrom(wrk.cookie);

  const mkAgent = async (user, csrf, name) => {
    const r = await api("/api/agents", {
      method: "POST",
      cookie: user.cookie,
      csrf,
      body: { name, displayName: name },
    });
    if (r.status !== 200) throw new Error("create agent failed: " + JSON.stringify(r.data));
    return r.data.agent;
  };
  const managerAgent = await mkAgent(mgr, mgrCsrf, `${TAG}_mgr`);
  const workerAgent = await mkAgent(wrk, wrkCsrf, `${TAG}_wrk`);

  const ch = await api("/api/channels", {
    method: "POST",
    cookie: mgr.cookie,
    csrf: mgrCsrf,
    body: { name: `${TAG}_ch`, type: "public" },
  });
  if (ch.status !== 200) throw new Error("create channel failed: " + JSON.stringify(ch.data));
  const channelId = ch.data.channel.id;
  const channelName = `${TAG}_ch`;

  await sql`INSERT INTO channel_members (channel_id, member_id, member_type, role)
            VALUES (${channelId}::uuid, ${managerAgent.id}::uuid, 'agent', 'member'),
                   (${channelId}::uuid, ${workerAgent.id}::uuid, 'agent', 'member')
            ON CONFLICT DO NOTHING`;
  await sql`UPDATE channel_members SET is_manager = true
             WHERE channel_id = ${channelId}::uuid AND member_id = ${managerAgent.id}::uuid AND member_type = 'agent'`;

  const dispatch = (text) =>
    api(`/internal/agent/${managerAgent.id}/dispatch`, {
      method: "POST",
      cookie: mgr.cookie,
      csrf: mgrCsrf,
      body: { channel: channelName, toAgent: workerAgent.name, text },
    });

  // ── A. 离线告警 + 派发建卡 ──────────────────────────────
  const collector = collectWs(mgr.cookie);
  await new Promise((r) => setTimeout(r, 400)); // WS 握手窗口
  const d1 = await dispatch("修复登录页样式");
  check("A1 派发 200", d1.status === 200, d1.status !== 200 ? JSON.stringify(d1.data) : "");
  if (d1.status !== 200) throw new Error("dispatch failed: " + JSON.stringify(d1.data));
  const alarm = await collector.nextOfType("agent:delivery-dead-letter");
  check(
    "A2 worker daemon 离线告警（dead-letter 同款 reason=daemon-offline）",
    alarm?.reason === "daemon-offline" && alarm?.agentName === workerAgent.name,
    JSON.stringify(alarm ?? null).slice(0, 200),
  );

  // ── B. 台账 + 卡片 + 事件 ───────────────────────────────
  const row1 = await sql`SELECT status, task_message_id FROM dispatches WHERE id = ${d1.data.dispatch.id}::uuid`;
  check("B1 台账 open + task_message_id 关联", row1[0]?.status === "open" && !!row1[0]?.task_message_id);
  const card1 =
    await sql`SELECT task_number, task_status, task_assignee FROM messages WHERE id = ${row1[0].task_message_id}`;
  check(
    "B2 卡片 in_progress + assignee=worker",
    card1[0]?.task_status === "in_progress" && String(card1[0]?.task_assignee ?? "") === workerAgent.id,
    `task_number=${card1[0]?.task_number}`,
  );
  const ev1 = await sql`SELECT action, to_status FROM task_events WHERE message_id = ${row1[0].task_message_id}`;
  check(
    "B3 created 事件",
    ev1.some((e) => e.action === "created" && e.to_status === "in_progress"),
  );

  // ── C. 回报 ─────────────────────────────────────────────
  const rep = await api(`/internal/agent/${workerAgent.id}/dispatch/${d1.data.dispatch.id}/report`, {
    method: "POST",
    cookie: wrk.cookie,
    csrf: wrkCsrf,
    body: { reportText: "已完成，请验收" },
  });
  check("C1 回报 200", rep.status === 200, rep.status !== 200 ? JSON.stringify(rep.data) : "");
  const row2 = await sql`SELECT status, report_text FROM dispatches WHERE id = ${d1.data.dispatch.id}::uuid`;
  check("C2 reported + report_text", row2[0]?.status === "reported" && row2[0]?.report_text === "已完成，请验收");
  const card2 = await sql`SELECT task_status FROM messages WHERE id = ${row1[0].task_message_id}`;
  check("C3 卡片 in_review", card2[0]?.task_status === "in_review");
  const mAlarm = await collector.nextOfType("agent:delivery-dead-letter").catch(() => null);
  check(
    "C4 经理 daemon 离线告警（回报不会唤醒经理 agent）",
    mAlarm?.reason === "daemon-offline" && mAlarm?.agentName === managerAgent.name,
    JSON.stringify(mAlarm ?? null).slice(0, 200),
  );

  // ── D. 验收闭环 ─────────────────────────────────────────
  const acc = await api(`/internal/agent/${managerAgent.id}/dispatch/${d1.data.dispatch.id}/accept`, {
    method: "POST",
    cookie: mgr.cookie,
    csrf: mgrCsrf,
    body: { note: "干得漂亮" },
  });
  check("D1 验收 200", acc.status === 200, acc.status !== 200 ? JSON.stringify(acc.data) : "");
  const row3 = await sql`SELECT status, completed_at FROM dispatches WHERE id = ${d1.data.dispatch.id}::uuid`;
  check("D2 completed + completed_at", row3[0]?.status === "completed" && !!row3[0]?.completed_at);
  const card3 = await sql`SELECT task_status FROM messages WHERE id = ${row1[0].task_message_id}`;
  check("D3 卡片 done", card3[0]?.task_status === "done");
  const acc2 = await api(`/internal/agent/${managerAgent.id}/dispatch/${d1.data.dispatch.id}/accept`, {
    method: "POST",
    cookie: mgr.cookie,
    csrf: mgrCsrf,
    body: {},
  });
  check("D4 重复验收 404", acc2.status === 404, `got ${acc2.status}`);

  // ── E. 回向同步 ─────────────────────────────────────────
  const d2 = await dispatch("人工 done");
  const dm2 = await sql`SELECT task_message_id FROM dispatches WHERE id = ${d2.data.dispatch.id}::uuid`;
  const c2 = await sql`SELECT task_number FROM messages WHERE id = ${dm2[0].task_message_id}`;
  const upd1 = await api("/api/tasks/update-status", {
    method: "POST",
    cookie: mgr.cookie,
    csrf: mgrCsrf,
    body: { channel: channelName, number: c2[0].task_number, status: "done" },
  });
  check("E1 人工置 done 200", upd1.status === 200, upd1.status !== 200 ? JSON.stringify(upd1.data) : "");
  const row4 = await sql`SELECT status, completed_at FROM dispatches WHERE id = ${d2.data.dispatch.id}::uuid`;
  check("E2 dispatch 回向 completed", row4[0]?.status === "completed" && !!row4[0]?.completed_at);

  const d3 = await dispatch("人工 closed");
  const dm3 = await sql`SELECT task_message_id FROM dispatches WHERE id = ${d3.data.dispatch.id}::uuid`;
  const c3 = await sql`SELECT task_number FROM messages WHERE id = ${dm3[0].task_message_id}`;
  const upd2 = await api("/api/tasks/update-status", {
    method: "POST",
    cookie: mgr.cookie,
    csrf: mgrCsrf,
    body: { channel: channelName, number: c3[0].task_number, status: "closed" },
  });
  check("E3 人工置 closed 200", upd2.status === 200, upd2.status !== 200 ? JSON.stringify(upd2.data) : "");
  const row5 = await sql`SELECT status, cancelled_at FROM dispatches WHERE id = ${d3.data.dispatch.id}::uuid`;
  check("E4 dispatch 回向 cancelled", row5[0]?.status === "cancelled" && !!row5[0]?.cancelled_at);

  // ── F. GET 过滤与回显 ───────────────────────────────────
  const lst = await api(`/internal/agent/${managerAgent.id}/dispatches?channel=${channelName}&status=completed`, {
    cookie: mgr.cookie,
  });
  const completed = (lst.data.dispatches ?? []).filter((x) => x.status === "completed");
  check(
    "F1 GET status=completed 过滤 + completed_at 回显",
    lst.status === 200 && completed.length >= 2 && completed.every((x) => x.completed_at),
  );

  // ── G. 负路径速查 ───────────────────────────────────────
  const rej = await api(`/internal/agent/${workerAgent.id}/dispatch`, {
    method: "POST",
    cookie: wrk.cookie,
    csrf: wrkCsrf,
    body: { channel: channelName, toAgent: managerAgent.name, text: "反向派发" },
  });
  check("G1 非经理派发 403", rej.status === 403, `got ${rej.status}`);
  const accByWorker = await api(`/internal/agent/${workerAgent.id}/dispatch/${d1.data.dispatch.id}/accept`, {
    method: "POST",
    cookie: wrk.cookie,
    csrf: wrkCsrf,
    body: {},
  });
  check("G2 worker 验收 404", accByWorker.status === 404, `got ${accByWorker.status}`);

  collector.close();
} catch (err) {
  console.error("PROBE ERROR:", err?.message ?? err);
  failures++;
} finally {
  // ── 清理（FK 安全顺序）──────────────────────────────────
  try {
    const users = await sql`SELECT id FROM users WHERE handle LIKE ${TAG + "%"}`;
    const uids = users.map((r) => String(r.id));
    if (uids.length) {
      const chans = await sql`
        SELECT id FROM channels WHERE created_by::text = ANY(${uids})
          OR id IN (SELECT channel_id FROM channel_members WHERE member_id::text = ANY(${uids}))`;
      const cids = chans.map((r) => String(r.id));
      if (cids.length) {
        await sql`DELETE FROM task_events WHERE channel_id::text = ANY(${cids})`;
        await sql`DELETE FROM dispatches WHERE channel_id::text = ANY(${cids})`;
        await sql`DELETE FROM messages WHERE channel_id::text = ANY(${cids})`;
        await sql`DELETE FROM channel_members WHERE channel_id::text = ANY(${cids})`;
        await sql`DELETE FROM channels WHERE id::text = ANY(${cids})`;
      }
      await sql`DELETE FROM dispatches WHERE from_agent_id IN (SELECT id FROM agents WHERE user_id::text = ANY(${uids}))
         OR to_agent_id IN (SELECT id FROM agents WHERE user_id::text = ANY(${uids}))`;
      await sql`DELETE FROM task_events WHERE message_id IN (SELECT id FROM messages WHERE sender_id::text = ANY(${uids}))`;
      await sql`DELETE FROM messages WHERE sender_id::text = ANY(${uids})`;
      await sql`DELETE FROM agents WHERE user_id::text = ANY(${uids})`;
      await sql`DELETE FROM user_sessions WHERE user_id::text = ANY(${uids})`;
      await sql`DELETE FROM machine_tokens WHERE user_id::text = ANY(${uids})`;
      await sql`DELETE FROM computers WHERE user_id::text = ANY(${uids})`;
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
