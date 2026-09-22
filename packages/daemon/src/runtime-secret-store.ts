/**
 * 批次 B / P1.1：本机 runtime secret store——manifest `secretRefs` 的取值源。
 *
 * 痛点：secretEnv 要求用户把 provider key 预先放进 daemon 进程环境——不可见、
 * 不可管理、改一个 key 要重启 daemon。本 store 把 secret 值收敛到
 * `<slockDir()>/runtime-secrets.json`（文件 0600、目录 0700、逐 entrypoint
 * 隔离），由 `slock runtime secret set|unset|list` 管理。
 *
 * 纪律（与 secretEnv 等价，见 docs §10 信任模型）：
 * - manifest 只存变量名（`secretRefs: ["OPENAI_API_KEY"]`），值只在本机此文件；
 * - 值不上传 server、不进协议帧、不进审计/日志/probe 摘要——probe 只报
 *   `secret-ref-missing` 错误码，不报值也不报缺失的是哪条之外的细节；
 * - list 只返回变量名，不返回值（CLI 面同纪律）。
 */

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirPrivateSync, slockDir } from "./private-dir.js";

const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface SecretStoreFile {
  version: 1;
  /** entrypoint id → env 变量名 → secret 值 */
  secrets: Record<string, Record<string, string>>;
}

export interface IRuntimeSecretStore {
  /** 取单个 secret 值；不存在返回 undefined */
  get(entrypoint: string, name: string): string | undefined;
  /** 写入/覆盖 secret（名必须是合法 env 变量名，值非空字符串） */
  set(entrypoint: string, name: string, value: string): void;
  /** 删除单个 secret；返回是否删掉了记录 */
  unset(entrypoint: string, name: string): boolean;
  /** 列出某 entrypoint 已登记的变量名（不返回值） */
  listNames(entrypoint: string): string[];
  /** 列出有 secret 记录的 entrypoint id */
  listEntrypoints(): string[];
  /**
   * 按名批量解析（probe/spawn 注入路径用）：返回已解析值与缺失名列表。
   * 缺失值不进 values（调用方按 missing 判 fail-fast）。
   */
  resolve(entrypoint: string, names: string[]): { values: Record<string, string>; missing: string[] };
}

export const defaultRuntimeSecretStorePath = (): string => join(slockDir(), "runtime-secrets.json");

export const createRuntimeSecretStore = (filePath: string = defaultRuntimeSecretStorePath()): IRuntimeSecretStore => {
  const readAll = (): SecretStoreFile => {
    if (!existsSync(filePath)) return { version: 1, secrets: {} };
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      const secrets = raw?.secrets;
      if (typeof secrets !== "object" || secrets === null || Array.isArray(secrets)) {
        return { version: 1, secrets: {} };
      }
      return { version: 1, secrets: secrets as Record<string, Record<string, string>> };
    } catch (err) {
      console.warn(`[RuntimeSecretStore] Failed to load ${filePath}: ${(err as Error)?.message}, starting empty`);
      return { version: 1, secrets: {} };
    }
  };

  const writeAll = (data: SecretStoreFile): void => {
    mkdirPrivateSync(dirname(filePath));
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* best-effort：Windows 上 chmod 语义有限 */
    }
    renameSync(tmp, filePath);
    try {
      chmodSync(filePath, 0o600);
    } catch {
      /* best-effort */
    }
  };

  return {
    get(entrypoint, name) {
      const v = readAll().secrets[entrypoint]?.[name];
      return typeof v === "string" && v !== "" ? v : undefined;
    },

    set(entrypoint, name, value) {
      if (!ENV_RE.test(name)) throw new Error(`invalid env name: ${name}`);
      if (typeof value !== "string" || value === "") throw new Error("secret value must be a non-empty string");
      const data = readAll();
      const bucket = (data.secrets[entrypoint] ??= {});
      bucket[name] = value;
      writeAll(data);
    },

    unset(entrypoint, name) {
      const data = readAll();
      const bucket = data.secrets[entrypoint];
      if (!bucket || !(name in bucket)) return false;
      delete bucket[name];
      if (Object.keys(bucket).length === 0) delete data.secrets[entrypoint];
      writeAll(data);
      return true;
    },

    listNames(entrypoint) {
      return Object.keys(readAll().secrets[entrypoint] ?? {}).sort();
    },

    listEntrypoints() {
      return Object.keys(readAll().secrets).sort();
    },

    resolve(entrypoint, names) {
      const bucket = readAll().secrets[entrypoint] ?? {};
      const values: Record<string, string> = {};
      const missing: string[] = [];
      for (const name of names) {
        const v = bucket[name];
        if (typeof v === "string" && v !== "") values[name] = v;
        else missing.push(name);
      }
      return { values, missing };
    },
  };
};
