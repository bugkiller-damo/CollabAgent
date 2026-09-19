import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { apiGet } from "../api";

export type RuntimeProbeStatus = "installed" | "not_installed" | "installed_unsupported";

export interface RuntimeProbe {
  id: string;
  status: RuntimeProbeStatus;
  version?: string;
}

/**
 * 2026-09-19 server-scoped computers：一行 = 某用户在活跃 server 注册的一台机器。
 * 身份键 (userId, serverId, machineUuid)；member 可读全表，操作仅属主（mine）。
 */
export interface ComputerRecord {
  id: string;
  userId: string;
  serverId: string;
  machineUuid: string;
  name: string;
  description: string;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  daemonVersion: string | null;
  lastReadyAt: string | null;
  createdAt: string | null;
  online: boolean;
  runtimes: RuntimeProbe[];
  connectedAt: number | null;
  /** 该机属主的账号信息（他人机器时展示用） */
  ownerHandle: string | null;
  ownerName: string | null;
  mine: boolean;
}

const CATALOG: { id: string; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex CLI" },
  { id: "gemini", label: "Gemini CLI" },
  { id: "opencode", label: "OpenCode" },
];

export function runtimeCatalog() {
  return CATALOG;
}

export function claudeInstalled(runtimes: RuntimeProbe[]): boolean {
  return runtimes.some((r) => r.id === "claude" && r.status === "installed");
}

/**
 * 活跃 server 的计算机列表（apiClient 自动携 x-server-id——切 server 后须 refresh）。
 * 不再有懒建行/单机状态对象：机器行只在 daemon ready 时由服务端落库。
 */
export const useComputerStore = defineStore("computer", () => {
  const computers = ref<ComputerRecord[]>([]);
  const loading = ref(false);
  const loaded = ref(false);

  const myComputers = computed(() => computers.value.filter((c) => c.mine));
  /** 我在本 server 至少一台机器在线——rail 圆点/老「已连接」语义的新形态 */
  const connected = computed(() => myComputers.value.some((c) => c.online));

  async function refresh(): Promise<ComputerRecord[]> {
    loading.value = true;
    try {
      const d = await apiGet<{ computers: ComputerRecord[] }>("/api/computers");
      computers.value = d.computers || [];
      return computers.value;
    } catch {
      // 无活跃 server / 非成员 / 端点失败 → 空态（页面自己渲染接入引导）
      computers.value = [];
      return [];
    } finally {
      loaded.value = true;
      loading.value = false;
    }
  }

  return { computers, myComputers, connected, loading, loaded, refresh };
});
