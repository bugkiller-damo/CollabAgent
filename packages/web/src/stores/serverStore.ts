import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { apiGet, apiPatch, apiPost, setTenantProvider } from "../api";

/**
 * server（guild）语境 store —— /api/orgs 列表 + activeServerId 持久化。
 * activeServerId 经 setTenantProvider 注入 apiClient 的 x-server-id，
 * 所有走 resolveTenant 的后端端点自动圈定到活跃 server。
 */

export interface ServerItem {
  id: string;
  name: string;
  personal: boolean;
  owner_id: string;
  role: "owner" | "admin" | "member";
  memberCount: number;
  agentCount: number;
}

const ACTIVE_KEY = "slock.activeServer";

/** personal server 的默认命名（与 server 端 getOrCreatePersonalOrg 同口径） */
export function personalDefaultName(handle?: string): string {
  return `${handle || "我"} 的私有空间`;
}

/**
 * 「已有自己的服务器」判定：owns 非 personal server，或 personal server 已被
 * 改名（向导落地 = ensure personal + PATCH 命名）。不能用 role==='owner' 单判——
 * personal server 用户天然 owner，会让每个用户都恒为「已有」。
 */
export function hasOwnServer(orgs: ServerItem[], handle?: string): boolean {
  const def = personalDefaultName(handle);
  return orgs.some((o) => o.role === "owner" && (!o.personal || (o.name || "") !== def));
}

export const useServerStore = defineStore("servers", () => {
  const orgs = ref<ServerItem[]>([]);
  const loaded = ref(false);
  const activeServerId = ref<string | null>(
    typeof localStorage === "undefined" ? null : localStorage.getItem(ACTIVE_KEY),
  );

  const activeServer = computed<ServerItem | null>(() => orgs.value.find((o) => o.id === activeServerId.value) ?? null);
  /** 我拥有（owner）的 server 数——0 时 AppLayout 显示「创建你的服务器」引导条 */
  const ownedCount = computed(() => orgs.value.filter((o) => o.role === "owner").length);

  function persist(id: string | null) {
    if (typeof localStorage === "undefined") return;
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  }

  function pickFallback(): string | null {
    // 默认落点：非 personal 的第一个（广场/自建服——人多的地方），personal 兜底
    return orgs.value.find((o) => !o.personal)?.id ?? orgs.value[0]?.id ?? null;
  }

  async function fetchOrgs(): Promise<ServerItem[]> {
    const data = await apiGet<{ orgs: ServerItem[] }>("/api/orgs");
    orgs.value = data.orgs || [];
    loaded.value = true;
    // 持久化的 active 失效（退圈/删除/多端变更）时回落
    if (!orgs.value.some((o) => o.id === activeServerId.value)) {
      setActive(pickFallback());
    }
    return orgs.value;
  }

  function setActive(id: string | null) {
    if (id === activeServerId.value) return;
    activeServerId.value = id;
    persist(id);
  }

  async function createServer(name: string): Promise<ServerItem> {
    const r = await apiPost<{ org: ServerItem }>("/api/orgs", { name });
    await fetchOrgs();
    return r.org;
  }

  async function renameServer(id: string, name: string): Promise<void> {
    await apiPatch(`/api/orgs/${id}`, { name });
    await fetchOrgs();
  }

  async function leaveServer(id: string): Promise<void> {
    await apiPost(`/api/orgs/${id}/leave`);
    if (activeServerId.value === id) setActive(null);
    await fetchOrgs();
  }

  async function acceptInvite(token: string): Promise<{ serverId: string; serverName: string }> {
    const r = await apiPost<{ ok: boolean; serverId: string; serverName: string }>(
      `/api/invites/${encodeURIComponent(token)}/accept`,
    );
    await fetchOrgs();
    return { serverId: r.serverId, serverName: r.serverName };
  }

  // apiClient 的 x-server-id 注入源（见 api/index.ts）
  setTenantProvider(() => activeServerId.value);

  return {
    orgs,
    loaded,
    activeServerId,
    activeServer,
    ownedCount,
    fetchOrgs,
    setActive,
    createServer,
    renameServer,
    leaveServer,
    acceptInvite,
  };
});
