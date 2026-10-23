import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computerList,
  computerRemove,
  computerSetup,
  computerStop,
  pidAlive,
  resolveComputerTarget,
} from "../src/cli/computer.js";
import {
  type ComputerProfiles,
  loadComputerProfiles,
  normalizeServerName,
  removeComputerProfile,
  saveComputerProfile,
} from "../src/computer-registry.js";
import { CliExit } from "../src/output.js";

/**
 * `slock computer`（raft-computer 式装机/启停）的本地面测试：
 * registry CRUD + 名字归一 + setup 校验 + target 解析 + stop 幂等。
 * spawn 路径（computerStart 真实拉起 supervisor）不进单测——进程树副作用
 * 留给实机；这里钉住的是「参数解析 → profile → pidfile」这条可测链。
 */

let dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "slock-computer-"));
  dirs.push(d);
  return d;
};
const registryAt = (dir: string) => join(dir, "servers.json");
const daemonRoot = () => tmp(); // 裸目录充当包根（start/stop 只在其下放 .slock）

const validOpts = { serverUrl: "http://server.local:3001", apiKey: `sk_machine_${"a".repeat(32)}` };

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("normalizeServerName", () => {
  it("前导斜杠可省略（raft 手感），空值归一为 ''", () => {
    expect(normalizeServerName("/bugkillers-test-server")).toBe("bugkillers-test-server");
    expect(normalizeServerName("bugkillers-test-server")).toBe("bugkillers-test-server");
    expect(normalizeServerName("//x")).toBe("x");
    expect(normalizeServerName("  /y  ")).toBe("y");
    expect(normalizeServerName(undefined)).toBe("");
    expect(normalizeServerName("/")).toBe("");
  });
});

describe("computer-registry store", () => {
  const profile = { serverUrl: "http://s:3001", apiKey: "sk_machine_x", enrolledAt: "2026-10-23T00:00:00Z" };

  it("save → load 回读；remove 收敛；缺文件 → 空表", () => {
    const dir = tmp();
    const path = registryAt(dir);
    expect(loadComputerProfiles(path)).toEqual({});
    saveComputerProfile("a", profile, path);
    saveComputerProfile("b", { ...profile, machineUuid: "u-1" }, path);
    const all = loadComputerProfiles(path);
    expect(Object.keys(all).sort()).toEqual(["a", "b"]);
    expect(all.b?.machineUuid).toBe("u-1");
    expect(removeComputerProfile("a", path)).toBe(true);
    expect(removeComputerProfile("a", path)).toBe(false);
    expect(Object.keys(loadComputerProfiles(path))).toEqual(["b"]);
  });

  it("损坏 JSON → 空表不抛；无 serverUrl/apiKey 的脏条目被过滤", () => {
    const dir = tmp();
    const path = registryAt(dir);
    writeFileSync(path, "{not json", "utf-8");
    expect(loadComputerProfiles(path)).toEqual({});
    writeFileSync(path, JSON.stringify({ good: profile, bad: { serverUrl: 1 } }), "utf-8");
    expect(Object.keys(loadComputerProfiles(path))).toEqual(["good"]);
  });
});

describe("computerSetup / computerList / computerRemove", () => {
  it("setup 落盘 profile（machine/stateDir/daemonRoot 透传），list 脱敏 token", () => {
    const dir = tmp();
    const registryPath = registryAt(dir);
    const root = daemonRoot();
    const r = computerSetup(
      "/bugkillers-test-server",
      { ...validOpts, machine: "47d4557a-11b4", stateDir: join(dir, "state") },
      { registryPath, daemonRoot: root },
    );
    expect(r.ok).toBe(true);
    const saved = loadComputerProfiles(registryPath)["bugkillers-test-server"];
    expect(saved).toMatchObject({
      serverUrl: validOpts.serverUrl,
      apiKey: validOpts.apiKey,
      machineUuid: "47d4557a-11b4",
      daemonRoot: root,
    });
    const listed = computerList({ registryPath });
    expect(listed.data.servers[0]?.apiKey).toBe("sk_machine_***");
    expect(JSON.stringify(listed)).not.toContain(validOpts.apiKey);

    expect(computerRemove("/bugkillers-test-server", { registryPath }).ok).toBe(true);
    expect(() => computerRemove("ghost", { registryPath })).toThrowError(CliExit);
  });

  it("缺 url/key / 非 http(s) → CliExit；非法 server 名同理", () => {
    const dir = tmp();
    const registryPath = registryAt(dir);
    expect(() => computerSetup("a", { apiKey: "k" }, { registryPath })).toThrowError(CliExit);
    expect(() => computerSetup("a", { serverUrl: "ftp://x", apiKey: "k" }, { registryPath })).toThrowError(CliExit);
    expect(() => computerSetup("a", { serverUrl: "notaurl", apiKey: "k" }, { registryPath })).toThrowError(CliExit);
    expect(() => computerSetup("/", validOpts, { registryPath })).toThrowError(CliExit);
    expect(loadComputerProfiles(registryPath)).toEqual({});
  });
});

describe("resolveComputerTarget", () => {
  const p = { serverUrl: "http://s", apiKey: "k", enrolledAt: "t" };
  const profiles: ComputerProfiles = { a: p, b: p };

  it("显式名命中；单登记自动当选；多登记缺名 / 未登记名 → CliExit", () => {
    expect(resolveComputerTarget("/a", profiles).name).toBe("a");
    expect(resolveComputerTarget(undefined, { only: p }).name).toBe("only");
    expect(() => resolveComputerTarget(undefined, profiles)).toThrowError(CliExit);
    expect(() => resolveComputerTarget("ghost", profiles)).toThrowError(CliExit);
    expect(() => resolveComputerTarget(undefined, {})).toThrowError(CliExit);
  });
});

describe("computerStop（幂等）", () => {
  it("pidfile 缺失/死 pid → not running，ok=true", () => {
    const dir = tmp();
    const registryPath = registryAt(dir);
    const root = daemonRoot();
    computerSetup("s1", validOpts, { registryPath, daemonRoot: root });
    const r = computerStop("s1", { registryPath, daemonRoot: root });
    expect(r.ok).toBe(true);
    expect(r.data.killed).toEqual([]);
    // pidfile 写了不合法的 0/负数 → 视为 not running
    mkdirSync(join(root, ".slock"), { recursive: true });
    writeFileSync(join(root, ".slock", "computer-launcher.pid"), "0", "utf-8");
    expect(computerStop(undefined, { registryPath, daemonRoot: root }).data.killed).toEqual([]);
  });
});

describe("pidAlive", () => {
  it("本进程存活", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });
});
