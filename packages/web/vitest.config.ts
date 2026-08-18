import { defineConfig } from "vitest/config";

// store/composable 纯逻辑单测：node 环境即可（localStorage/fetch 由测试自行 stub，
// api 模块用 vi.mock 替换），不引入 happy-dom/jsdom 保持依赖最小。
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
