/**
 * API 客户端 —— 从 packages/web/src/api/client.ts 近乎逐行移植（框架无关 TS）。
 * Cookie 会话（credentials:"include"）+ csrf_token cookie 的 double-submit 校验。
 * 注意：React 版抛的是 plain Error（err.error || `HTTP ${status}`），没有独立的
 * ServerError 类，这里保持原样。
 */

type FetchOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  /** 传 false 关闭本请求的 x-server-id 注入（全局语境端点用，如跨 server 搜索） */
  tenant?: boolean;
};

// ---- 租户注入（guild 化）----
// serverStore 注册 provider，apiClient 对 /api/ 请求统一注入 x-server-id。
// 用 provider 回调而不是直接 import store：api 是 stores 的下游依赖，反向 import 会成环。
let tenantProvider: (() => string | null) | null = null;
export function setTenantProvider(fn: (() => string | null) | null): void {
  tenantProvider = fn;
}

/**
 * W-A4：带 HTTP 状态码的错误（message 与原 plain Error 完全一致，全站 err?.message 消费方零影响）。
 * 用于按状态码分流：403 停轮询（MetricsDashboard）、后续 401 拦截登出（§8.2 #2）。
 */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// 从可读的 csrf_token cookie 取值，用于 double-submit 校验
export function readCsrf(): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === "csrf_token") return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export async function apiClient<T = unknown>(url: string, options: FetchOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const method = (options.method || "GET").toUpperCase();
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    const csrf = readCsrf();
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }

  // guild 化：/api/ 请求默认携带活跃 server 语境（resolveTenant 的 header 优先级
  // 高于 Host/默认降级）。显式 x-server-id 已存在时不覆盖（离线队列重发按其入队时
  // 的 server 投递）；tenant:false 可整体关闭（跨 server 的全局端点）。
  const explicitHeaders = options.headers as Record<string, string> | undefined;
  if (options.tenant !== false && url.startsWith("/api/") && !explicitHeaders?.["x-server-id"]) {
    const sid = tenantProvider?.();
    if (sid) headers["x-server-id"] = sid;
  }

  const { tenant: _tenant, ...rest } = options;
  const res = await fetch(url, {
    ...rest,
    credentials: "include",
    headers: { ...headers, ...explicitHeaders },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, (err as any).error || `HTTP ${res.status}`);
  }
  return res.json();
}

/** 按请求覆盖：tenant:false 关注入；headers["x-server-id"] 强制指定 server（离线重发等） */
export type ApiInit = Pick<FetchOptions, "tenant" | "headers">;

export function apiGet<T = unknown>(
  url: string,
  params?: Record<string, string>,
  signal?: AbortSignal,
  init?: ApiInit,
): Promise<T> {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return apiClient<T>(url + qs, { method: "GET", signal, ...init });
}

export function apiPatch<T = unknown>(url: string, body?: unknown, signal?: AbortSignal, init?: ApiInit): Promise<T> {
  return apiClient<T>(url, { method: "PATCH", body, signal, ...init });
}

export function apiPost<T = unknown>(url: string, body?: unknown, signal?: AbortSignal, init?: ApiInit): Promise<T> {
  return apiClient<T>(url, { method: "POST", body, signal, ...init });
}

export interface UploadedAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
}

export interface UploadProgressInfo {
  loaded: number;
  total: number;
  /** 0~100 整数；lengthComputable=false 时为 null（进度未知，UI 回落「上传中…」文案） */
  pct: number | null;
}

export interface UploadOptions {
  /** F15：XHR upload 进度回调（lengthComputable 时 pct 0~100） */
  onProgress?: (p: UploadProgressInfo) => void;
  /** F15：取消上传（XHR abort；取消后 Promise reject「已取消」） */
  signal?: AbortSignal;
}

/**
 * F15：附件上传改 XHR——fetch 拿不到 upload 进度事件，XHR upload.onprogress 是唯一
 * 广泛可用的进度通道。老签名 (file) 完全兼容（第二参缺省 = 无进度无取消）。
 * 口径与 fetch 版一致：POST /api/attachments/upload + cookie 凭据 + CSRF double-submit。
 */
export function uploadAttachment(file: File, opts: UploadOptions = {}): Promise<UploadedAttachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const csrf = readCsrf();
    xhr.open("POST", "/api/attachments/upload");
    xhr.withCredentials = true;
    if (csrf) xhr.setRequestHeader("X-CSRF-Token", csrf);

    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    xhr.upload.onprogress = (e) => {
      opts.onProgress?.({
        loaded: e.loaded,
        total: e.lengthComputable ? e.total : 0,
        pct: e.lengthComputable ? Math.round((e.loaded / e.total) * 100) : null,
      });
    };
    xhr.onload = () => {
      settle(() => {
        let data: any = null;
        try {
          data = JSON.parse(xhr.responseText || "null");
        } catch {
          /* 非 JSON 响应 → 走 statusText 回退 */
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          reject(new ApiError(xhr.status, data?.error || xhr.statusText || `HTTP ${xhr.status}`));
        }
      });
    };
    xhr.onerror = () => settle(() => reject(new ApiError(0, "网络错误，上传失败")));
    xhr.onabort = () => settle(() => reject(new ApiError(0, "已取消")));
    opts.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    const fd = new FormData();
    fd.append("file", file);
    xhr.send(fd);
  });
}
