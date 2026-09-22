import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeManifest } from "../src/agent-runtime-manifest.js";
import {
  runtimeAdd,
  runtimeCheck,
  runtimeDoctor,
  runtimeEdit,
  runtimeList,
  runtimeProbe,
  runtimeRemove,
  runtimeValidate,
} from "../src/cli/runtime.js";
import { CliExit } from "../src/output.js";
import { createRuntimeDiagnostics, defaultDiagnosticsPath } from "../src/runtime-diagnostics.js";
import { writeRuntimeProbeSnapshot } from "../src/runtime-probe-snapshot.js";

/**
 * 批次 B（P0.4/P1.x）：`slock runtime` ops 面——list/validate/probe/check +
 * add/edit/remove 的直连测试（不经 commander；commander 接线在 registerRuntime）。
 * check 对 fixtures/sarp-worker.mjs 跑真实 spawn（skipTurns 默认开，
 * --run-turns 显式放行真实回合）。
 */

let dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "slock-clirt-"));
  dirs.push(d);
  return d;
};

const manifestAt = (dir: string) => join(dir, "runtimes.json");
const seed = (dir: string, entries: unknown[]) => {
  writeFileSync(manifestAt(dir), JSON.stringify({ version: 1, entries }), "utf-8");
  return { manifest: manifestAt(dir) };
};

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sarp-worker.mjs");
const validEntry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "ep-1",
  runtime: "langgraph",
  label: "Fixture Graph",
  command: process.execPath,
  args: [FIXTURE],
  cwd: dirname(FIXTURE),
  model: { mode: "fixed", default: "fx-model" },
  ...over,
});

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("runtimeValidate / runtimeList", () => {
  it("文件缺失 → validate ok（missing 非错误）+ list 空", () => {
    const dir = tmp();
    const v = runtimeValidate({ manifest: manifestAt(dir) });
    expect(v.ok).toBe(true);
    expect(v.valid).toBe(0);
    const l = runtimeList({ manifest: manifestAt(dir) });
    expect(l.entries).toEqual([]);
    expect(l.lastProbe).toBeNull();
  });

  it("非法条目 → validate ok=false + invalid 带码；list 进 invalidEntries", () => {
    const dir = tmp();
    seed(dir, [validEntry({ command: "a; b" })]);
    const v = runtimeValidate({ manifest: manifestAt(dir) });
    expect(v.ok).toBe(false);
    expect(v.invalid).toEqual([{ id: "ep-1", code: "entry-command-invalid" }]);
    const l = runtimeList({ manifest: manifestAt(dir) });
    expect(l.entries).toEqual([]);
    expect(l.invalidEntries[0]?.code).toBe("entry-command-invalid");
  });

  it("损坏 JSON → fatalError 透出", () => {
    const dir = tmp();
    writeFileSync(manifestAt(dir), "{{{", "utf-8");
    expect(runtimeValidate({ manifest: manifestAt(dir) }).fatalError).toBe("manifest-invalid");
  });
});

