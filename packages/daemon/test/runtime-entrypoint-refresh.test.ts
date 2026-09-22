import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeManifestSnapshot } from "../src/agent-runtime-manifest.js";
import { createEntrypointRefresher } from "../src/runtime-entrypoint-refresh.js";

/**
 * 批次 B / P1.2：manifest revision 迁移 watcher——loader() 观察到的 revision
 * 变化驱动一次 probe + send（daemon-core 包成 entrypoints:refresh）；同
 * revision 不重复推；probe 结果快照可关（persistSnapshot:false）。
 */

let dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "slock-refresh-"));
  dirs.push(d);
  return d;
};

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const snapshot = (revision: string, dir: string): RuntimeManifestSnapshot => ({
  path: join(dir, "runtimes.json"),
  revision,
  entries: new Map(),
  invalidEntries: new Map(),
});

describe("createEntrypointRefresher", () => {
  it("revision 变化 → probe 一次 + send 一次；同 revision 不重复", () => {
    const dir = tmp();
    let rev = "rev-a";
    const send = vi.fn();
    const r = createEntrypointRefresher({
      loader: () => snapshot(rev, dir),
      send,
      persistSnapshot: false,
      probeDeps: { env: {} },
    });
    r.tick(); // 基线
    expect(send).toHaveBeenCalledTimes(1); // tick 路径：首次建立基线也算一次刷新
    r.tick();
    expect(send).toHaveBeenCalledTimes(1); // 同 revision 不重复
    rev = "rev-b";
    r.tick();
    expect(send).toHaveBeenCalledTimes(2);
    rev = "rev-b";
    r.tick();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("start() 建立基线不发帧（ready 已报过）；之后 tick 检测变更", () => {
    const dir = tmp();
    let rev = "rev-a";
    const send = vi.fn();
    const r = createEntrypointRefresher({
      loader: () => snapshot(rev, dir),
      send,
      persistSnapshot: false,
      probeDeps: { env: {} },
      intervalMs: 60_000,
    });
    r.start();
    expect(send).not.toHaveBeenCalled(); // 基线静默
    rev = "rev-c";
    r.tick();
    expect(send).toHaveBeenCalledTimes(1);
    r.stop();
  });

  it("probe 结果含安全摘要形状（空 manifest → 空数组也推，server 据此清空）", () => {
    const dir = tmp();
    const send = vi.fn();
    const r = createEntrypointRefresher({
      loader: () => snapshot("rev-x", dir),
      send,
      persistSnapshot: false,
      probeDeps: { env: {} },
    });
    r.tick();
    expect(send).toHaveBeenCalledWith([]);
  });

  it("persistSnapshot 默认开：probe 结果落 runtime-probe-last.json", async () => {
    const dir = tmp();
    const send = vi.fn();
    const r = createEntrypointRefresher({
      loader: () => snapshot("rev-y", dir),
      send,
      probeDeps: { env: {} },
    });
    r.tick();
    const { readRuntimeProbeSnapshot } = await import("../src/runtime-probe-snapshot.js");
    const stored = readRuntimeProbeSnapshot(join(dir, "runtimes.json"));
    expect(stored?.manifestRevision).toBe("rev-y");
    expect(stored?.probes).toEqual([]);
  });
});
