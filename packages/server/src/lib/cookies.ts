import { randomBytes } from "node:crypto";

// 不引第三方 cookie 插件，手工读写 —— 足够覆盖 httpOnly + CSRF double-submit。

export const ACCESS_COOKIE = "access_token";
export const CSRF_COOKIE = "csrf_token";

// 解析 Cookie 头 "a=b; c=d" → { a:b, c:d }
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function newCsrfToken(): string {
  return randomBytes(24).toString("hex");
}

function cookieAttrs(maxAgeSec: number, httpOnly: boolean): string {
  // 本地开发走 http，不能加 Secure（否则浏览器拒收）；生产可由反代加 Secure。
  const attrs = [`Path=/`, `SameSite=Lax`, `Max-Age=${maxAgeSec}`];
  if (httpOnly) attrs.push("HttpOnly");
  return attrs.join("; ");
}

// 登录/注册/刷新后下发：httpOnly 的 access_token + 可被 JS 读取的 csrf_token
export function setAuthCookies(reply: any, accessToken: string, csrf: string, maxAgeSec: number): void {
  reply.header("Set-Cookie", [
    `${ACCESS_COOKIE}=${encodeURIComponent(accessToken)}; ${cookieAttrs(maxAgeSec, true)}`,
    `${CSRF_COOKIE}=${encodeURIComponent(csrf)}; ${cookieAttrs(maxAgeSec, false)}`,
  ]);
}

export function clearAuthCookies(reply: any): void {
  reply.header("Set-Cookie", [
    `${ACCESS_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0; HttpOnly`,
    `${CSRF_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`,
  ]);
}
