import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeManifest, validateEntry } from "../src/agent-runtime-manifest.js";

/**
 * 批次 B / P0.3：公开 manifest JSON Schema（schemas/runtime-manifest.schema.json）
 * 与权威校验器（validateEntry）的一致性锚点——schema 是编辑辅助，validator
 * 才是 fail-closed 裁决；本文件守住两者不同步漂移。
 */

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas", "runtime-manifest.schema.json");

interface JsonSchema {
  required?: string[];
  properties?: Record<string, { required?: string[]; properties?: Record<string, unknown>; const?: unknown }>;
  $defs?: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
}

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8")) as JsonSchema;
const entrySchema = schema.$defs?.entry;

let dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "slock-schema-"));
  dirs.push(d);
  return d;
};

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const conformantEntry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "ep-1",
  runtime: "langgraph",
  label: "Graph",
  command: "python",
  args: ["-m", "worker"],
  cwd: process.platform === "win32" ? "C:\\work" : "/tmp/work",
  env: { PLAIN_FLAG: "1" },
  secretEnv: ["OPENAI_API_KEY"],
  secretRefs: ["STORED_KEY"],
  model: { mode: "select", default: "gpt-4o", allowed: ["gpt-4o", "gpt-5"] },
  requireDurableThreads: true,
  startupTimeoutMs: 15000,
  silenceTimeoutMs: 300000,
  shutdownTimeoutMs: 10000,
  ...over,
});

describe("runtime-manifest.schema.json", () => {
  it("schema 文件存在且是合法 draft 2020-12 文档", () => {
    expect(schema.required).toContain("version");
    expect(schema.required).toContain("entries");
    expect(schema.properties?.version?.const).toBe(1);
    expect(entrySchema).toBeTruthy();
  });

  it("schema 全字段的合规 entry 通过权威 validateEntry", () => {
    const v = validateEntry(conformantEntry());
    expect(v.error).toBeUndefined();
    expect(v.entry?.secretRefs).toEqual(["STORED_KEY"]);
  });

  it("schema required ⊆ validator 强制项：每缺一个 required 字段 validator 都拒", () => {
    for (const field of entrySchema?.required ?? []) {
      const raw = conformantEntry();
      delete raw[field];
      expect(validateEntry(raw).error, `missing ${field} should fail`).toBeTruthy();
    }
  });

  it("validator 认得但 schema 不存在的字段 → 漂移警报（revision 除外：loader 计算值）", () => {
    // validator 归一化产物的字段全集必须都能在 schema properties 中找到
    const v = validateEntry(conformantEntry());
    const entryProps = Object.keys(entrySchema?.properties ?? {});
    for (const key of Object.keys(v.entry ?? {})) {
      if (key === "revision") continue; // revision 是 loader 计算值，manifest 文件不含
      expect(entryProps, `schema missing property "${key}"`).toContain(key);
    }
  });

  it("schema 声明的 id pattern 与 validator 一致（坏 id 两边都拒）", () => {
    expect(validateEntry(conformantEntry({ id: "Bad_Id!" })).error).toBe("entry-id-invalid");
    const pattern = (entrySchema?.properties?.id as { pattern?: string })?.pattern;
    expect(pattern).toBe("^[a-z0-9][a-z0-9._-]{0,63}$");
    expect(new RegExp(pattern!).test("Bad_Id!")).toBe(false);
  });

  it("schema 不暗示 secret 值进 manifest：env propertyNames 仅变量名，无值字段承载 secret", () => {
    // secretEnv/secretRefs 的 item 引用的是 envName def（名字，不是值）
    const refs = JSON.stringify(entrySchema?.properties?.secretRefs);
    expect(refs).toContain("envName");
    // env 的值类型是 string——但 validator 层禁凭证形键名；schema 描述里必须写明
    const envDesc = JSON.stringify(entrySchema?.properties?.env);
    expect(envDesc).toContain("credential");
  });

  it("经 schema 形状写盘的 manifest 能被 loadRuntimeManifest 完整解析", () => {
    const dir = tmp();
    const p = join(dir, "runtimes.json");
    writeFileSync(p, JSON.stringify({ version: 1, entries: [conformantEntry()] }), "utf-8");
    const snap = loadRuntimeManifest(p);
    expect(snap.fatalError).toBeUndefined();
    expect(snap.entries.get("ep-1")?.model.mode).toBe("select");
    expect(snap.entries.get("ep-1")?.secretRefs).toEqual(["STORED_KEY"]);
  });
});
