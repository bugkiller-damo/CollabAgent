// ============================================================
// 适配器注册中心
// 管理已注册的第三方安全服务适配器
// ============================================================

import type {
  AdapterDefinition, AdapterType, AssetDiscoveryAdapter,
  VulnScanAdapter, PenetrationAdapter, ComplianceAdapter, AdapterResult,
} from "@collabagent/shared";

interface RegisteredAdapter {
  definition: AdapterDefinition;
  instance: AssetDiscoveryAdapter | VulnScanAdapter | PenetrationAdapter | ComplianceAdapter;
}

export class AdapterRegistry {
  private adapters = new Map<string, RegisteredAdapter>();
  private byType = new Map<AdapterType, Set<string>>();

  register(definition: AdapterDefinition, instance: AssetDiscoveryAdapter | VulnScanAdapter | PenetrationAdapter | ComplianceAdapter): void {
    this.adapters.set(definition.id, { definition, instance });
    if (!this.byType.has(definition.adapterType)) this.byType.set(definition.adapterType, new Set());
    this.byType.get(definition.adapterType)!.add(definition.id);
    console.log(`[AdapterRegistry] registered: ${definition.name} (${definition.adapterType})`);
  }

  unregister(adapterId: string): void {
    const a = this.adapters.get(adapterId);
    if (!a) return;
    this.adapters.delete(adapterId);
    this.byType.get(a.definition.adapterType)?.delete(adapterId);
  }

  get(adapterId: string): RegisteredAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  listByType(type: AdapterType): AdapterDefinition[] {
    const ids = this.byType.get(type);
    if (!ids) return [];
    return Array.from(ids).map((id) => this.adapters.get(id)!.definition);
  }

  listAll(): AdapterDefinition[] {
    return Array.from(this.adapters.values()).map((a) => a.definition);
  }

  /** 选择并执行：自动选择类型匹配的首个启用的适配器 */
  async execute<T = unknown>(
    type: AdapterType,
    fn: (instance: AssetDiscoveryAdapter | VulnScanAdapter | PenetrationAdapter | ComplianceAdapter) => Promise<AdapterResult<T>>,
    preferredId?: string,
  ): Promise<AdapterResult<T>> {
    let entry: RegisteredAdapter | undefined;
    if (preferredId) entry = this.adapters.get(preferredId);
    if (!entry) {
      const candidates = this.listByType(type).filter((d) => d.enabled);
      if (candidates.length === 0) {
        return { success: false, error: { code: "NO_ADAPTER", message: `no enabled adapter for type ${type}`, retryable: false }, executionTimeMs: 0 };
      }
      entry = this.adapters.get(candidates[0].id);
    }
    if (!entry?.definition.enabled) {
      return { success: false, error: { code: "DISABLED", message: "adapter disabled", retryable: false }, executionTimeMs: 0 };
    }
    const start = Date.now();
    try {
      return await fn(entry.instance);
    } catch (err: any) {
      return { success: false, error: { code: "INTERNAL_ERROR", message: err?.message ?? "unknown", retryable: true }, executionTimeMs: Date.now() - start };
    }
  }
}

export const defaultRegistry = new AdapterRegistry();
