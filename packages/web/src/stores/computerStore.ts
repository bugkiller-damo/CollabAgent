import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { apiGet, apiPost } from "../api";

export type RuntimeProbeStatus = "installed" | "not_installed" | "installed_unsupported";

export interface RuntimeProbe {
  id: string;
  status: RuntimeProbeStatus;
  version?: string;
}

export interface ComputerRecord {
  id: string;
  userId: string;
  serverId: string;
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
}

export interface ComputerStatus {
  connected: boolean;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  daemonVersion: string | null;
  runtimes: RuntimeProbe[];
  connectedAt: number | null;
  computer: ComputerRecord | null;
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

export const useComputerStore = defineStore("computer", () => {
  const status = ref<ComputerStatus | null>(null);
  const loading = ref(false);

  const connected = computed(() => !!status.value?.connected);
  const computer = computed(() => status.value?.computer ?? null);
  const runtimes = computed(() => status.value?.runtimes ?? []);
  const hasClaude = computed(() => claudeInstalled(runtimes.value));

  async function refresh(): Promise<ComputerStatus | null> {
    loading.value = true;
    try {
      const me = await apiGet<ComputerStatus>("/api/computers/me");
      status.value = me;
      return me;
    } catch {
      try {
        const d = await apiGet<ComputerStatus>("/api/daemon/status");
        status.value = { ...d, computer: d.computer ?? null };
        return status.value;
      } catch {
        status.value = {
          connected: false,
          hostname: null,
          os: null,
          arch: null,
          daemonVersion: null,
          runtimes: [],
          connectedAt: null,
          computer: null,
        };
        return status.value;
      }
    } finally {
      loading.value = false;
    }
  }

  async function ensure(): Promise<ComputerStatus> {
    const created = await apiPost<ComputerStatus>("/api/computers", {});
    status.value = created;
    return created;
  }

  return { status, loading, connected, computer, runtimes, hasClaude, refresh, ensure };
});
