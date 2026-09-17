import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiClient, apiGet, apiPost, readCsrf, uploadAttachment } from "./index";

// api 模块用真实实现 + stub 全局 fetch/document（vitest.config 注释口径：node 环境手工 stub）
beforeEach(() => {
  vi.stubGlobal("document", { cookie: "sid=abc; csrf_token=tok123" });
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  FakeXhr.instances.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// F15：uploadAttachment 已切 XHR（进度/取消）——假 XHR 由测试驱动事件回调
class FakeXhr {
  static instances: FakeXhr[] = [];
  upload = { onprogress: null as ((e: any) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  withCredentials = false;
  status = 200;
  statusText = "";
  responseText = "";
  method = "";
  url = "";
  headers: Record<string, string> = {};
  fd: FormData | null = null;
  abortCalled = false;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(fd: FormData) {
    this.fd = fd;
    FakeXhr.instances.push(this);
  }
  abort() {
    this.abortCalled = true;
    this.onabort?.();
  }
}

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

  it("uploadAttachment(XHR)：POST + CSRF 头 + withCredentials + FormData + 解析返回", async () => {
    const p = uploadAttachment(new Blob(["x"]) as File);
    const xhr = FakeXhr.instances[0];
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/api/attachments/upload");
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.headers["X-CSRF-Token"]).toBe("tok123");
    expect(xhr.fd).toBeInstanceOf(FormData);
    xhr.responseText = JSON.stringify({ attachmentId: "att1", url: "/files/att1" });
    xhr.onload?.();
    await expect(p).resolves.toEqual({ attachmentId: "att1", url: "/files/att1" });
  });

  it("uploadAttachment 失败：ApiError 透传 server 文案（非 2xx + JSON error）", async () => {
    const p = uploadAttachment(new Blob(["x"]) as File);
    const xhr = FakeXhr.instances[0];
    xhr.status = 413;
    xhr.responseText = JSON.stringify({ error: "文件过大" });
    xhr.onload?.();
    const err = (await p.catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(413);
    expect(err.message).toBe("文件过大");
  });

  it("uploadAttachment 进度：onProgress 收 0~100 pct；lengthComputable=false 时 pct=null", async () => {
    const seen: Array<{ loaded: number; total: number; pct: number | null }> = [];
    const p = uploadAttachment(new Blob(["x"]) as File, { onProgress: (x) => seen.push(x) });
    const xhr = FakeXhr.instances[0];
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 60, total: 100 });
    expect(seen[seen.length - 1]).toEqual({ loaded: 60, total: 100, pct: 60 });
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
    expect(seen[seen.length - 1]).toEqual({ loaded: 100, total: 100, pct: 100 });
    xhr.upload.onprogress?.({ lengthComputable: false, loaded: 10, total: 999 });
    expect(seen[seen.length - 1]).toEqual({ loaded: 10, total: 0, pct: null });
    xhr.onload?.();
    await p;
  });

  it("uploadAttachment 取消：signal abort → xhr.abort → reject「已取消」", async () => {
    const ctrl = new AbortController();
    const p = uploadAttachment(new Blob(["x"]) as File, { signal: ctrl.signal });
    const xhr = FakeXhr.instances[0];
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "ApiError", status: 0, message: "已取消" });
    expect(xhr.abortCalled).toBe(true);
  });

  it("uploadAttachment 网络错误：onerror → ApiError(0)；settle 后重复事件不二次 settle", async () => {
    const p = uploadAttachment(new Blob(["x"]) as File);
    const xhr = FakeXhr.instances[0];
    xhr.onerror?.();
    await expect(p).rejects.toMatchObject({ status: 0, message: "网络错误，上传失败" });
    // settle-once：之后来的 onload/onabort 不再触发（无 unhandled rejection）
    expect(() => {
      xhr.onload?.();
      xhr.onabort?.();
    }).not.toThrow();
  });
});
