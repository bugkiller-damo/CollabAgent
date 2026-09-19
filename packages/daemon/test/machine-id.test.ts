import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveMachineUuid } from "../src/machine-id.js";

describe("resolveMachineUuid（server-scoped computers 本机身份）", () => {
  let dir: string;
  let file: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "slock-mid-"));
    file = join(dir, "machine-id");
    savedEnv = process.env.SLOCK_MACHINE_ID;
    delete process.env.SLOCK_MACHINE_ID;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.SLOCK_MACHINE_ID;
    else process.env.SLOCK_MACHINE_ID = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it("无文件时生成 UUID 并落盘，二次调用复用同一身份", () => {
    const first = resolveMachineUuid(undefined, file);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(readFileSync(file, "utf-8")).toBe(first);
    expect(resolveMachineUuid(undefined, file)).toBe(first);
  });

  it("已有文件原样复用（含换行/空白容错）", () => {
    writeFileSync(file, "  mu-existing-1\n");
    expect(resolveMachineUuid(undefined, file)).toBe("mu-existing-1");
  });

  it("SLOCK_MACHINE_ID 环境变量优先于文件", () => {
    writeFileSync(file, "mu-file");
    process.env.SLOCK_MACHINE_ID = "mu-env";
    expect(resolveMachineUuid(undefined, file)).toBe("mu-env");
  });

  it("显式 override 最高优先（测试注入）", () => {
    process.env.SLOCK_MACHINE_ID = "mu-env";
    writeFileSync(file, "mu-file");
    expect(resolveMachineUuid("mu-override", file)).toBe("mu-override");
  });

  it("文件内容是垃圾/超长 → 重新生成覆盖", () => {
    writeFileSync(file, "x".repeat(500));
    const id = resolveMachineUuid(undefined, file);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(file, "utf-8")).toBe(id);
  });

  it("空串 override/空 env 不短路，正常走文件路径", () => {
    process.env.SLOCK_MACHINE_ID = "   ";
    writeFileSync(file, "mu-file");
    expect(resolveMachineUuid("  ", file)).toBe("mu-file");
  });
});
