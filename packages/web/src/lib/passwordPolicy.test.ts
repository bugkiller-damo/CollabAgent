import { describe, expect, it } from "vitest";
import { validatePasswordPolicy } from "./passwordPolicy";

// P1-14：前端镜像 server validatePassword（≥8+字母+数字）。
// 实锤样例取自审计 #14：abc123（6 位，过旧客户端被 server 400）、abcdefgh（纯字母过旧客户端）。
describe("validatePasswordPolicy（P1-14 密码策略单点）", () => {
  it("审计实锤样例：短密码/纯字母/纯数字全部拦截且文案与 server 同源", () => {
    expect(validatePasswordPolicy("abc123")).toBe("密码至少 8 位"); // 6 位：旧客户端放行、server 400
    expect(validatePasswordPolicy("abc1234")).toBe("密码至少 8 位"); // 7 位边界
    expect(validatePasswordPolicy("abcdefgh")).toBe("密码需包含数字"); // 纯字母：旧客户端放行
    expect(validatePasswordPolicy("12345678")).toBe("密码需包含字母"); // 纯数字
  });

  it("合法密码（≥8 含字母数字）放行", () => {
    expect(validatePasswordPolicy("abcd1234")).toBeNull();
    expect(validatePasswordPolicy("longerp4ssword!")).toBeNull();
  });
});
