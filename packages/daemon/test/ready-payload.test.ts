import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildReadyPayload, probeBridgeEntrypoints, readDaemonVersion } from "../src/ready-payload.js";

describe("buildReadyPayload", () => {
  it("带上 package.json 版本、os/arch、传入的 runtimes", () => {
    const payload = buildReadyPayload([
      { id: "claude", status: "installed", version: "1.0" },
      { id: "codex", status: "not_installed" },
    ]);
    expect(payload.type).toBe("ready");
    expect(payload.daemonVersion).toBe(readDaemonVersion());
    expect(payload.os).toBe(process.platform);
    expect(payload.arch).toBe(process.arch);
    expect(payload.hostname.length).toBeGreaterThan(0);
    expect(payload.runtimes).toHaveLength(2);
    expect(payload.capabilities).toEqual(["send", "read"]);
  });

  it("identity 缺省不带 machineUuid/serverName（旧 daemon 兼容路径）", () => {
    const payload = buildReadyPayload([]);
    expect("machineUuid" in payload).toBe(false);
    expect("serverName" in payload).toBe(false);
  });

  it("identity 携带时透传 machineUuid/serverName", () => {
    const payload = buildReadyPayload([], { machineUuid: "mu-1", serverName: "server001" });
    expect(payload.machineUuid).toBe("mu-1");
    expect(payload.serverName).toBe("server001");
  });

  it("Phase 1：entrypoints 参数透传；缺省不携带键", () => {
    const without = buildReadyPayload([]);
    expect("entrypoints" in without).toBe(false);
    const withEps = buildReadyPayload([], undefined, [
      {
        id: "ep-1",
        runtime: "langgraph",
        label: "Graph",
        status: "installed_unsupported",
        modelMode: "fixed",
        models: ["gpt-4o"],
        defaultModel: "gpt-4o",
      },
    ]);
    expect(withEps.entrypoints).toHaveLength(1);
    expect(withEps.entrypoints?.[0]?.id).toBe("ep-1");
  });
});

describe("probeBridgeEntrypoints", () => {
  afterEach(() => {
    delete process.env.SLOCK_EXPERIMENTAL_BRIDGE_RUNTIMES;
    delete process.env.SLOCK_RUNTIME_MANIFEST;
  });

  it("SLOCK_EXPERIMENTAL_BRIDGE_RUNTIMES 未开 → undefined（不带键）", () => {
    delete process.env.SLOCK_EXPERIMENTAL_BRIDGE_RUNTIMES;
    expect(probeBridgeEntrypoints(process.env)).toBeUndefined();
  });

  it("开启但 manifest 缺失 → 空数组（探测过、无条目）", () => {
    const dir = mkdtempSync(join(tmpdir(), "slock-ready-"));
    try {
      const env = {
        ...process.env,
        SLOCK_EXPERIMENTAL_BRIDGE_RUNTIMES: "1",
        SLOCK_RUNTIME_MANIFEST: join(dir, "absent.json"),
      };
      expect(probeBridgeEntrypoints(env)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
