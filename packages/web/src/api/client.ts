import { useAuthStore } from "../stores/authStore";

type FetchOptions = Omit<RequestInit, "body"> & { body?: unknown };

export async function apiClient<T = unknown>(url: string, options: FetchOptions = {}): Promise<T> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, {
    ...options,
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

export function apiPost<T = unknown>(url: string, body?: unknown): Promise<T> {
  return apiClient<T>(url, { method: "POST", body });
}
