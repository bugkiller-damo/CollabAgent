import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findDistAsset } from "../src/dist-assets.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dist-assets-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("findDistAsset", () => {
  it("envVar override wins and returns resolved path", () => {
    const file = join(root, "custom-cli.cjs");
    writeFileSync(file, "x");
    const found = findDistAsset("cli.cjs", {
      envVar: "SLOCK_CLI_BUNDLE",
      env: { SLOCK_CLI_BUNDLE: file, SLOCK_DAEMON_ROOT: join(root, "nowhere") },
    });
    expect(found).toBe(file);
  });

  it("finds <root>/<file> before <root>/dist-bundle/<file>", () => {
    const flat = join(root, "cli.cjs");
    mkdirSync(join(root, "dist-bundle"), { recursive: true });
    writeFileSync(join(root, "dist-bundle", "cli.cjs"), "x");
    writeFileSync(flat, "x");
    const found = findDistAsset("cli.cjs", { root, env: {} });
    expect(found).toBe(flat);
  });

  it("falls back to <root>/dist-bundle/<file> when flat file absent", () => {
    mkdirSync(join(root, "dist-bundle"), { recursive: true });
    const nested = join(root, "dist-bundle", "daemon.cjs");
    writeFileSync(nested, "x");
    const found = findDistAsset("daemon.cjs", { root, env: {} });
    expect(found).toBe(nested);
  });

  it("SLOCK_DAEMON_ROOT env is used when opts.root absent", () => {
    mkdirSync(join(root, "dist-bundle"), { recursive: true });
    const nested = join(root, "dist-bundle", "daemon.cjs");
    writeFileSync(nested, "x");
    const found = findDistAsset("daemon.cjs", { env: { SLOCK_DAEMON_ROOT: root } });
    expect(found).toBe(nested);
  });

  it("returns null when nothing matches (dev repo without build)", () => {
    // roots 替换全部候选——隔离测试进程 argv[1]/import.meta 解析到真实仓库
    expect(findDistAsset("cli.cjs", { roots: [root], env: {} })).toBeNull();
  });

  it("missing envVar file falls through to root probing", () => {
    mkdirSync(join(root, "dist-bundle"), { recursive: true });
    const nested = join(root, "dist-bundle", "cli.cjs");
    writeFileSync(nested, "x");
    const found = findDistAsset("cli.cjs", {
      envVar: "SLOCK_CLI_BUNDLE",
      env: { SLOCK_CLI_BUNDLE: join(root, "nonexistent.cjs") },
      root,
    });
    expect(found).toBe(nested);
  });
});
