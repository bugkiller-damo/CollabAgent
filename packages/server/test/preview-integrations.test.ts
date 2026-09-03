import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decodeEntities,
  fetchWithSsrfGuard,
  isBlockedHost,
  isBlockedIp,
  metaContent,
  SsrfBlockedError,
} from "../src/routes/preview.js";
import { api, cleanupTestData, closeSql, registerUser, sql, type TestUser } from "./helpers.js";

// P1.28：preview（SSRF 面，评估零覆盖清单 ②）+ integrations（纯 stub）测试。
// preview 的抓取侧：确定性分支（参数/协议/黑名单）走真路由；元信息提取与黑名单矩阵
// 走纯函数（preview.ts 的 helpers 已导出）；真外网抓取不进测试面（离线不可跑/网络抖动）。
// P1.29：redirect 逐跳复查 + 最终 IP 段校验已落地——fetchWithSsrfGuard 以注入假
// fetch/lookup 的方式离线直测（路由级只测字面量分支：本机/内网全被黑名单挡，无法构造
// 路由内可达的跳转 fixture）。

let user: TestUser;

beforeAll(async () => {
  user = await registerUser();
});

afterAll(async () => {
  await cleanupTestData();
  await closeSql();
});

describe("preview 路由：确定性分支", () => {
  it("400 缺 url / 400 非法 url / 400 非 http(s) 协议", async () => {
    expect((await api("/api/preview", { cookie: user.cookie })).status).toBe(400);
    expect((await api("/api/preview?url=not%20a%20url%20%25", { cookie: user.cookie })).status).toBe(400);
    expect((await api("/api/preview?url=ftp://example.com/x", { cookie: user.cookie })).status).toBe(400);
  });

  it("400 内网/本机黑名单（路由级 SSRF 拒绝）", async () => {
    const blocked = [
      "http://localhost/x",
      "http://127.0.0.1:3001/x",
      "http://10.1.2.3/",
      "http://192.168.0.10/",
      "http://169.254.169.254/meta", // 云厂商 metadata 端点
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://0.0.0.0/",
      "http://[::1]/",
      "http://intranet.local/",
    ];
    for (const url of blocked) {
      const r = await api(`/api/preview?url=${encodeURIComponent(url)}`, { cookie: user.cookie });
      expect(r.status, url).toBe(400);
      expect(r.data.error).toBe("blocked host");
    }
  });

  it("WHATWG URL IPv4 归一化不绕过黑名单（2130706433 = 127.0.0.1 十进制）", async () => {
    // new URL 把纯数字 host 归一化为点分 IPv4 → isBlockedHost 命中 127. 段
    expect(new URL("http://2130706433/").hostname).toBe("127.0.0.1");
    const r = await api(`/api/preview?url=${encodeURIComponent("http://2130706433/")}`, { cookie: user.cookie });
    expect(r.status).toBe(400);
  });

  it("400 P1.29 解析层字面量：IPv4-mapped IPv6 / 尾点 FQDN / CGNAT / v6 链路本地+ULA", async () => {
    const blocked = [
      "http://[::ffff:127.0.0.1]/", // URL 归一化为 [::ffff:7f00:1]，抽出内嵌 v4 判段
      "http://[::ffff:7f00:1]/",
      "http://[::ffff:a00:1]/", // ::ffff:10.0.0.1
      "http://[fe80::1]/", // v6 链路本地
      "http://[fd00::1]/", // v6 ULA
      "http://localhost./", // 尾点 FQDN（不剥尾点绕过 localhost 字面值判定）
      "http://foo.local./",
      "http://100.64.0.1/", // CGNAT 100.64.0.0/10
      "http://0.0.0.1/", // 0.0.0.0/8（P1.28 仅拦精确 0.0.0.0）
    ];
    for (const url of blocked) {
      const r = await api(`/api/preview?url=${encodeURIComponent(url)}`, { cookie: user.cookie });
      expect(r.status, url).toBe(400);
      expect(r.data.error).toBe("blocked host");
    }
  });

  it("502 不可解析主机（RFC 6761 .invalid 保证 NXDOMAIN → fetch 抛错）", async () => {
    const r = await api(`/api/preview?url=${encodeURIComponent("http://zz-slock-preview-invalid.invalid/")}`, {
      cookie: user.cookie,
    });
    expect(r.status).toBe(502);
  });
});

