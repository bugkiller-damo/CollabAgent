import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { slockDir } from "../src/private-dir.js";

/**
 * H6：`.slock` 状态树根解析——默认 cwd/.slock，`SLOCK_STATE_DIR` 整体搬迁。
 */
describe("slockDir", () => {
  afterEach(() => {
    delete process.env.SLOCK_STATE_DIR;
  });

  it("未设 SLOCK_STATE_DIR 时返回 cwd/.slock", () => {
    expect(slockDir()).toBe(join(process.cwd(), ".slock"));
  });

  it("SLOCK_STATE_DIR 覆盖整棵状态树", () => {
    process.env.SLOCK_STATE_DIR = "D:\\slock-state-test";
    expect(slockDir()).toBe("D:\\slock-state-test");
  });

  it("相对路径的 SLOCK_STATE_DIR resolve 成绝对路径；空白值回落默认", () => {
    process.env.SLOCK_STATE_DIR = "state-dir-rel";
    const p = slockDir();
    expect(isAbsolute(p)).toBe(true);
    expect(p.endsWith("state-dir-rel")).toBe(true);

    process.env.SLOCK_STATE_DIR = "   ";
    expect(slockDir()).toBe(join(process.cwd(), ".slock"));
  });
});
