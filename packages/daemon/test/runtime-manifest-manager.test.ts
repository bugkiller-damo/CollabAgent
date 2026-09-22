import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { manifestAuditPath } from "../src/agent-runtime-manifest.js";
import { createRuntimeManifestManager } from "../src/runtime-manifest-manager.js";

/**
 * 批次 B / P1.2：manifest CRUD 管理器——validateEntry 权威校验、tmp+rename
 * 原子写、0600、revision 迁移审计、冲突（dup id / not-found / 改名撞 id）。
 */

let dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "slock-mgr-"));
  dirs.push(d);
  return d;
};

const manifestPath = (dir: string) => join(dir, "runtimes.json");
const seed = (dir: string, entries: unknown[]) => {
  writeFileSync(manifestPath(dir), JSON.stringify({ version: 1, entries }), "utf-8");
  return manifestPath(dir);
};

const validEntry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "ep-1",
  runtime: "langgraph",
  label: "Graph",
  command: "python",
  args: ["-m", "worker"],
  cwd: process.platform === "win32" ? "C:\\work" : "/tmp/work",
  model: { mode: "fixed", default: "gpt-4o" },
  ...over,
});

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("createRuntimeManifestManager.add", () => {
  it("空文件 → add 成功：文件成形、snapshot 反映、revision 迁移审计落行", () => {
    const dir = tmp();
    const mgr = createRuntimeManifestManager(manifestPath(dir));
    const r = mgr.add(validEntry());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry?.id).toBe("ep-1");
      expect(r.revision).toHaveLength(64);
    }
    const raw = JSON.parse(readFileSync(manifestPath(dir), "utf-8"));
    expect(raw.version).toBe(1);
    expect(raw.entries).toHaveLength(1);
    expect(mgr.snapshot().entries.get("ep-1")?.runtime).toBe("langgraph");
    // 审计：missing → <sha> 迁移一行（只含安全元数据）
    const audit = readFileSync(manifestAuditPath(manifestPath(dir)), "utf-8")
      .trim()
      .split("\n");
    const last = JSON.parse(audit[audit.length - 1]!);
    expect(last.previousRevision).toBe("missing");
    expect(last.entries).toHaveLength(1);
    expect(last.entries[0]).toMatchObject({ id: "ep-1", runtime: "langgraph" });
    expect(last.entries[0].revision).toHaveLength(64);
    expect(JSON.stringify(last)).not.toContain("python"); // 不记 command
  });

  it("校验失败 → 不落盘（文件保持不存在）", () => {
    const dir = tmp();
    const mgr = createRuntimeManifestManager(manifestPath(dir));
    const r = mgr.add(validEntry({ command: "python; rm -rf /" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("entry-command-invalid");
    expect(existsSync(manifestPath(dir))).toBe(false);
  });

  it("撞已有 id → entry-id-duplicate，文件不变", () => {
    const dir = tmp();
    seed(dir, [validEntry()]);
    const before = readFileSync(manifestPath(dir), "utf-8");
    const mgr = createRuntimeManifestManager(manifestPath(dir));
    const r = mgr.add(validEntry({ label: "Dupe" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("entry-id-duplicate");
    expect(readFileSync(manifestPath(dir), "utf-8")).toBe(before);
  });
});

describe("createRuntimeManifestManager.update", () => {
  it("浅合并补丁：改 label + secretRefs，未提字段保留", () => {
    const dir = tmp();
    seed(dir, [validEntry({ secretEnv: ["OPENAI_API_KEY"] })]);
    const mgr = createRuntimeManifestManager(manifestPath(dir));
    const r = mgr.update("ep-1", { label: "Renamed", secretRefs: ["STORED_KEY"] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry?.label).toBe("Renamed");
      expect(r.entry?.secretRefs).toEqual(["STORED_KEY"]);
      expect(r.entry?.secretEnv).toEqual(["OPENAI_API_KEY"]);
      expect(r.entry?.command).toBe("python");
    }
  });

  it("不存在 id → entrypoint-not-found", () => {
    const dir = tmp();
    seed(dir, [validEntry()]);
    const mgr = createRuntimeManifestManager(manifestPath(dir));
    const r = mgr.update("nope", { label: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("entrypoint-not-found");
  });

  it("改名撞其它条目 → entry-id-duplicate；改成自己 id 合法", () => {
    const dir = tmp();
    seed(dir, [validEntry(), validEntry({ id: "ep-2", label: "B" })]);
    const mgr = createRuntimeManifestManager(manifestPath(dir));
    const dup = mgr.update("ep-1", { id: "ep-2" });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.code).toBe("entry-id-duplicate");
    const self = mgr.update("ep-1", { id: "ep-1", label: "Same" });
    expect(self.ok).toBe(true);
  });

  it("补丁把 entry 打坏（非法 env）→ 不落盘", () => {
    const dir = tmp();
    seed(dir, [validEntry()]);
    const before = readFileSync(manifestPath(dir), "utf-8");
    const mgr = createRuntimeManifestManager(manifestPath(dir));
    const r = mgr.update("ep-1", { env: { SLOCK_EVIL: "1" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("entry-env-invalid");
    expect(readFileSync(manifestPath(dir), "utf-8")).toBe(before);
  });
});

describe("createRuntimeManifestManager.remove", () => {
  it("删除存在条目 → 文件收缩 + snapshot 更新", () => {
    const dir = tmp();
    seed(dir, [validEntry(), validEntry({ id: "ep-2", label: "B" })]);
    const mgr = createRuntimeManifestManager(manifestPath(dir));
    const r = mgr.remove("ep-1");
    expect(r.ok).toBe(true);
    const raw = JSON.parse(readFileSync(manifestPath(dir), "utf-8"));
    expect(raw.entries).toHaveLength(1);
    expect(raw.entries[0].id).toBe("ep-2");
    expect(mgr.snapshot().entries.has("ep-1")).toBe(false);
  });

  it("删除不存在 → entrypoint-not-found", () => {
    const dir = tmp();
    seed(dir, []);
    const mgr = createRuntimeManifestManager(manifestPath(dir));
    const r = mgr.remove("ghost");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("entrypoint-not-found");
  });
});

describe("createRuntimeManifestManager 兜底", () => {
  it("manifest 损坏 → 一切写被拒（不覆盖用户数据）", () => {
    const dir = tmp();
    writeFileSync(manifestPath(dir), "{{{ broken", "utf-8");
    const mgr = createRuntimeManifestManager(manifestPath(dir));
    for (const r of [mgr.add(validEntry()), mgr.update("x", {}), mgr.remove("x")]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("manifest-invalid");
    }
    expect(readFileSync(manifestPath(dir), "utf-8")).toBe("{{{ broken");
  });

  it("原子写：成功后 tmp 文件不残留", () => {
    const dir = tmp();
    const mgr = createRuntimeManifestManager(manifestPath(dir));
    expect(mgr.add(validEntry()).ok).toBe(true);
    expect(existsSync(`${manifestPath(dir)}.tmp`)).toBe(false);
  });

  it("未识别字段原样往返（前向兼容）", () => {
    const dir = tmp();
    seed(dir, [validEntry({ futureField: { a: 1 } })]);
    const mgr = createRuntimeManifestManager(manifestPath(dir));
    expect(mgr.add(validEntry({ id: "ep-2" })).ok).toBe(true);
    const raw = JSON.parse(readFileSync(manifestPath(dir), "utf-8"));
    expect(raw.entries[0].futureField).toEqual({ a: 1 });
  });
});