describe("preview 纯函数：黑名单矩阵 + 元信息提取", () => {
  it("isBlockedHost：全内网段命中；公网/段外放行", () => {
    expect(isBlockedHost("localhost")).toBe(true);
    expect(isBlockedHost("LOCALHOST")).toBe(true); // 大小写不敏感
    expect(isBlockedHost("printer.local")).toBe(true);
    expect(isBlockedHost("127.0.0.1")).toBe(true);
    expect(isBlockedHost("10.255.0.1")).toBe(true);
    expect(isBlockedHost("192.168.1.1")).toBe(true);
    expect(isBlockedHost("169.254.1.1")).toBe(true);
    for (const h of ["172.16.0.1", "172.20.9.9", "172.31.255.255"]) expect(isBlockedHost(h), h).toBe(true);
    expect(isBlockedHost("0.0.0.0")).toBe(true);
    expect(isBlockedHost("::1")).toBe(true);
    // 段外/公网不拦（否则正常预览全废）
    expect(isBlockedHost("example.com")).toBe(false);
    expect(isBlockedHost("8.8.8.8")).toBe(false);
    expect(isBlockedHost("172.32.0.1")).toBe(false); // 172.16-31 之外
    expect(isBlockedHost("172.15.0.1")).toBe(false);
    expect(isBlockedHost("11.0.0.1")).toBe(false);
  });

  it("metaContent：og:title / twitter:title 回退链、property= 与 name= 兼容、实体解码", () => {
    const html = [
      "<html><head>",
      '<meta property="og:title" content="Hello &amp; World">',
      '<meta name="twitter:description" content="A &lt;test&gt; page">',
      '<meta name="description" content="fallback desc">',
      '<meta property="og:image" content="/img/cover.png">',
      '<meta property="og:site_name" content="Example">',
      "</head></html>",
    ].join("");
    expect(metaContent(html, "og:title", "twitter:title")).toBe("Hello & World");
    expect(metaContent(html, "twitter:description", "description")).toBe("A <test> page");
    expect(metaContent(html, "description")).toBe("fallback desc");
    expect(metaContent(html, "og:image")).toBe("/img/cover.png");
    expect(metaContent(html, "og:site_name")).toBe("Example");
    expect(metaContent(html, "og:missing")).toBeUndefined();
    expect(metaContent("<p>no meta</p>", "og:title")).toBeUndefined();
  });

  it("decodeEntities：实体变体", () => {
    expect(decodeEntities("&amp;&lt;&gt;&quot;&#39;&#x27;")).toBe(`&<>"''`);
    expect(decodeEntities("plain")).toBe("plain");
  });
});

