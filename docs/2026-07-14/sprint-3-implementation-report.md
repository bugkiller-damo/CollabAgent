# Sprint 3 实施报告 — 安全保障

> 实施日期：2026-07-15 | 16/16 测试通过
> 状态：✅ 7/7 项全部完成

| # | 任务 | 变更 |
|---|---|---|
| 11 | **JWT Secret 集中配置** | 新建 `lib/config.ts`，10 项配置统一管理，启动校验告警 |
| 12 | **Machine token cost 统一** | profile.ts cost=8 → 12 |
| 13 | **Refresh Token 轮换** | refresh 吊销旧会话→创新会话→发新 refresh |
| 14 | **全局限流中间件** | `lib/rate-limit.ts`，sensitive 5/min / auth 20/min / api 100/min |
| 15 | **CSRF Token 轮换** | refresh 时每次重新生成 CSRF |
| 16 | **WS 心跳** | 30s ping/10s pong 超时断开 |
| 17 | **上传类型白名单** | `isAllowedMimeType()` 校验，ALLOWED_MIME_TYPES 可配 |

**更新文件**：index.ts、ws/handler.ts、auth.ts、profile.ts、connection.ts、storage.ts、attachments.ts、agents-messages.ts

**新建文件**：lib/config.ts、lib/rate-limit.ts
