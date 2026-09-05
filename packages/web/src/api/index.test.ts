import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiClient, apiGet, apiPost, readCsrf, uploadAttachment } from "./index";

// api 模块用真实实现 + stub 全局 fetch/document（vitest.config 注释口径：node 环境手工 stub）
beforeEach(() => {
  vi.stubGlobal("document", { cookie: "sid=abc; csrf_token=tok123" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function okResponse(json: unknown, status = 200) {
  return new Response(JSON.stringify(json), { status });
}

describe("readCsrf（csrf_token cookie 解析）", () => {
  it("从 cookie 串取 csrf_token 并 decodeURIComponent", () => {
    expect(readCsrf()).toBe("tok123");
  });

  it("URI 编码值解码", () => {
    vi.stubGlobal("document", { cookie: "csrf_token=a%20b" });
    expect(readCsrf()).toBe("a b");
  });

  it("无 csrf_token cookie → null；无 document（node/SSR）→ null", () => {
    vi.stubGlobal("document", { cookie: "sid=abc" });
    expect(readCsrf()).toBeNull();
    vi.unstubAllGlobals();
    expect(readCsrf()).toBeNull();
  });
});

describe("apiClient CSRF double-submit", () => {
  it("POST 注入 X-CSRF-Token + Content-Type + body JSON 序列化", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => okResponse({ ok: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiClient("/api/x", { method: "POST", body: { a: 1 } });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("tok123");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("GET 不带 CSRF 头（即便 cookie 在）", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => okResponse({ ok: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiClient("/api/x");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBeUndefined();
  });

  it("POST 无 csrf cookie → 不带头（非写方法不强制）", async () => {
    vi.stubGlobal("document", { cookie: "sid=abc" });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => okResponse({ ok: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiPost("/api/x", { a: 1 });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBeUndefined();
  });

  it("options.headers 与注入头合并（调用方可叠加 Authorization 等）", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => okResponse({ ok: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiClient("/api/x", { method: "POST", headers: { Authorization: "Bearer x" } });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer x");
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("tok123");
  });
});

describe("apiClient 错误映射（ApiError）", () => {
  it("非 2xx：status + server error 文案透传", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse({ error: "频道名过长" }, 400)),
    );
    await expect(apiClient("/api/x", { method: "POST" })).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
      message: "频道名过长",
    });
  });

  it("非 2xx 且响应非 JSON：回退 statusText", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>bad</html>", { status: 502, statusText: "Bad Gateway" })),
    );
    const err = (await apiClient("/api/x").catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.message).toBe("Bad Gateway");
  });

  it("ApiError 是 Error 子类（全站 err?.message 消费兼容）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse({ error: "e" }, 500)),
    );
    const err = (await apiClient("/api/x").catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
  });

  it("2xx 返回解析后的 JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse({ value: 42 })),
    );
    await expect(apiClient<{ value: number }>("/api/x")).resolves.toEqual({ value: 42 });
  });
});

describe("便捷封装", () => {
  it("apiGet 拼 query string（URLSearchParams 编码）", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => okResponse({ ok: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiGet("/api/x", { q: "关键词" });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/x?q=%E5%85%B3%E9%94%AE%E8%AF%8D");
  });

  it("uploadAttachment：POST /api/attachments/upload + CSRF 头 + FormData + 解析返回", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      okResponse({ attachmentId: "att1", url: "/files/att1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const file = new Blob(["x"], { type: "text/plain" }) as File;
    const res = await uploadAttachment(file);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/attachments/upload");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("tok123");
    expect(init.body).toBeInstanceOf(FormData);
    expect(res).toEqual({ attachmentId: "att1", url: "/files/att1" });
  });

  it("uploadAttachment 失败：ApiError 透传 server 文案", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse({ error: "文件过大" }, 413)),
    );
    const err = (await uploadAttachment(new Blob(["x"]) as File).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("文件过大");
  });
});
