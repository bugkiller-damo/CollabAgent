import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computerLogs, computerStatus } from "../src/cli/computer.js";

let home: string;
let registryPath: string;
let stateDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "slock-comp-"));
  registryPath = join(home, ".slock", "servers.json");
  stateDir = join(home, "state");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(home, ".slock"), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({ smoke: { serverUrl: "http://x", apiKey: "sk_machine_t", stateDir } }));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("computerLogs", () => {
  it("默认 50 行；不足 50 行返回全部；末尾空行剔除", () => {
    writeFileSync(join(stateDir, "daemon.log"), "l1\nl2\nl3\n");
    const r = computerLogs("smoke", undefined, { registryPath });
    expect(r.ok).toBe(true);
    expect(r.data.tail).toEqual(["l1", "l2", "l3"]);
    expect(r.data.total).toBe(4);
  });

  it("--lines N 只取末尾 N 行；超出文件行数按实际返回", () => {
    writeFileSync(join(stateDir, "daemon.log"), "1\n2\n3\n4\n5\n");
    const r = computerLogs("/smoke", { lines: 2 }, { registryPath });
    expect(r.data.tail).toEqual(["4", "5"]);
    const over = computerLogs("smoke", { lines: 99 }, { registryPath });
    expect(over.data.tail).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("日志不存在 → fail（CliExit）", () => {
    expect(() => computerLogs("smoke", undefined, { registryPath })).toThrowError(/CliExit/);
  });
});

describe("computerStatus", () => {
  it("无 pidfile → 双 dead；有 daemon.log 时带 log 路径", () => {
    writeFileSync(join(stateDir, "daemon.log"), "x\n");
    const r = computerStatus("smoke", { registryPath });
    expect(r.ok).toBe(true);
    expect(r.data.running).toBe(false);
    expect(r.data.launcher).toEqual({ pid: null, alive: false });
    expect(r.data.daemon).toEqual({ pid: null, alive: false });
    expect(r.data.stateDir).toBe(stateDir);
    expect(r.data.log).toBe(join(stateDir, "daemon.log"));
    expect(r.data.autostart).toBe(false);
  });

  it("pidfile 指向死 pid → alive=false 且保留 pid 值", () => {
    writeFileSync(join(stateDir, "computer-launcher.pid"), "99999999\n");
    writeFileSync(join(stateDir, "daemon.pid"), "99999998\n");
    const r = computerStatus("smoke", { registryPath });
    expect(r.data.launcher).toEqual({ pid: 99999999, alive: false });
    expect(r.data.daemon).toEqual({ pid: 99999998, alive: false });
    expect(r.data.running).toBe(false);
  });
});
