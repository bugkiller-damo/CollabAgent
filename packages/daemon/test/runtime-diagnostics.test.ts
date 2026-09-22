import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachDiagnostics, createRuntimeDiagnostics } from "../src/runtime-diagnostics.js";

/**
 * 批次 C（P1.5）：entrypoint 运行诊断快照。
 * 纪律锚点：只在状态迁移时落盘（recordOk 无 lastError = no-op）、message 过
 * redactSecrets + 截断 600、损坏文件安全降级为空、subscribe 变化通知给
 * daemon-core 的 entrypoints:refresh。
 */

let dirs: string[] = [];
const tmpFile = (): string => {
  const d = mkdtempSync(join(tmpdir(), "slock-diag-"));
  dirs.push(d);
  return join(d, "runtime-diagnostics.json");
};

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("createRuntimeDiagnostics", () => {
  it("recordError 落盘：code/message/at 齐全，跨实例读回", () => {
    const path = tmpFile();
    const diag = createRuntimeDiagnostics(path, { now: () => 1000 });
    diag.recordError("ep-1", { code: "command-not-found", message: "spawn python failed" });
    const rec = createRuntimeDiagnostics(path).get("ep-1");
    expect(rec?.lastError).toMatchObject({
      code: "command-not-found",
      message: "spawn python failed",
      at: new Date(1000).toISOString(),
    });
    expect(rec?.lastOkAt).toBeUndefined();
  });

  it("recordError 保留既有 lastOkAt（错误不抹掉上次成功时间）", () => {
    const path = tmpFile();
    const diag = createRuntimeDiagnostics(path, { now: () => 1000 });
    diag.recordError("ep-1", { message: "first" });
    createRuntimeDiagnostics(path, { now: () => 2000 }).recordOk("ep-1");
    createRuntimeDiagnostics(path, { now: () => 3000 }).recordError("ep-1", { message: "second" });
    const rec = diag.get("ep-1");
    expect(rec?.lastError?.message).toBe("second");
    expect(rec?.lastOkAt).toBe(new Date(2000).toISOString());
  });

  it("recordError：message 脱敏（sk_* 打码）+ 截断 600 字符", () => {
    const path = tmpFile();
    const diag = createRuntimeDiagnostics(path);
    diag.recordError("ep-1", { message: `failed with sk_agent_${"a".repeat(32)} tail` });
    const rec = diag.get("ep-1");
    expect(rec?.lastError?.message).not.toContain(`sk_agent_${"a".repeat(32)}`);
    expect(rec?.lastError?.message).toContain("sk_agent_***");

    diag.recordError("ep-2", { message: "x".repeat(1000) });
    expect(diag.get("ep-2")?.lastError?.message.length).toBe(600);
  });

  it("recordOk：挂着 lastError → 清除 + lastOkAt + 通知；无错误 → no-op 不通知", () => {
    const path = tmpFile();
    const listener = vi.fn();
    const diag = createRuntimeDiagnostics(path, { now: () => 5000 });
    diag.subscribe(listener);

    diag.recordOk("ep-1"); // 无历史错误——常态成功回合不落盘
    expect(listener).not.toHaveBeenCalled();
    expect(diag.get("ep-1")).toBeUndefined();

    diag.recordError("ep-1", { code: "runtime-start-timeout", message: "t/o" });
    expect(listener).toHaveBeenCalledTimes(1);
    diag.recordOk("ep-1");
    expect(listener).toHaveBeenCalledTimes(2);
    const rec = diag.get("ep-1");
    expect(rec?.lastError).toBeUndefined();
    expect(rec?.lastOkAt).toBe(new Date(5000).toISOString());
  });

  it("subscribe 退订后不再通知；listener 抛错不打断写路径", () => {
    const path = tmpFile();
    const diag = createRuntimeDiagnostics(path);
    const boom = vi.fn(() => {
      throw new Error("listener boom");
    });
    const ok = vi.fn();
    diag.subscribe(boom);
    const unsub = diag.subscribe(ok);
    diag.recordError("ep-1", { message: "x" });
    expect(boom).toHaveBeenCalledTimes(1); // 抛错不影响后续 listener
    expect(ok).toHaveBeenCalledTimes(1);
    unsub();
    diag.recordError("ep-1", { message: "y" });
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("损坏/缺失文件 → 空表不炸", () => {
    const path = tmpFile();
    writeFileSync(path, "{broken", "utf-8");
    const diag = createRuntimeDiagnostics(path);
    expect(diag.all()).toEqual({});
    expect(diag.get("ep-1")).toBeUndefined();
    // 损坏文件可被下一次写覆盖恢复
    diag.recordError("ep-1", { message: "ok-again" });
    expect(JSON.parse(readFileSync(path, "utf-8")).entries["ep-1"].lastError.message).toBe("ok-again");
  });

  it("空 entrypoint id 静默忽略", () => {
    const diag = createRuntimeDiagnostics(tmpFile());
    diag.recordError("", { message: "x" });
    diag.recordOk("");
    expect(diag.all()).toEqual({});
  });
});

describe("attachDiagnostics", () => {
  it("按 id 合并诊断到 probe 条目；无记录原样返回", () => {
    const path = tmpFile();
    const diag = createRuntimeDiagnostics(path, { now: () => 1000 });
    diag.recordError("ep-1", { code: "cwd-not-found", message: "no dir" });

    const probes: { id: string; status: string; diagnostics?: unknown }[] = [
      { id: "ep-1", status: "installed_unsupported" },
      { id: "ep-2", status: "installed" },
    ];
    const merged = attachDiagnostics(probes, diag);
    expect((merged[0]?.diagnostics as { lastError?: { code?: string } })?.lastError?.code).toBe("cwd-not-found");
    expect(merged[1]).toEqual({ id: "ep-2", status: "installed" }); // 无记录不添字段

    // 空 store / undefined diagnostics → 返回原数组引用（不制造新对象）
    expect(attachDiagnostics(probes, undefined)).toBe(probes);
    expect(attachDiagnostics(probes, createRuntimeDiagnostics(tmpFile()))).toBe(probes);
  });
});
