import { describe, expect, it } from "vitest";
import { collectInsecureConfig, INSECURE_DEV_DEFAULTS } from "../src/lib/config.js";

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
