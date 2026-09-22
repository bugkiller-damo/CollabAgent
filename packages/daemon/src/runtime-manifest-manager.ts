/**
 * 批次 B / P1.2：runtime manifest 的 CRUD 管理器。
 *
 * 手写 `.slock/runtimes.json` 易错且无回滚：`slock runtime add|edit|remove`
 * 全部经本模块落盘——写入前复用 `validateEntry` 的权威校验（非法写入被拒）、
 * tmp+rename 原子写、0600 权限位；每次成功变更经内部 mtime loader 触发
 * revision 迁移审计（`runtime-manifest-audit.jsonl`，与 daemon 观察到的
 * 变更同一格式——daemon 侧 watcher 会再记一条它视角的迁移，两观察者语义）。
 *
 * 冲突校验：add 撞已有 id → `entry-id-duplicate`；edit/remove 打不中 id →
 * `entrypoint-not-found`；edit 改名撞上其它条目 → `entry-id-duplicate`。
 * manifest 文件已损坏（fatalError）时拒绝一切写——不静默覆盖用户数据。
 */

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  createRuntimeManifestLoader,
  type RuntimeManifestEntry,
  type RuntimeManifestSnapshot,
  resolveRuntimeManifestPath,
  validateEntry,
} from "./agent-runtime-manifest.js";
import { mkdirPrivateSync } from "./private-dir.js";

export interface ManifestMutationOk {
  ok: true;
  entry?: RuntimeManifestEntry;
  revision: string;
}

export interface ManifestMutationError {
  ok: false;
  /** 与 validateEntry / DispatchError 同一套错误码，便于 CLI 与文档对齐 */
  code: string;
  message: string;
}

export type ManifestMutationResult = ManifestMutationOk | ManifestMutationError;

export interface IRuntimeManifestManager {
  readonly path: string;
  /** 当前快照（mtime 缓存——进程内重复调用便宜，文件变了自动重读） */
  snapshot(): RuntimeManifestSnapshot;
  /** 追加一条 entry；校验失败/撞 id 不落盘 */
  add(rawEntry: unknown): ManifestMutationResult;
  /** 浅合并补丁进指定 id 的 raw entry；校验失败/不存在/改名撞 id 不落盘 */
  update(id: string, patch: Record<string, unknown>): ManifestMutationResult;
  /** 删除指定 id 的 entry */
  remove(id: string): ManifestMutationResult;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const rawEntryId = (raw: unknown): string | undefined =>
  isRecord(raw) && typeof raw.id === "string" ? raw.id : undefined;

export const createRuntimeManifestManager = (
  filePath?: string,
  env: NodeJS.ProcessEnv = process.env,
): IRuntimeManifestManager => {
  const path = filePath ?? resolveRuntimeManifestPath(env);
  // 内部 loader：snapshot() 复用其 mtime 缓存；成功变更后的下一次 snapshot()
  // 会观察 revision 迁移并自动追加 manifest 审计行（appendManifestAudit）。
  const loader = createRuntimeManifestLoader(path, env);

  /** 读 raw 文件体（保留未识别字段原样往返）；文件损坏返回 null（拒写）。 */
  const readRawFile = (): { version: 1; entries: unknown[] } | null => {
    if (!existsSync(path)) return { version: 1, entries: [] };
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
      if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) return null;
      return { version: 1, entries: parsed.entries };
    } catch {
      return null;
    }
  };

  const writeRawFile = (body: { version: 1; entries: unknown[] }): void => {
    mkdirPrivateSync(dirname(path));
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf-8");
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* best-effort：Windows 上 chmod 语义有限 */
    }
    renameSync(tmp, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      /* best-effort */
    }
  };

  /**
   * 变更统一收口：loader() 先确立基线 revision（供审计 prev），mutate 改
   * raw entries，校验 + 原子写，最后 loader() 观察迁移 → 自动审计。
   * mutate 返回错误码直接短路（不落盘不审计）。
   */
  const mutate = (fn: (entries: unknown[]) => ManifestMutationError | unknown[]): ManifestMutationResult => {
    loader(); // 确立基线 revision（审计 prev；文件缺失时也会缓存 missing 快照）
    const body = readRawFile();
    if (!body) {
      return { ok: false, code: "manifest-invalid", message: `manifest at ${path} is unreadable or invalid` };
    }
    const next = fn(body.entries);
    if (isRecord(next) && "code" in next) return next as ManifestMutationError;
    const written = { version: 1 as const, entries: next as unknown[] };
    try {
      writeRawFile(written);
    } catch (err) {
      return { ok: false, code: "manifest-write-failed", message: (err as Error)?.message ?? String(err) };
    }
    const after = loader();
    return { ok: true, revision: after.revision };
  };

  return {
    path,
    snapshot: () => loader(),

    add(rawEntry) {
      const result = mutate((entries) => {
        const validated = validateEntry(rawEntry);
        if (!validated.entry || !validated.id) {
          return { ok: false, code: validated.error ?? "entry-invalid", message: "entry failed manifest validation" };
        }
        if (entries.some((e) => rawEntryId(e) === validated.id)) {
          return { ok: false, code: "entry-id-duplicate", message: `entrypoint "${validated.id}" already exists` };
        }
        entries.push(rawEntry);
        return entries;
      });
      if (!result.ok) return result;
      const entry = loader().entries.get(validateEntry(rawEntry).id ?? "");
      return { ...result, ...(entry ? { entry } : {}) };
    },

    update(id, patch) {
      const result = mutate((entries) => {
        const idx = entries.findIndex((e) => rawEntryId(e) === id);
        if (idx < 0) {
          return { ok: false, code: "entrypoint-not-found", message: `entrypoint "${id}" is not in the manifest` };
        }
        const merged = { ...(isRecord(entries[idx]) ? (entries[idx] as Record<string, unknown>) : {}), ...patch };
        const validated = validateEntry(merged);
        if (!validated.entry || !validated.id) {
          return { ok: false, code: validated.error ?? "entry-invalid", message: "patched entry failed validation" };
        }
        if (entries.some((e, i) => i !== idx && rawEntryId(e) === validated.id)) {
          return {
            ok: false,
            code: "entry-id-duplicate",
            message: `renaming to "${validated.id}" collides with an existing entrypoint`,
          };
        }
        entries[idx] = merged;
        return entries;
      });
      if (!result.ok) return result;
      const newId = typeof patch.id === "string" ? patch.id : id;
      const entry = loader().entries.get(newId);
      return { ...result, ...(entry ? { entry } : {}) };
    },

    remove(id) {
      return mutate((entries) => {
        const idx = entries.findIndex((e) => rawEntryId(e) === id);
        if (idx < 0) {
          return { ok: false, code: "entrypoint-not-found", message: `entrypoint "${id}" is not in the manifest` };
        }
        entries.splice(idx, 1);
        return entries;
      });
    },
  };
};
