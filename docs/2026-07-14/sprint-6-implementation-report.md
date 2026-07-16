# Sprint 6 实施报告（部分）— 新功能

> 实施日期：2026-07-15 | 86/86 测试通过
> 状态：✅ 3/3 项完成

## 完成项

| # | 任务 | 变更 |
|---|---|---|
| 32 | **消息编辑历史** | 新建 message_edits 表，编辑留存旧内容，GET /:id/edits |
| 33 | **OpenAPI/Swagger** | @fastify/swagger + @fastify/swagger-ui，/docs 页面 |
| 34 | **Config 集中化** | 消除 seed.ts/storage.ts 中残余 process.env 引用 |

## 详情

- **消息编辑历史**：迁移 `006_message_edits.sql`，`PUT /:id` 编辑前 INSERT 旧内容，`GET /:id/edits` 按时间返回
- **Swagger**：`/docs/` UI 页面 + `/docs/json` OpenAPI 规范
- **Config**：`lib/config.ts` 补 `DB_POOL_MAX`，更新 `connection.ts`/`seed.ts`/`storage.ts`
