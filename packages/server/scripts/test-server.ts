/**
 * 集成测试专用 server 实例 — `pnpm test:server`
 *
 * NODE_ENV=test：rate-limit.ts 全跳过限流（大套件批量注册用户不再撞 20/min）。
 * 端口默认 3011（vitest.config 会探测该端口健康后自动指过来；显式 PORT 可覆盖）。
 * dotenv 不覆盖已存在的 process.env——这里设的 PORT/NODE_ENV 在 .env 加载后仍生效。
 */
process.env.NODE_ENV = "test";
process.env.PORT = process.env.PORT || "3011";

await import("../src/index.js");