describe("preview 纯函数：isBlockedIp 段矩阵（P1.29）", () => {
  it("IPv4：内网/回环/链路本地/CGNAT/协议保留/文档段/组播/保留段全命中；公网与段外放行", () => {
    const blocked = [
      "0.0.0.0",
      "0.1.2.3", // 0/8 整段（P1.28 仅拦精确 0.0.0.0）
      "10.0.0.1",
      "10.255.255.255",
      "100.64.0.0",
      "100.127.255.255", // CGNAT /10 边界
      "127.0.0.1",
      "127.53.0.1",
      "169.254.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1", // IETF 协议分配
      "192.0.2.1", // TEST-NET-1
      "192.168.0.1",
      "198.18.0.1",
      "198.19.255.1", // 基准测试 /15 边界
      "198.51.100.1", // TEST-NET-2
      "203.0.113.9", // TEST-NET-3
      "224.0.0.1", // 组播
      "240.0.0.1", // 保留
      "255.255.255.255",
    ];
    for (const ip of blocked) expect(isBlockedIp(ip), ip).toBe(true);
    const allowed = [
      "1.1.1.1",
      "8.8.8.8",
      "100.63.255.255", // CGNAT 下界之外
      "100.128.0.0", // CGNAT 上界之外
      "172.15.0.1",
      "172.32.0.1",
      "192.0.1.1",
      "192.0.3.1",
      "198.17.0.1",
      "198.20.0.1",
      "223.255.255.255",
    ];
    for (const ip of allowed) expect(isBlockedIp(ip), ip).toBe(false);
  });

  it("IPv6：回环/未指定/ULA/链路本地/组播/NAT64/文档段命中；IPv4-mapped 按内嵌 v4 判定", () => {
    const blocked = [
      "::1",
      "::",
      "0:0:0:0:0:0:0:1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "febf::ffff", // fe80::/10 上界
      "ff02::1",
      "64:ff9b::7f00:1", // NAT64 WKP 内嵌 127.0.0.1
      "2001:db8::1", // 文档段
      "::ffff:127.0.0.1", // IPv4-mapped（点分尾部写法）
      "::ffff:7f00:1", // 同上，纯十六进制（WHATWG URL 归一化后形态）
      "::ffff:10.0.0.1",
      "::ffff:169.254.169.254", // mapped 云 metadata
      "::127.0.0.1", // IPv4-compatible（已废弃写法）
    ];
    for (const ip of blocked) expect(isBlockedIp(ip), ip).toBe(true);
    const allowed = [
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
      "::ffff:8.8.8.8", // mapped 公网放行
      "2001:db9::1", // 文档段之外
      "fe7f::1", // fe80::/10 下界之外
    ];
    for (const ip of allowed) expect(isBlockedIp(ip), ip).toBe(false);
  });

  it("非法字符串保守拦截（fail-closed：判不出即不可信）", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
    expect(isBlockedIp("999.1.1.1")).toBe(true);
    expect(isBlockedIp("1:2:3:4:5:6:7:8:9")).toBe(true); // 9 组 v6 非法
    expect(isBlockedIp("")).toBe(true);
  });

  it("isBlockedHost 扩展：IPv4-mapped/尾点 FQDN/大小写/CGNAT", () => {
    expect(isBlockedHost("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedHost("[::ffff:7f00:1]")).toBe(true); // 方括号 + mapped
    expect(isBlockedHost("LOCALHOST.")).toBe(true); // 尾点 + 大小写
    expect(isBlockedHost("foo.local.")).toBe(true);
    expect(isBlockedHost("100.64.0.1")).toBe(true);
    expect(isBlockedHost("100.63.0.1")).toBe(false);
    expect(isBlockedHost("example.com.")).toBe(false);
    expect(isBlockedHost("[2606:4700:4700::1111]")).toBe(false);
  });
});

// fetchWithSsrfGuard 离线直测：注入假 fetch/lookup（真外网抓取不进测试面——
// 本机/内网全被黑名单挡，无法构造路由内可达的跳转 fixture；假注入反而更确定）。
describe("fetchWithSsrfGuard：redirect 逐跳复查 + DNS 判段（P1.29）", () => {
  const okLookup = async (_h: string) => [{ address: "93.184.216.34" }];
  const htmlResponse = () =>
    new Response("<html><title>ok</title></html>", { status: 200, headers: { "content-type": "text/html" } });
  const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } });
  const fakeFetch = (impl: (url: string) => Response | Promise<Response>) =>
    (async (u: string | URL | Request) => impl(String(u))) as unknown as typeof fetch;

  it("直连 200：域名先过 DNS 判段再发请求，finalUrl 不变", async () => {
    const looked: string[] = [];
    const fetched: string[] = [];
    const { res, finalUrl } = await fetchWithSsrfGuard(new URL("https://example.com/page"), {
      lookupImpl: async (h) => {
        looked.push(h);
        return okLookup(h);
      },
      fetchImpl: fakeFetch((u) => {
        fetched.push(u);
        return htmlResponse();
      }),
    });
    expect(res.status).toBe(200);
    expect(finalUrl.toString()).toBe("https://example.com/page");
    expect(looked).toEqual(["example.com"]);
    expect(fetched).toEqual(["https://example.com/page"]);
  });

  it("302 跳内网字面量 → SsrfBlockedError，第二跳请求未发出（redirect:follow 时代的核心绕过）", async () => {
    const fetched: string[] = [];
    await expect(
      fetchWithSsrfGuard(new URL("https://short.example/"), {
        lookupImpl: okLookup,
        fetchImpl: fakeFetch((u) => {
          fetched.push(u);
          return redirectTo("http://169.254.169.254/latest/meta-data");
        }),
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetched).toEqual(["https://short.example/"]);
  });

  it("302 跳域名：第二跳 DNS 解析命中内网 IP → SsrfBlockedError（域名指向内网的 rebinding 静态形态）", async () => {
    let hop = 0;
    await expect(
      fetchWithSsrfGuard(new URL("https://a.example/"), {
        lookupImpl: async (h) => (h === "evil.example" ? [{ address: "10.0.0.9" }] : okLookup(h)),
        fetchImpl: fakeFetch(() => (hop++ === 0 ? redirectTo("https://evil.example/x") : htmlResponse())),
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("公网两跳链：逐跳复查通过，相对 Location 按当前跳解析，finalUrl 为最终跳", async () => {
    const fetched: string[] = [];
    const { res, finalUrl } = await fetchWithSsrfGuard(new URL("https://a.example/"), {
      lookupImpl: okLookup,
      fetchImpl: fakeFetch((u) => {
        fetched.push(u);
        return u === "https://a.example/" ? redirectTo("/step2") : htmlResponse();
      }),
    });
    expect(res.status).toBe(200);
    expect(finalUrl.toString()).toBe("https://a.example/step2");
    expect(fetched).toEqual(["https://a.example/", "https://a.example/step2"]);
  });

  it("302 → file: 协议 → SsrfBlockedError（协议白名单逐跳复查）", async () => {
    await expect(
      fetchWithSsrfGuard(new URL("https://a.example/"), {
        lookupImpl: okLookup,
        fetchImpl: fakeFetch(() => redirectTo("file:///etc/passwd")),
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("超过 maxRedirects → too many redirects（非 SsrfBlockedError，路由层归 502）", async () => {
    let calls = 0;
    await expect(
      fetchWithSsrfGuard(new URL("https://loop.example/"), {
        lookupImpl: okLookup,
        maxRedirects: 3,
        fetchImpl: fakeFetch((u) => {
          calls++;
          return redirectTo(u); // 自跳转死循环
        }),
      }),
    ).rejects.toThrow("too many redirects");
    expect(calls).toBe(4); // 首跳 + 3 次跟随，第 5 跳不再发出
  });

  it("DNS 多地址任一命中内网即整域拦截（fail-closed，fetch 可能取任一地址）", async () => {
    let fetchCalled = false;
    await expect(
      fetchWithSsrfGuard(new URL("https://dual.example/"), {
        lookupImpl: async () => [{ address: "8.8.8.8" }, { address: "127.0.0.1" }],
        fetchImpl: fakeFetch(() => {
          fetchCalled = true;
          return htmlResponse();
        }),
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchCalled).toBe(false);
  });

  it("IP 字面量起始 URL：跳过 DNS（lookup 不被调用），公网字面量放行", async () => {
    let lookupCalled = false;
    const { res } = await fetchWithSsrfGuard(new URL("http://8.8.8.8/"), {
      lookupImpl: async () => {
        lookupCalled = true;
        return [];
      },
      fetchImpl: fakeFetch(() => htmlResponse()),
    });
    expect(res.status).toBe(200);
    expect(lookupCalled).toBe(false);
  });

  it("3xx 无 Location → 作为最终响应返回（不视为跳转）", async () => {
    const { res, finalUrl } = await fetchWithSsrfGuard(new URL("https://a.example/"), {
      lookupImpl: okLookup,
      fetchImpl: fakeFetch(() => new Response(null, { status: 304 })),
    });
    expect(res.status).toBe(304);
    expect(finalUrl.toString()).toBe("https://a.example/");
  });

  it("畸形 Location（URL 构造失败）→ 抛非 SsrfBlockedError（路由层归 502）", async () => {
    await expect(
      fetchWithSsrfGuard(new URL("https://a.example/"), {
        lookupImpl: okLookup,
        fetchImpl: fakeFetch(() => redirectTo("http://[broken")),
      }),
    ).rejects.toThrow(TypeError);
  });
});

describe("integrations：stub 契约如实断言", () => {
  const SID = "zz_test_integration_" + Date.now().toString(36);

  afterAll(async () => {
    await sql`DELETE FROM integrations WHERE service_id = ${SID}`;
  });

  it("GET / → services 列表 + logins 恒空数组（stub 形态）", async () => {
    const r = await api("/api/integrations", { cookie: user.cookie });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.data.services)).toBe(true);
    expect(r.data.logins).toEqual([]);
  });

  it("POST /login：已知 service → Agent login ready；未知 service → 200+{error}（stub 反模式，P2 #1 收敛前的现实契约）", async () => {
    await sql`INSERT INTO integrations (service_id, name, provider, config) VALUES (${SID}, ${"测试集成"}, ${"test"}, ${"{}"}::jsonb)`;
    const known = await api("/api/integrations/login", {
      method: "POST",
      cookie: user.cookie,
      csrf: user.csrf,
      body: { service: "测试集成" },
    });
    expect(known.status).toBe(200);
    expect(known.data.status).toBe("Agent login ready");
    expect(known.data.service).toBe("测试集成");

    const unknown = await api("/api/integrations/login", {
      method: "POST",
      cookie: user.cookie,
      csrf: user.csrf,
      body: { service: "no-such-service" },
    });
    // 评估报告点名：integrations 用 HTTP 200 + {error} 返回错误（§2.1 中低）——
    // 测试如实记录现状，收敛为 4xx 时本断言随之更新
    expect(unknown.status).toBe(200);
    expect(unknown.data.error).toBe("service not found");
  });
});
