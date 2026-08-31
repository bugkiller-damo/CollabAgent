import { describe, expect, it } from "vitest";
import { collectInsecureConfig, INSECURE_DEV_DEFAULTS, parseTrustProxy } from "../src/lib/config.js";

// O5：配置危险默认值硬校验——collectInsecureConfig 为纯函数，直接断言各分支。
describe("collectInsecureConfig", () => {
  it("全部显式设置时无问题", () => {
    const issues = collectInsecureConfig({
      JWT_SECRET: "s3cur3-random",
      REFRESH_SECRET: "an0ther-random",
      DATABASE_URL: "postgresql://u:p@db:5432/app",
    });
    expect(issues).toEqual([]);
  });

  it("JWT_SECRET 缺失被标记", () => {
    const issues = collectInsecureConfig({
      REFRESH_SECRET: "x",
      DATABASE_URL: "postgresql://u:p@db/app",
    });
    expect(issues.some((i) => i.includes("JWT_SECRET"))).toBe(true);
  });

  it("JWT_SECRET 命中已知默认值被标记", () => {
    const issues = collectInsecureConfig({
      JWT_SECRET: INSECURE_DEV_DEFAULTS.JWT_SECRET,
      REFRESH_SECRET: "x",
      DATABASE_URL: "postgresql://u:p@db/app",
    });
    expect(issues.some((i) => i.includes("JWT_SECRET"))).toBe(true);
  });

  it("REFRESH_SECRET 缺失/默认值都被标记", () => {
    for (const env of [
      { JWT_SECRET: "ok", DATABASE_URL: "postgresql://u:p@db/app" },
      {
        JWT_SECRET: "ok",
        REFRESH_SECRET: INSECURE_DEV_DEFAULTS.REFRESH_SECRET,
        DATABASE_URL: "postgresql://u:p@db/app",
      },
    ]) {
      const issues = collectInsecureConfig(env);
      expect(issues.some((i) => i.includes("REFRESH_SECRET"))).toBe(true);
    }
  });

  it("DATABASE_URL 缺失被标记（不再内置生产可用默认值）", () => {
    const issues = collectInsecureConfig({
      JWT_SECRET: "ok",
      REFRESH_SECRET: "ok",
    });
    expect(issues.some((i) => i.includes("DATABASE_URL"))).toBe(true);
  });

  it("空对象（模拟生产裸启动）报告全部三项", () => {
    const issues = collectInsecureConfig({});
    expect(issues).toHaveLength(3);
  });
});

// P1.13：TRUST_PROXY 解析——默认 fail-closed（不信任任何代理，req.ip = TCP 对端）
describe("parseTrustProxy", () => {
  it("空 / false → 不信任任何代理", () => {
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("   ")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
  });

  it("true → 全信任（仅限流量全部经过可信反代链的部署）", () => {
    expect(parseTrustProxy("true")).toBe(true);
  });

  it("其余 → 逗号分隔可信代理 IP/CIDR 列表（不支持 Express 式跳数，Fastify 语义无此选项）", () => {
    expect(parseTrustProxy("10.0.0.1, 10.0.0.2")).toEqual(["10.0.0.1", "10.0.0.2"]);
    expect(parseTrustProxy("127.0.0.1")).toEqual(["127.0.0.1"]);
    expect(parseTrustProxy("10.0.0.1,,10.0.0.2")).toEqual(["10.0.0.1", "10.0.0.2"]);
  });
});
