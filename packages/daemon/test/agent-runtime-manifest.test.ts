import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRuntimeManifestLoader,
  defaultRuntimeManifestPath,
  loadRuntimeManifest,
  resolveRuntimeManifestPath,
} from "../src/agent-runtime-manifest.js";

/**
 * Phase 1：本机 runtimes.json manifest 的加载/校验/缓存。
 * 安全边界：命令禁 shell 运算符、env 禁 secret 形键名与 SLOCK_ 前缀/危险注入键、
 * secretEnv 只存变量名；非法条目进 invalidEntries 而不是拖垮整个文件。
 */

let dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "slock-manifest-"));
  dirs.push(d);
  return d;
};

const writeManifest = (dir: string, body: unknown): string => {
  const p = join(dir, "runtimes.json");
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body), "utf-8");
  return p;
};

const validEntry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "ep-1",
  runtime: "langgraph",
  label: "Test Graph",
  command: "python",
  args: ["-m", "worker"],
  cwd: process.platform === "win32" ? "C:\\work" : "/tmp/work",
  model: { mode: "fixed", default: "gpt-4o" },
  ...over,
});

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  delete process.env.SLOCK_RUNTIME_MANIFEST;
});

describe("loadRuntimeManifest", () => {
  it("文件缺失 → revision=missing 空快照（非 fatal）", () => {
    const snap = loadRuntimeManifest(join(tmp(), "nope.json"));
    expect(snap.revision).toBe("missing");
    expect(snap.entries.size).toBe(0);
    expect(snap.fatalError).toBeUndefined();
  });

  it("合法 manifest → 条目解析 + revision 稳定", () => {
    const p = writeManifest(tmp(), { version: 1, entries: [validEntry()] });
    const a = loadRuntimeManifest(p);
    const b = loadRuntimeManifest(p);
    expect(a.fatalError).toBeUndefined();
    expect(a.entries.get("ep-1")?.runtime).toBe("langgraph");
    expect(a.entries.get("ep-1")?.revision).toHaveLength(64);
    expect(a.revision).toBe(b.revision);
    expect(a.entries.get("ep-1")?.revision).toBe(b.entries.get("ep-1")?.revision);
  });

  it.each([
    ["非 JSON", "not json{{{"],
    ["version != 1", { version: 2, entries: [] }],
    ["entries 非数组", { version: 1, entries: {} }],
    ["顶层非对象", [1, 2]],
  ])("%s → fatalError=manifest-invalid", (_label, body) => {
    const p = writeManifest(tmp(), body as never);
    const snap = loadRuntimeManifest(p);
    expect(snap.fatalError).toBe("manifest-invalid");
    expect(snap.entries.size).toBe(0);
  });

  it("id 非法 → invalidEntries 以 #index 落位（无合法 id 可定位）", () => {
    const p = writeManifest(tmp(), {
      version: 1,
      entries: [validEntry({ id: "Bad ID!" }), validEntry({ id: "ep-ok" })],
    });
    const snap = loadRuntimeManifest(p);
    expect(snap.entries.has("ep-ok")).toBe(true);
    expect(snap.invalidEntries.get("#0")?.code).toBe("entry-id-invalid");
  });

  it.each([
    ["runtime 非法", { runtime: "codex" }, "entry-runtime-invalid"],
    ["label 缺失", { label: "" }, "entry-label-invalid"],
    ["command 带 shell 运算符", { command: "python -m x && rm -rf /" }, "entry-command-invalid"],
    ["command 带管道", { command: "python|sh" }, "entry-command-invalid"],
    ["args 非字符串", { args: [1] }, "entry-args-invalid"],
    ["cwd 相对路径", { cwd: "relative/dir" }, "entry-cwd-invalid"],
    ["env 带 SLOCK_ 前缀", { env: { SLOCK_SERVER_URL: "x" } }, "entry-env-invalid"],
    ["env 带 secret 形键名", { env: { MY_API_KEY: "sk-1" } }, "entry-env-invalid"],
    ["env 带 NODE_OPTIONS", { env: { NODE_OPTIONS: "--inspect" } }, "entry-env-invalid"],
    ["secretEnv 带 SLOCK_ 前缀", { secretEnv: ["SLOCK_AGENT_ID"] }, "entry-secret-env-invalid"],
    ["secretEnv 带 PYTHONPATH", { secretEnv: ["PYTHONPATH"] }, "entry-secret-env-invalid"],
    ["secretEnv 与 env 重叠", { env: { PLAIN: "1" }, secretEnv: ["plain"] }, "entry-env-overlap"],
    ["model.mode 非法", { model: { mode: "free", default: "m" } }, "entry-model-invalid"],
    ["model select 无 allowlist", { model: { mode: "select", default: "m" } }, "entry-model-invalid"],
    [
      "model select default 不在 allowlist",
      { model: { mode: "select", default: "x", allowed: ["y"] } },
      "entry-model-invalid",
    ],
    ["timeout 越界", { startupTimeoutMs: 10 }, "entry-timeout-invalid"],
  ])("非法条目 %s → invalidEntries，不拖垮其它条目", (_l, over, code) => {
    const p = writeManifest(tmp(), {
      version: 1,
      entries: [validEntry(over), validEntry({ id: "ep-ok" })],
    });
    const snap = loadRuntimeManifest(p);
    expect(snap.fatalError).toBeUndefined();
    expect(snap.entries.has("ep-ok")).toBe(true);
    expect(snap.invalidEntries.get("ep-1")?.code).toBe(code);
  });

  it("重复 id → 两者都不可用（entry-id-duplicate）", () => {
    const p = writeManifest(tmp(), { version: 1, entries: [validEntry(), validEntry()] });
    const snap = loadRuntimeManifest(p);
    expect(snap.entries.has("ep-1")).toBe(false);
    expect(snap.invalidEntries.get("ep-1")?.code).toBe("entry-id-duplicate");
  });

  it("invalidEntries 携带可外发元数据（runtime/label），不含命令与路径", () => {
    const p = writeManifest(tmp(), {
      version: 1,
      entries: [validEntry({ command: "python && evil" })],
    });
    const meta = loadRuntimeManifest(p).invalidEntries.get("ep-1");
    expect(meta?.code).toBe("entry-command-invalid");
    expect(meta?.runtime).toBe("langgraph");
    expect(meta?.label).toBe("Test Graph");
    expect(JSON.stringify(meta)).not.toContain("python");
    expect(JSON.stringify(meta)).not.toContain("work");
  });

  it("SLOCK_RUNTIME_MANIFEST 覆盖默认路径", () => {
    const dir = tmp();
    const custom = writeManifest(dir, { version: 1, entries: [validEntry()] });
    process.env.SLOCK_RUNTIME_MANIFEST = custom;
    expect(resolveRuntimeManifestPath(process.env)).toBe(custom);
    delete process.env.SLOCK_RUNTIME_MANIFEST;
    expect(resolveRuntimeManifestPath(process.env)).toBe(defaultRuntimeManifestPath());
    expect(defaultRuntimeManifestPath()).toContain("runtimes.json");
  });
});

describe("createRuntimeManifestLoader", () => {
  it("文件未变 → 复用同一 snapshot；内容变更 → 重新解析", () => {
    const dir = tmp();
    const p = writeManifest(dir, { version: 1, entries: [validEntry()] });
    const loader = createRuntimeManifestLoader(p, process.env);
    const a = loader();
    expect(loader()).toBe(a); // mtime+size 未变 → 同一对象

    writeFileSync(p, JSON.stringify({ version: 1, entries: [validEntry({ id: "ep-2" }), validEntry()] }));
    const b = loader();
    expect(b).not.toBe(a);
    expect(b.entries.has("ep-2")).toBe(true);
    expect(b.revision).not.toBe(a.revision);
  });

  it("文件删除后 → missing 快照", () => {
    const dir = tmp();
    const p = writeManifest(dir, { version: 1, entries: [] });
    const loader = createRuntimeManifestLoader(p, process.env);
    expect(loader().entries.size).toBe(0);
    rmSync(p);
    expect(loader().revision).toBe("missing");
  });
});
