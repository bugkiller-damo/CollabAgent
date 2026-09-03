import { promises as dns } from "node:dns";
import type { FastifyInstance } from "fastify";

// 阻止访问内网/本地地址，降低 SSRF 风险。两层防御：
// ① 主机名层 isBlockedHost：localhost/.local 字面值 + IP 字面量判段（上游 WHATWG URL 已把
//    十进制/十六进制 IPv4 归一化为点分形式；本层负责剥 IPv6 方括号、尾点 FQDN、IPv4-mapped
//    IPv6 如 ::ffff:127.0.0.1）；
// ② 解析/跳转层 fetchWithSsrfGuard：域名 DNS 解析后逐地址判段（A/AAAA 直指内网拦截），
//    redirect:"manual" 每一跳重新过 ①②（302 跳内网拦截）。
// P1.28：isBlockedHost/metaContent/decodeEntities 导出供离线单测；剥 IPv6 方括号。
// P1.29：redirect 逐跳复查 + 最终 IP 段校验（isBlockedIp / fetchWithSsrfGuard）。

// 严格点分十进制 IPv4 → 4 个八位组；其余（非数字/超界/段数不符）返回 null。
// 调用点上游已经 WHATWG URL 归一化（"2130706433"/"0x7f.1" → "127.0.0.1"），无需兼容异形。
function parseIpv4(h: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return octets.every((n) => n <= 255) ? (octets as [number, number, number, number]) : null;
}

// 解析 IPv6（含 :: 压缩与尾部点分 IPv4 写法，如 ::ffff:127.0.0.1）→ 8 个 16 位组；非法返回 null
function parseIpv6(input: string): number[] | null {
  let s = input.toLowerCase();
  if (s.includes(".")) {
    // 尾部 32 位允许点分 IPv4 写法——拆出来换算成两个 16 位组再接回
    const i = s.lastIndexOf(":");
    if (i < 0) return null;
    const v4 = parseIpv4(s.slice(i + 1));
    if (!v4) return null;
    s = `${s.slice(0, i)}:${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/.test(s)) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (g: string): number[] | null => {
    if (g === "") return [];
    const out: number[] = [];
    for (const p of g.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
      out.push(Number.parseInt(p, 16));
    }
    return out;
  };
  const left = parseGroups(halves[0]);
  const right = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (!left || !right) return null;
  if (halves.length === 2) {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null; // "::" 必须至少压缩掉一组
    return [...left, ...Array<number>(missing).fill(0), ...right];
  }
  return left.length === 8 ? left : null;
}

// IPv4 段判定：内网/回环/链路本地/CGNAT/协议保留/文档段/组播/未分配保留段全拦
function isBlockedIpv4([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8「本网络」（含 0.0.0.0）
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // 回环
  if (a === 169 && b === 254) return true; // 链路本地（云厂商 metadata 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10（运营商内网）
  if (a === 192 && b === 0 && c === 0) return true; // IETF 协议分配 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1（文档段，无合法抓取目标）
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 组播 + 240.0.0.0/4 保留（含 255.255.255.255）
  return false;
}

// P1.29：最终 IP 段校验（DNS 解析结果、IPv6 字面量走这里；hostname 层请用 isBlockedHost）。
// 解析不出合法 IP 的输入保守拦截（fail-closed：判不出即不可信——dns.lookup 正常不会返回非法值）。
export function isBlockedIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return isBlockedIpv4(v4);
  const v6 = parseIpv6(ip);
  if (!v6) return true;
  // IPv4-mapped（::ffff:a.b.c.d）与已废弃的 IPv4-compatible（::a.b.c.d）统一抽出内嵌 IPv4
  // 按 v4 段判定——P1.29 点名的解析层绕过（::ffff:127.0.0.1 字面量/DNS AAAA 回包）。
  // :: 与 ::1 经此分支落 0.0.0.0/0.0.0.1 → 0/8 拦截，无需单列。
  if (v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && (v6[5] === 0xffff || v6[5] === 0)) {
    return isBlockedIpv4([(v6[6] >> 8) & 0xff, v6[6] & 0xff, (v6[7] >> 8) & 0xff, v6[7] & 0xff]);
  }
  if ((v6[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA（私有编址）
  if ((v6[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((v6[0] & 0xff00) === 0xff00) return true; // ff00::/8 组播
  if (v6[0] === 0x64 && v6[1] === 0xff9b && v6[2] === 0 && v6[3] === 0 && v6[4] === 0) return true; // 64:ff9b::/96 NAT64 WKP（内嵌 v4 可为内网）
  if (v6[0] === 0x2001 && v6[1] === 0x0db8) return true; // 2001:db8::/32 文档段
  return false;
}

export function isBlockedHost(hostname: string): boolean {
  // URL.hostname 对 IPv6 字面量带方括号（new URL("http://[::1]/").hostname === "[::1]"）
  // ——不剥括号则精确比较永不命中（P1.28 测试实锤的绕过）。
  // 尾点 FQDN（"localhost."）剥尾点——URL 保留尾点，不剥则绕过 localhost/.local 字面值判定。
  const h = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (h === "localhost" || h.endsWith(".local")) return true;
  // IP 字面量直接判段（P1.29 起含 IPv4-mapped IPv6；域名须先经 DNS 解析判段，见 fetchWithSsrfGuard）
  if (parseIpv4(h) || parseIpv6(h)) return isBlockedIp(h);
  return false;
}

// P1.28：导出供离线单测（og/twitter/title 元信息提取）
export function metaContent(html: string, ...names: string[]): string | undefined {
  for (const name of names) {
    // 兼容 property= 和 name=，属性顺序任意
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`,
      "i",
    );
    const tag = html.match(re)?.[0];
    if (tag) {
      const c = tag.match(/content=["']([^"']*)["']/i)?.[1];
      if (c) return decodeEntities(c);
    }
  }
  return undefined;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

