# Sprint 1 实施报告 — Server 端高影响易修复

> 实施日期：2026-07-15 | 基于 `docs/2026-07-14/server-analysis.md` Sprint 1 规划
> 状态：✅ 全部完成（6/6 项）

---

## 完成项

| # | 任务 | 说明 | 验证 |
|---|---|---|---|
| 1 | **auth.ts 路由拆分 → profile.ts** | 将认证模块中非认证职责的 7 个端点移至 profile.ts，新增 PATCH / 支持 avatarUrl，合并重复的 change-password | ✅ 16/16 测试通过 |
| 2 | **统一 authenticate 用法** | 消除 18 处 `(server/app as any).authenticate` → 全部改为类型安全的 `server.authenticate` / `app.authenticate` | ✅ 编译通过 |
| 3 | **messages.ts 动态 import 改静态** | 热路径中 `await import()` 改为顶层 `import` | ✅ 编译通过 |
| 4 | **优雅关闭** | 注册 SIGTERM/SIGINT：正常关闭 WS 连接后退出 DB | ✅ 测试通过 |
| 5 | **健康检查增强** | `/api/health` 增加 DB 连通检测 | ✅ 测试通过 |

---

## 测试结果

```
Test Files  5 passed (5)
Tests       16 passed (16)
```

服务器日志确认新的 `/api/profile/me`、`/api/profile/deactivate`、`/api/profile/export` 端点正常运行。

---

## 关联文档

- [`server-analysis.md`](server-analysis.md) — 原始分析报告（Sprint 2-6 计划待跟）
