import { randomBytes } from "node:crypto";

import { config } from "./config.js";

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

/**
 * P1.17：Cookie Secure 属性由应用层判定——COOKIE_SECURE 显式配置优先（解析见
 * lib/config.ts parseCookieSecure），缺省 auto = NODE_ENV=production 时开启。
 * 此前「永不设 Secure、依赖反代改写」，部署疏漏即凭据明文传输；本地 http 开发
 * （auto + 非 production）不受影响。
 */
function secureEnabled(): boolean {
  return config.COOKIE_SECURE === "auto" ? process.env.NODE_ENV === "production" : config.COOKIE_SECURE;
}

function cookieAttrs(maxAgeSec: number, httpOnly: boolean): string {
  const attrs = [`Path=/`, `SameSite=Lax`, `Max-Age=${maxAgeSec}`];
  if (httpOnly) attrs.push("HttpOnly");
  if (secureEnabled()) attrs.push("Secure");
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
  // 清除与下发保持同属性（Secure 与否一致，避免跨属性清除失效的边界）
  const s = secureEnabled() ? "; Secure" : "";
  reply.header("Set-Cookie", [
    `${ACCESS_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0; HttpOnly${s}`,
    `${CSRF_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0${s}`,
  ]);
}
