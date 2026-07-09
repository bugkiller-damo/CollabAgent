# ADR-0002: 跨子公司数据隔离采用应用层过滤

**Date**: 2026-07-08
**Status**: accepted
**Deciders**: 平台架构组

## Context

集团场景下，集团管理员需要既能查看全局数据（跨子公司聚合），又要能"以子公司 A 身份"查看 A 的数据。数据隔离要求所有 SQL 查询必须按 `effectiveSubsidiaryId` 过滤，但全局视图需要跨子公司聚合。需要在两种需求间取得平衡。

约束：
- 当前架构 Fastify + PostgreSQL + postgres-js driver
- 已有 `servers / assets / penetration_tasks / cases` 等 22 张表
- 大部分表已有 `subsidiary_id` 外键字段
- 当前 v1 路由是 hardcoded 的单 subsidiary 查询

## Decision

采用**应用层过滤**（application-level filtering）模式：
- 业务路由读取 `req.user.effectiveSubsidiaryId`
- 若为 null（集团全局视角）→ 不加过滤（聚合查询）
- 若为 UUID → 强制附加 `WHERE subsidiary_id = $X`
- 集团专用路由（`/group/*`）无视 effectiveSubsidiaryId，直接做跨子公司查询

抽象成统一的辅助函数：

```typescript
// lib/orgs.ts
export function buildSubsidiaryFilter(
  effectiveSubsidiaryId: string | null,
  params: any[]
): { sql: string; params: any[] } {
  if (effectiveSubsidiaryId === null) {
    return { sql: "", params };
  }
  params.push(effectiveSubsidiaryId);
  return { sql: `WHERE subsidiary_id = $${params.length}`, params };
}
```

## Alternatives Considered

### Alternative A: PostgreSQL Row-Level Security (RLS)
- **Pros**: 数据库强制隔离，难以绕过；性能好（数据库层过滤）
- **Cons**: 需要为每张表写 RLS 策略；难以做跨子公司聚合（集团查询要 BYPASSRLS）；与现有 postgres-js driver 集成需用 SET LOCAL ROLE；调试复杂
- **Why not**: 集团聚合查询与 RLS 互斥；当前 driver 不友好

### Alternative B: 数据库视图 + 行级权限
- **Pros**: 数据库层隔离
- **Cons**: 视图嵌套影响性能；灵活性差（每个新查询都要建视图）
- **Why not**: 维护成本高，难以扩展

### Alternative C: 每个查询写两次（集团版 + 子公司版）
- **Pros**: 完全分离，无歧义
- **Cons**: 代码重复 2-3 倍；新接口需双倍实现
- **Why not**: 维护成本不可接受

## Consequences

### Positive
- 集团路由与子公司路由代码清晰分离
- 一行 `buildSubsidiaryFilter` 即可为任意查询加过滤
- 现有 SQL 几乎不需要改（仅添加 WHERE 子句）
- 测试覆盖可针对单一函数

### Negative
- 开发者必须记得调用辅助函数（漏调 = 数据泄露风险）
- 集团聚合查询需手动写跨子公司 JOIN/SUM，性能调优复杂
- 复杂查询（如跨多表的统计）需要单独优化

### Risks
- **Risk**: 开发者漏加过滤函数 → 数据越权 → **Mitigation**:
  - Code review checklist 强制要求
  - 集成测试覆盖"漏加过滤"场景（mock 异常值验证）
  - 关键表加 `subsidiary_id NOT NULL` 约束（已有）
  - 未来可加 lint 规则自动检测 SQL 中是否含 `subsidiary_id`