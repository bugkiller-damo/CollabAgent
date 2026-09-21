import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { apiGet } from "../api";

export type RuntimeProbeStatus = "installed" | "not_installed" | "installed_unsupported";

export interface RuntimeProbe {
  id: string;
  status: RuntimeProbeStatus;
  version?: string;
}

export type EntrypointStatus =
  | "installed"
  | "not_installed"
  | "installed_unsupported"
  | "misconfigured"
  | "protocol_incompatible";

/** Phase 4：manifest entrypoint 探测摘要（daemon ready → server → 本行） */
export interface ComputerEntrypoint {
  id: string;
  runtime?: string;
  label: string;
  status: EntrypointStatus;
  version?: string;
  models?: string[];
  defaultModel?: string;
  modelMode: "fixed" | "select";
  capabilities?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
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
  /** Phase 4：该机 manifest 里的 bridge entrypoint 探测摘要（无条目为 []） */
  entrypoints: ComputerEntrypoint[];
  connectedAt: number | null;
  /** 该机属主的账号信息（他人机器时展示用） */
  ownerHandle: string | null;
  ownerName: string | null;
  mine: boolean;
}

const CATALOG: { id: string; label: string; kind: "binary" | "bridge" }[] = [
  { id: "claude", label: "Claude Code", kind: "binary" },
  { id: "codex", label: "Codex CLI", kind: "binary" },
  { id: "gemini", label: "Gemini CLI", kind: "binary" },
  { id: "opencode", label: "OpenCode", kind: "binary" },
  // Phase 4：bridge runtime——安装状态不看 PATH 二进制，看 manifest entrypoint probe
  { id: "langchain", label: "LangChain", kind: "bridge" },
  { id: "langgraph", label: "LangGraph", kind: "bridge" },
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
  /** Phase 4 rollout：server 侧 SLOCK_BRIDGE_RUNTIMES——关时 UI 不出 bridge 选项 */
  const bridgeRuntimes = ref(false);

  const myComputers = computed(() => computers.value.filter((c) => c.mine));
  /** 我在本 server 至少一台机器在线——rail 圆点/老「已连接」语义的新形态 */
  const connected = computed(() => myComputers.value.some((c) => c.online));

  async function refresh(): Promise<ComputerRecord[]> {
    loading.value = true;
    try {
      const d = await apiGet<{ computers: ComputerRecord[]; bridgeRuntimes?: boolean }>("/api/computers");
      computers.value = d.computers || [];
      bridgeRuntimes.value = d.bridgeRuntimes === true;
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

  return { computers, myComputers, connected, bridgeRuntimes, loading, loaded, refresh };
});
