import { describe, expect, it, vi } from "vitest";
import { LG_QUERY, useMediaQuery } from "./useMediaQuery";

// node 环境无 window/matchMedia：只可测 SSR/node 回退分支与常量契约。
// matchMedia 订阅/change 监听属浏览器运行时行为，归 DOM 绑定取舍（见审计记录）。
describe("useMediaQuery node 回退（#18）", () => {
  it("node 无 window：matches 恒 false（SSR/node 安全回退，不炸）", () => {
    // Vue 对无实例的 onMounted 仅 dev 告警并跳过注册，属预期；静音避免测试输出噪音
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(typeof window).toBe("undefined");

    const matches = useMediaQuery(LG_QUERY);
    expect(matches.value).toBe(false);
    vi.restoreAllMocks();
  });

  it("LG_QUERY 契约 = Tailwind lg 断点（AppLayout 依赖此常量拼接）", () => {
    expect(LG_QUERY).toBe("(min-width: 1024px)");
  });
});
