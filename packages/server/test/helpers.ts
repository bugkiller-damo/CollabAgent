import postgres from "postgres";

const RAW_BASE = process.env.BASE_URL;
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
  if (opts.token) headers["authorization"] = "Bearer " + opts.token;
  if (opts.cookie) headers["cookie"] = opts.cookie;
  if (opts.csrf) headers["x-csrf-token"] = opts.csrf;
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
  await sql`DELETE FROM agents WHERE user_id::text = ANY(${uids})`;
  await sql`DELETE FROM users WHERE id::text = ANY(${uids})`;
}

export async function closeSql(): Promise<void> {
  await sql.end({ timeout: 5 });
}