describe("runtimeAdd / runtimeEdit / runtimeRemove", () => {
  it("add → validate 可见 → edit 补丁 → remove 收敛", () => {
    const dir = tmp();
    const opts = { manifest: manifestAt(dir) };
    const add = runtimeAdd(validEntry(), opts);
    expect(add.ok).toBe(true);
    expect(runtimeValidate(opts).valid).toBe(1);

    const edit = runtimeEdit("ep-1", { label: "New Label", secretRefs: ["STORED_KEY"] }, opts);
    expect(edit.ok).toBe(true);
    const l = runtimeList(opts);
    expect(l.entries[0]).toMatchObject({ label: "New Label", secretRefs: ["STORED_KEY"] });

    expect(runtimeRemove("ep-1", opts).ok).toBe(true);
    expect(runtimeValidate(opts).valid).toBe(0);
  });

  it("add 校验失败 → ok=false + 不落盘", () => {
    const dir = tmp();
    const r = runtimeAdd(validEntry({ runtime: "claude" }), { manifest: manifestAt(dir) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("entry-runtime-invalid");
    expect(existsSync(manifestAt(dir))).toBe(false);
  });
});

describe("runtimeProbe", () => {
  it("注入 execute → 全量 probe + 快照落盘（list 读回 probe 状态）", () => {
    const dir = tmp();
    seed(dir, [validEntry()]);
    const goodFrame = JSON.stringify({
      protocol: "slock.agent-runtime",
      version: 1,
      type: "probe.result",
      runtime: { id: "langgraph", bridgeVersion: "0.1.0" },
      capabilities: { maxConcurrency: 1, usage: "tokens" },
    });
    const r = runtimeProbe(
      undefined,
      { manifest: manifestAt(dir) },
      {
        env: {} as NodeJS.ProcessEnv,
        resolveCommand: (c) => c,
        cwdExists: () => true,
        execute: vi.fn(() => goodFrame),
      },
    );
    expect(r.ok).toBe(true);
    expect(r.probes[0]?.status).toBe("installed_unsupported");
    const l = runtimeList({ manifest: manifestAt(dir) });
    expect(l.lastProbe?.manifestRevision).toBe(l.revision);
    expect(l.entries[0]?.probe).toMatchObject({ status: "installed_unsupported" });
  });

  it("指定 id 不在 manifest → entrypoint-not-found", () => {
    const dir = tmp();
    seed(dir, [validEntry()]);
    const r = runtimeProbe("ghost", { manifest: manifestAt(dir) }, { env: {} as NodeJS.ProcessEnv });
    expect(r.ok).toBe(false);
    expect(r.probes[0]?.errorCode).toBe("entrypoint-not-found");
  });
});

describe("runtimeCheck", () => {
  it("默认 skipTurns：回合检查全 skip，handshake/malformed/shutdown pass", async () => {
    const dir = tmp();
    seed(dir, [validEntry()]);
    const r = await runtimeCheck("ep-1", { manifest: manifestAt(dir), timeoutMs: 6000 });
    expect(r.ok).toBe(true);
    expect(r.skippedTurns).toBe(true);
    const byName = Object.fromEntries(r.checks.map((c) => [c.name, c.status]));
    expect(byName.handshake).toBe("pass");
    expect(byName["turn-lifecycle"]).toBe("skip");
    expect(byName.shutdown).toBe("pass");
  }, 30000);

  it("--run-turns：真实回合跑通（journal=false → replay skip）", async () => {
    const dir = tmp();
    seed(dir, [validEntry()]);
    const r = await runtimeCheck("ep-1", {
      manifest: manifestAt(dir),
      timeoutMs: 6000,
      runTurns: true,
      journal: false,
    });
    expect(r.ok).toBe(true);
    expect(r.skippedTurns).toBe(false);
    const byName = Object.fromEntries(r.checks.map((c) => [c.name, c.status]));
    expect(byName["turn-lifecycle"]).toBe("pass");
    expect(byName.replay).toBe("skip");
  }, 30000);

  it("entrypoint 不存在 → CliExit(entrypoint-not-found)", async () => {
    const dir = tmp();
    seed(dir, [validEntry()]);
    await expect(runtimeCheck("ghost", { manifest: manifestAt(dir) })).rejects.toBeInstanceOf(CliExit);
  });

  it("secretRef 未登记 → CliExit(secret-ref-missing)", async () => {
    const dir = tmp();
    // secret store 默认走 <slockDir()>——测试把 SLOCK_STATE_DIR 指到空目录保证缺值
    const stateDir = mkdtempSync(join(tmpdir(), "slock-clirt-state-"));
    dirs.push(stateDir);
    const prev = process.env.SLOCK_STATE_DIR;
    process.env.SLOCK_STATE_DIR = stateDir;
    try {
      seed(dir, [validEntry({ secretRefs: ["DEFINITELY_MISSING_KEY"] })]);
      await expect(runtimeCheck("ep-1", { manifest: manifestAt(dir) })).rejects.toBeInstanceOf(CliExit);
    } finally {
      if (prev === undefined) delete process.env.SLOCK_STATE_DIR;
      else process.env.SLOCK_STATE_DIR = prev;
    }
  });
});

/** doctor 的诊断文件读 SLOCK_STATE_DIR——测试隔离到临时 state 根 */
const withStateDir = <T>(fn: (stateDir: string) => T): T => {
  const stateDir = mkdtempSync(join(tmpdir(), "slock-clirt-state-"));
  dirs.push(stateDir);
  const prev = process.env.SLOCK_STATE_DIR;
  process.env.SLOCK_STATE_DIR = stateDir;
  try {
    return fn(stateDir);
  } finally {
    if (prev === undefined) delete process.env.SLOCK_STATE_DIR;
    else process.env.SLOCK_STATE_DIR = prev;
  }
};

describe("runtimeDoctor（批次 C / P1.5）", () => {
  it("entrypoint 不存在 → CliExit(entrypoint-not-found)", () => {
    const dir = tmp();
    seed(dir, [validEntry()]);
    expect(() => runtimeDoctor("ghost", { manifest: manifestAt(dir) })).toThrowError(CliExit);
  });

  it("manifest 损坏 → CliExit(manifest-invalid)", () => {
    const dir = tmp();
    writeFileSync(manifestAt(dir), "{{{", "utf-8");
    expect(() => runtimeDoctor("ep-1", { manifest: manifestAt(dir) })).toThrowError(CliExit);
  });

  it("合法条目无 probe 快照 → issues 提示跑 probe；manifestEntry 全量本地面", () =>
    withStateDir(() => {
      const dir = tmp();
      seed(dir, [validEntry({ mcpToolAllowlist: ["send_message"] })]);
      const r = runtimeDoctor("ep-1", { manifest: manifestAt(dir) });
      expect(r.ok).toBe(false);
      expect(r.issues.some((i) => i.includes("no probe snapshot"))).toBe(true);
      expect(r.lastProbe).toBeNull();
      expect(r.diagnostics).toBeNull();
      // 本机诊断工具：command/cwd/mcpToolAllowlist 全量可见（不经 server 边界）
      expect(r.manifestEntry?.command).toBe(process.execPath);
      expect(r.manifestEntry?.mcpToolAllowlist).toEqual(["send_message"]);
    }));

  it("probe 快照 fresh → ok；manifest 改过 → stale 标记 + issue", () =>
    withStateDir(() => {
      const dir = tmp();
      seed(dir, [validEntry()]);
      const mp = manifestAt(dir);
      const rev = loadRuntimeManifest(mp).revision;
      writeRuntimeProbeSnapshot(mp, {
        probedAt: "2026-09-22T00:00:00.000Z",
        manifestRevision: rev,
        probes: [{ id: "ep-1", label: "Fixture Graph", status: "installed_unsupported", modelMode: "fixed" }],
      });
      const fresh = runtimeDoctor("ep-1", { manifest: mp });
      expect(fresh.ok).toBe(true);
      expect(fresh.probeStale).toBeUndefined();
      expect(fresh.lastProbe?.status).toBe("installed_unsupported");

      // 改 manifest → revision 变 → 快照 stale
      runtimeEdit("ep-1", { label: "Changed" }, { manifest: mp });
      const stale = runtimeDoctor("ep-1", { manifest: mp });
      expect(stale.probeStale).toBe(true);
      expect(stale.issues.some((i) => i.includes("stale"))).toBe(true);
    }));

  it("诊断文件带 lastError → issues + diagnostics 透出；恢复后 lastOkAt", () =>
    withStateDir(() => {
      const dir = tmp();
      seed(dir, [validEntry()]);
      const mp = manifestAt(dir);
      writeRuntimeProbeSnapshot(mp, {
        probedAt: "2026-09-22T00:00:00.000Z",
        manifestRevision: loadRuntimeManifest(mp).revision,
        probes: [{ id: "ep-1", label: "G", status: "installed_unsupported", modelMode: "fixed" }],
      });
      const diag = createRuntimeDiagnostics(defaultDiagnosticsPath());
      diag.recordError("ep-1", { code: "runtime-start-timeout", message: `worker t/o sk_agent_${"b".repeat(32)}` });

      const r = runtimeDoctor("ep-1", { manifest: mp });
      expect(r.ok).toBe(false);
      expect(r.issues.some((i) => i.includes("runtime-start-timeout"))).toBe(true);
      expect(r.diagnostics?.lastError?.code).toBe("runtime-start-timeout");
      // doctor 输出再过一次脱敏（上游已脱敏，纵深防御）
      expect(JSON.stringify(r.diagnostics)).not.toContain(`sk_agent_${"b".repeat(32)}`);

      diag.recordOk("ep-1");
      const ok = runtimeDoctor("ep-1", { manifest: mp });
      expect(ok.diagnostics?.lastError).toBeUndefined();
      expect(ok.diagnostics?.lastOkAt).toBeTruthy();
      expect(ok.ok).toBe(true);
    }));
});
