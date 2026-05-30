import { useAuthStore } from "../stores/authStore";

type FetchOptions = Omit<RequestInit, "body"> & { body?: unknown };

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
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
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
    throw new Error((err as any).error || `HTTP ${res.status}`);
  }
  return res.json();
}

export function apiGet<T = unknown>(url: string, params?: Record<string, string>): Promise<T> {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return apiClient<T>(url + qs, { method: "GET" });
}

export function apiPatch<T = unknown>(url: string, body?: unknown): Promise<T> {
  return apiClient<T>(url, { method: "PATCH", body });
}

export function apiPost<T = unknown>(url: string, body?: unknown): Promise<T> {
  return apiClient<T>(url, { method: "POST", body });
}

export interface UploadedAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
}

export async function uploadAttachment(file: File): Promise<UploadedAttachment> {
  const token = useAuthStore.getState().token;
  const fd = new FormData();
  fd.append("file", file);
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
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
    throw new Error((err as any).error || `HTTP ${res.status}`);
  }
  return res.json();
}
