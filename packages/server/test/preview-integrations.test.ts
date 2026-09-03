import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeEntities, isBlockedHost, metaContent } from "../src/routes/preview.js";
import { api, cleanupTestData, closeSql, registerUser, sql, type TestUser } from "./helpers.js";

// P1.28：preview（SSRF 面，评估零覆盖清单 ②）+ integrations（纯 stub）测试。
// preview 的抓取侧：确定性分支（参数/协议/黑名单）走真路由；元信息提取与黑名单矩阵
// 走纯函数（preview.ts 的 helpers 已导出）；真外网抓取不进测试面（离线不可跑/网络抖动）。
// redirect 逐跳复查 + 最终 IP 段校验是 SSRF 的残余缺口，归 P1.29（本文件黑名单矩阵
// 即为其回归基线）。

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
