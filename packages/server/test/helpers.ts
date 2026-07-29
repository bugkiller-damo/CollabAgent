import postgres from "postgres";

// 注意：BASE_URL 是 Vite/Vitest 的保留变量——vitest worker 会把它覆盖成 "/"（base 配置），
// 导致测试静默打到默认 3001。本地指定非默认端口请用 SLOCK_TEST_BASE_URL（2026-07-29 实测踩坑）。
const RAW_BASE = process.env.SLOCK_TEST_BASE_URL || process.env.BASE_URL;
export const BASE = (RAW_BASE && /^https?:\/\//.test(RAW_BASE) ? RAW_BASE : "http://localhost:3001").replace(/\/+$/, "");
const DB_URL = process.env.DATABASE_URL || "postgresql://postgres:P@ssw0rd@localhost:5432/collabagent";

// 所有测试用户/数据用此前缀，便于精准清理
export const TEST_PREFIX = "zz_test_";
const RUN = TEST_PREFIX + Date.now().toString(36);
let counter = 0;
export function uniqHandle(): string {
  return `${RUN}_${counter++}`;
}

export const sql = postgres(DB_URL, { max: 2 });

interface ApiOpts {
  method?: string;
  body?: unknown;
  token?: string;
  cookie?: string;
  csrf?: string;
}
export interface ApiResult<T = any> {
  status: number;
  data: T;
  setCookie: string[];
  cookieHeader: string;
}

function toCookieHeader(setCookie: string[]): string {
  return setCookie.map((c) => c.split(";")[0]).join("; ");
}

export async function api<T = any>(path: string, opts: ApiOpts = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers["cookie"] = opts.cookie;
  // 纯 Cookie 鉴权：CSRF token 从 cookie 中自动提取（明确传 false/null 表跳过）
  if (opts.csrf !== false && opts.csrf !== null && !opts.csrf && opts.cookie) {
    for (const part of opts.cookie.split(";")) {
      const i = part.indexOf("=");
      if (i < 0) continue;
      if (part.slice(0, i).trim() === "csrf_token") {
        opts.csrf = decodeURIComponent(part.slice(i + 1).trim());
        break;
      }
    }
  }
  if (opts.csrf && opts.csrf !== false && opts.csrf !== null) headers["x-csrf-token"] = opts.csrf;
  const res = await fetch(BASE + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* non-json */ }
  const setCookie = typeof (res.headers as any).getSetCookie === "function"
    ? (res.headers as any).getSetCookie()
    : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie") as string] : []);
  return { status: res.status, data, setCookie, cookieHeader: toCookieHeader(setCookie) };
}

export interface TestUser {
  handle: string;
  userId: string;
  token: string;
  csrf: string;
  cookie: string;
}

export async function registerUser(handle?: string): Promise<TestUser> {
  const h = handle || uniqHandle();
  const r = await api("/api/auth/register", {
    method: "POST",
    body: { email: `${h}@test.local`, handle: h, password: "Test1234" },
  });
  if (r.status !== 200) throw new Error("register failed: " + JSON.stringify(r.data));
  return { handle: h, userId: r.data.user.id, token: r.data.token, csrf: r.data.csrf, cookie: r.cookieHeader };
}

// 精准清理所有 zz_test_ 前缀用户及其关联数据（FK 安全顺序）
export async function cleanupTestData(): Promise<void> {
  const users = await sql`SELECT id FROM users WHERE handle LIKE ${TEST_PREFIX + "%"}`;
  const uids = users.map((r: any) => String(r.id));
  if (uids.length === 0) return;
  const chans = await sql`
    SELECT id FROM channels
     WHERE created_by::text = ANY(${uids})
        OR id IN (SELECT channel_id FROM channel_members WHERE member_id::text = ANY(${uids}))`;
  const cids = chans.map((r: any) => String(r.id));
  if (cids.length) {
    await sql`DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE channel_id::text = ANY(${cids}))`;
    await sql`DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id::text = ANY(${cids}))`;
    await sql`DELETE FROM messages WHERE channel_id::text = ANY(${cids})`;
    await sql`DELETE FROM action_cards WHERE channel_id::text = ANY(${cids})`;
    await sql`DELETE FROM channel_members WHERE channel_id::text = ANY(${cids})`;
    await sql`DELETE FROM channels WHERE id::text = ANY(${cids})`;
  }
  await sql`DELETE FROM messages WHERE sender_id::text = ANY(${uids})`;
  await sql`DELETE FROM message_reactions WHERE user_id::text = ANY(${uids})`;
  await sql`DELETE FROM channel_members WHERE member_id::text = ANY(${uids})`;
  await sql`DELETE FROM reminders WHERE owner_id::text = ANY(${uids})`;
  await sql`DELETE FROM machine_tokens WHERE user_id::text = ANY(${uids})`;
  await sql`DELETE FROM user_sessions WHERE user_id::text = ANY(${uids})`;
  await sql`DELETE FROM agent_credentials WHERE agent_id IN (SELECT id FROM agents WHERE user_id::text = ANY(${uids}))`;
  await sql`DELETE FROM agent_logins WHERE agent_id IN (SELECT id FROM agents WHERE user_id::text = ANY(${uids}))`;
  await sql`DELETE FROM agents WHERE user_id::text = ANY(${uids})`;
  await sql`DELETE FROM server_members WHERE user_id::text = ANY(${uids})`;
  await sql`DELETE FROM servers WHERE created_by::text = ANY(${uids}) OR owner_id::text = ANY(${uids})`;
  await sql`DELETE FROM users WHERE id::text = ANY(${uids})`;
}

export async function closeSql(): Promise<void> {
  await sql.end({ timeout: 5 });
}
