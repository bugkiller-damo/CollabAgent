import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { isBcryptHash, sha256Token, verifyTokenHash } from "../src/lib/token-hash.js";

describe("token-hash: sha256 快路径", () => {
  it("sha256Token 输出 64 位 hex 且确定性", () => {
    const h = sha256Token("sk_machine_abc");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Token("sk_machine_abc")).toBe(h);
    expect(sha256Token("sk_machine_abd")).not.toBe(h);
  });

  it("isBcryptHash：$2a/$2b/$2y 前缀为真，hex 为假", () => {
    expect(isBcryptHash("$2a$10$abcdefghijklmnopqrstuvwxyz012345678901234567890")).toBe(true);
    expect(isBcryptHash("$2b$10$abcdefghijklmnopqrstuvwxyz012345678901234567890")).toBe(true);
    expect(isBcryptHash("$2y$10$abcdefghijklmnopqrstuvwxyz012345678901234567890")).toBe(true);
    expect(isBcryptHash("a".repeat(64))).toBe(false);
    expect(isBcryptHash("")).toBe(false);
  });

  it("verifyTokenHash：sha256 存储值直接比对（不走 bcrypt）", async () => {
    const stored = sha256Token("sk_machine_x");
    expect(await verifyTokenHash("sk_machine_x", stored)).toBe(true);
    expect(await verifyTokenHash("sk_machine_y", stored)).toBe(false);
  });

  it("verifyTokenHash：bcrypt 存储值走 compare 分流（旧令牌兼容）", async () => {
    const stored = bcrypt.hashSync("sk_machine_legacy", 4);
    expect(isBcryptHash(stored)).toBe(true);
    expect(await verifyTokenHash("sk_machine_legacy", stored)).toBe(true);
    expect(await verifyTokenHash("sk_machine_wrong", stored)).toBe(false);
  });
});
