/**
 * API 客户端 —— 从 packages/web/src/api/client.ts 近乎逐行移植（框架无关 TS）。
 * Cookie 会话（credentials:"include"）+ csrf_token cookie 的 double-submit 校验。
 * 注意：React 版抛的是 plain Error（err.error || `HTTP ${status}`），没有独立的
 * ServerError 类，这里保持原样。
 */

type FetchOptions = Omit<RequestInit, "body"> & { body?: unknown };

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

  const res = await fetch(url, {
    ...options,
    credentials: "include",
    headers: { ...headers, ...(options.headers as Record<string, string>) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, (err as any).error || `HTTP ${res.status}`);
  }
  return res.json();
}

export function apiGet<T = unknown>(url: string, params?: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return apiClient<T>(url + qs, { method: "GET", signal });
}

export function apiPatch<T = unknown>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return apiClient<T>(url, { method: "PATCH", body, signal });
}

export function apiPost<T = unknown>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return apiClient<T>(url, { method: "POST", body, signal });
}

export interface UploadedAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
}

export async function uploadAttachment(file: File): Promise<UploadedAttachment> {
  const fd = new FormData();
  fd.append("file", file);
  const headers: Record<string, string> = {};

  const csrf = readCsrf();
  if (csrf) headers["X-CSRF-Token"] = csrf;
  const res = await fetch("/api/attachments/upload", {
    method: "POST",
    credentials: "include",
    headers,
    body: fd,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, (err as any).error || `HTTP ${res.status}`);
  }
  return res.json();
}
