import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { apiClient, apiGet, apiPatch, apiPost, setTenantProvider } from "../api";

/**
 * server（guild）语境 store —— /api/orgs 列表 + activeServerId 持久化。
 * activeServerId 经 setTenantProvider 注入 apiClient 的 x-server-id，
 * 所有走 resolveTenant 的后端端点自动圈定到活跃 server。
 */

export interface ServerItem {
  id: string;
  name: string;
  owner_id: string;
  role: "owner" | "admin" | "member";
  memberCount: number;
  agentCount: number;
  /** 最早 is_public server = 默认社区（广场）；后端拒删，前端据此隐藏删除入口 */
  isDefault?: boolean;
  /** 公共服务器：全员可见可自助加入、member 可退（退后可经 discover 再加入）、不可删 */
  is_public?: boolean;
}

const ACTIVE_KEY = "slock.activeServer";

/**
 * 「已有自己的服务器」判定：owns 非公共 server。2026-09-19 personal 特例取消后
 * 所有自建 server 同口径，拥有公共服务器（广场 owner）不算「自己的服务器」。
 */
export function hasOwnServer(orgs: ServerItem[]): boolean {
  return orgs.some((o) => o.role === "owner" && !o.is_public);
}

/** 未加入的公共 server（/api/orgs/discover）——注册自动入圈之前的存量账号靠它补票 */
export interface DiscoverableServer {
  id: string;
  name: string;
  is_public: boolean;
  memberCount: number;
  agentCount: number;
  isDefault?: boolean;
}

export const useServerStore = defineStore("servers", () => {
  const orgs = ref<ServerItem[]>([]);
  const discoverable = ref<DiscoverableServer[]>([]);
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
    // 默认落点：公共服务器（广场——人多的地方），无则最早 server
    return orgs.value.find((o) => o.is_public)?.id ?? orgs.value[0]?.id ?? null;
  }

  async function fetchOrgs(): Promise<ServerItem[]> {
    const data = await apiGet<{ orgs: ServerItem[] }>("/api/orgs");
    orgs.value = data.orgs || [];
    // 发现面与成员列表同源刷新——加入/被移出后两边一致
    try {
      const d = await apiGet<{ servers: DiscoverableServer[] }>("/api/orgs/discover");
      discoverable.value = d.servers || [];
    } catch {
      discoverable.value = [];
    }
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

  async function deleteServer(id: string): Promise<void> {
    await apiClient(`/api/orgs/${id}`, { method: "DELETE" });
    if (activeServerId.value === id) setActive(null);
    await fetchOrgs();
  }

  async function joinServer(id: string): Promise<void> {
    await apiPost(`/api/orgs/${id}/join`);
    await fetchOrgs(); // orgs + discoverable 同源刷新
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
    discoverable,
    loaded,
    activeServerId,
    activeServer,
    ownedCount,
    fetchOrgs,
    setActive,
    createServer,
    renameServer,
    leaveServer,
    deleteServer,
    joinServer,
    acceptInvite,
  };
});
