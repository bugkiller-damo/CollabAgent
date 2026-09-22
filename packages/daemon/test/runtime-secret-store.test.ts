import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeSecretStore } from "../src/runtime-secret-store.js";

/**
 * 批次 B / P1.1：本机 secret store——值只进 <slockDir()>/runtime-secrets.json
 * （0600，逐 entrypoint 隔离）；list/resolve 的对外面只出变量名，不出值。
 */

let dirs: string[] = [];
const tmpPath = (): string => {
  const d = mkdtempSync(join(tmpdir(), "slock-secrets-"));
  dirs.push(d);
  return join(d, "runtime-secrets.json");
};

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("createRuntimeSecretStore", () => {
  it("set/get/unset/listNames/listEntrypoints 全链路", () => {
    const p = tmpPath();
    const store = createRuntimeSecretStore(p);
    expect(store.get("ep-1", "OPENAI_API_KEY")).toBeUndefined();
    expect(store.listEntrypoints()).toEqual([]);

    store.set("ep-1", "OPENAI_API_KEY", "sk-live-1");
    store.set("ep-1", "LANGSMITH_API_KEY", "ls-1");
    store.set("ep-2", "OPENAI_API_KEY", "sk-other");

    expect(store.get("ep-1", "OPENAI_API_KEY")).toBe("sk-live-1");
    expect(store.get("ep-2", "OPENAI_API_KEY")).toBe("sk-other");
    expect(store.listNames("ep-1")).toEqual(["LANGSMITH_API_KEY", "OPENAI_API_KEY"]);
    expect(store.listEntrypoints()).toEqual(["ep-1", "ep-2"]);

    // 覆盖写
    store.set("ep-1", "OPENAI_API_KEY", "sk-live-2");
    expect(store.get("ep-1", "OPENAI_API_KEY")).toBe("sk-live-2");

    expect(store.unset("ep-1", "OPENAI_API_KEY")).toBe(true);
    expect(store.get("ep-1", "OPENAI_API_KEY")).toBeUndefined();
    expect(store.unset("ep-1", "OPENAI_API_KEY")).toBe(false);
    // entrypoint 桶清空后整体移除
    store.unset("ep-1", "LANGSMITH_API_KEY");
    expect(store.listEntrypoints()).toEqual(["ep-2"]);
  });

  it("list/serialize 不含值——对外面只出变量名", () => {
    const p = tmpPath();
    const store = createRuntimeSecretStore(p);
    store.set("ep-1", "OPENAI_API_KEY", "sk-secret-zzz");
    const surface = JSON.stringify({ names: store.listNames("ep-1"), eps: store.listEntrypoints() });
    expect(surface).not.toContain("sk-secret-zzz");
    // 值确实在盘上文件里
    expect(readFileSync(p, "utf-8")).toContain("sk-secret-zzz");
  });

  it("resolve：命中与缺失分列，缺失值不进 values", () => {
    const p = tmpPath();
    const store = createRuntimeSecretStore(p);
    store.set("ep-1", "A_KEY", "a");
    const r = store.resolve("ep-1", ["A_KEY", "B_KEY"]);
    expect(r.values).toEqual({ A_KEY: "a" });
    expect(r.missing).toEqual(["B_KEY"]);
  });

  it("set 校验：非法 env 名 / 空值 → 抛错不落盘", () => {
    const p = tmpPath();
    const store = createRuntimeSecretStore(p);
    expect(() => store.set("ep-1", "1BAD", "v")).toThrow();
    expect(() => store.set("ep-1", "HAS-DASH", "v")).toThrow();
    expect(() => store.set("ep-1", "OK_NAME", "")).toThrow();
    expect(existsSync(p)).toBe(false);
  });

  it("文件损坏 → 读路径优雅降级为空（不抛）", () => {
    const p = tmpPath();
    writeFileSync(p, "not json {{{", "utf-8");
    const store = createRuntimeSecretStore(p);
    expect(store.get("ep-1", "K")).toBeUndefined();
    expect(store.listEntrypoints()).toEqual([]);
    // set 覆盖损坏文件后恢复可用
    store.set("ep-1", "K", "v");
    expect(store.get("ep-1", "K")).toBe("v");
  });

  it("数据文件权限 0600（POSIX）", () => {
    const p = tmpPath();
    createRuntimeSecretStore(p).set("ep-1", "K", "v");
    const mode = statSync(p).mode & 0o777;
    if (process.platform === "win32") {
      // Windows 无 POSIX 权限位语义，跳过（chmod best-effort）
      return;
    }
    expect(mode).toBe(0o600);
  });

  it("tmp 文件不残留（原子写路径）", () => {
    const p = tmpPath();
    createRuntimeSecretStore(p).set("ep-1", "K", "v");
    expect(existsSync(p)).toBe(true);
    expect(existsSync(`${p}.tmp`)).toBe(false);
  });
});