// ---------- P1.29：SSRF 防护抓取（redirect 逐跳复查 + DNS 解析判段） ----------

// 命中内网/协议拦截时抛出——路由层映射 400；其余抓取失败（网络/解析/跳数超限）归 502
export class SsrfBlockedError extends Error {
  constructor(message = "blocked host") {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

type LookupFn = (hostname: string) => Promise<Array<{ address: string }>>;

// all:true 取全部地址逐一判段（任一命中即拦——fetch 可能取任一）
const defaultLookup: LookupFn = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

export interface SsrfGuardOptions {
  fetchImpl?: typeof fetch; // 测试注入假 fetch（离线确定性）
  lookupImpl?: LookupFn; // 测试注入假 DNS
  maxRedirects?: number; // 允许跟随的 3xx 次数上限，默认 5
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

// 每一跳重新校验协议/主机名黑名单/DNS 解析 IP，消除「公网 URL 302 跳内网」与
// 「域名 A/AAAA 记录直指内网」两条绕过（redirect:"follow" 时代的核心缺口）。
// 取舍立此存照：check-then-fetch 两次解析之间存在 TOCTOU 竞态窗口（攻击者控制权威 DNS
// 且 TTL=0 时，复查解析与 fetch 实际解析可能不同——DNS rebinding 动态形态）；彻底消除需
// 连接级 IP 钉死（自定义 undici dispatcher），当前量级按文档化残余风险接受。
export async function fetchWithSsrfGuard(startUrl: URL, opts: SsrfGuardOptions = {}) {
  const doFetch = opts.fetchImpl ?? fetch;
  const lookup = opts.lookupImpl ?? defaultLookup;
  const maxRedirects = opts.maxRedirects ?? 5;
  let current = startUrl;
  let redirects = 0;
  for (;;) {
    await assertUrlAllowed(current, lookup);
    const res = await doFetch(current.toString(), {
      signal: opts.signal,
      redirect: "manual",
      headers: opts.headers ?? {},
    });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return { res, finalUrl: current }; // 无 Location 的 3xx 按最终响应处理
    // 未消费 body 会占住连接池——跟随前取消
    await res.body?.cancel().catch(() => {});
    if (++redirects > maxRedirects) throw new Error("too many redirects");
    // 相对 Location 按当前跳解析；畸形 Location 构造失败抛错 → 路由层归 502
    current = new URL(location, current);
  }
}

async function assertUrlAllowed(url: URL, lookup: LookupFn): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfBlockedError(`unsupported protocol: ${url.protocol}`);
  }
  if (isBlockedHost(url.hostname)) throw new SsrfBlockedError();
  const h = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (parseIpv4(h) || parseIpv6(h)) return; // IP 字面量无需 DNS（isBlockedHost 已判段）
  // 域名解析后逐地址判段——任一地址命中内网即整域拦截（fail-closed，fetch 可能取任一地址）
  const addrs = await lookup(h);
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new SsrfBlockedError();
  }
}

export async function previewRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { url } = req.query as Record<string, string>;
    if (!url) return reply.status(400).send({ error: "url required" });
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return reply.status(400).send({ error: "invalid url" });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return reply.status(400).send({ error: "unsupported protocol" });
    }
    if (isBlockedHost(parsed.hostname)) {
      return reply.status(400).send({ error: "blocked host" });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000); // 整条跳转链共享 5s 预算
    try {
      const { res, finalUrl } = await fetchWithSsrfGuard(parsed, {
        signal: controller.signal,
        headers: { "User-Agent": "CollabAgent-LinkPreview/1.0" },
      });
      const ct = res.headers.get("content-type") || "";
      // 图片直链：直接当作图片预览
      if (ct.startsWith("image/")) {
        return { url: finalUrl.toString(), image: finalUrl.toString(), title: finalUrl.hostname };
      }
      if (!ct.includes("text/html")) {
        return { url: finalUrl.toString(), title: finalUrl.hostname };
      }
      // 仅读取前 256KB，避免大页面
      const buf = await res.arrayBuffer();
      const html = Buffer.from(buf.slice(0, 256 * 1024)).toString("utf8");
      const title =
        metaContent(html, "og:title", "twitter:title") ||
        decodeEntities(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || "") ||
        finalUrl.hostname;
      const description = metaContent(html, "og:description", "twitter:description", "description");
      let image = metaContent(html, "og:image", "twitter:image");
      if (image && image.startsWith("/")) image = finalUrl.origin + image;
      const siteName = metaContent(html, "og:site_name") || finalUrl.hostname;
      // url/相对 og:image 以最终跳为准（经跳转的目标才是真实内容源）
      return { url: finalUrl.toString(), title, description, image, siteName };
    } catch (err) {
      // 拦截（内网/协议）→ 400 与初始主机名黑名单同文案；其余（网络/解析/跳数/中止）→ 502
      if (err instanceof SsrfBlockedError) {
        return reply.status(400).send({ error: "blocked host" });
      }
      return reply.status(502).send({ error: "failed to fetch preview" });
    } finally {
      clearTimeout(timer);
    }
  });
}
