# ADR-0004: 集团仪表盘使用单 SQL 聚合查询

**Date**: 2026-07-08
**Status**: accepted
**Deciders**: 平台架构组

## Context

集团仪表盘需要展示：总子公司数、总任务数（按状态分布）、总漏洞数（按等级分布）、集团病例库、最近 7 天活跃 Top10 子公司。数据来自 5+ 张表（servers, penetration_tasks, penetration_results, cases, alerts）。

## Decision

采用**单 SQL 聚合查询 + 应用层组合**模式：
- 每个 KPI 一个独立 SQL（5-7 个并行查询）
- 应用层负责拼装响应
- 总子公司数查询带缓存（5 分钟）
- 总漏洞数实时（用户预期看到实时数据）

```typescript
// routes/v1/group.ts
async function getDashboardMetrics(app: FastifyInstance) {
  const [totalSubs, taskStats, vulnStats, caseStats, recentSubs] = await Promise.all([
    app.pg.query(`SELECT count(*)::int as c FROM servers WHERE type='subsidiary'`),
    app.pg.query(`SELECT status, count(*)::int as c FROM penetration_tasks GROUP BY status`),
    app.pg.query(`SELECT severity, count(*)::int as c FROM penetration_results GROUP BY severity`),
    app.pg.query(`SELECT status, count(*)::int as c FROM cases GROUP BY status`),
    app.pg.query(`
      SELECT s.id, s.name, count(t.id)::int as task_count
      FROM servers s LEFT JOIN penetration_tasks t ON t.subsidiary_id = s.id
        AND t.created_at > now() - interval '7 days'
      WHERE s.type='subsidiary'
      GROUP BY s.id ORDER BY task_count DESC LIMIT 10
    `),
  ]);
  return { totalSubsidiaries: totalSubs.rows[0].c, /* ... */ };
}
```

## Alternatives Considered

### Alternative A: 实时查询（每次请求都查 DB）
- **Pros**: 实现简单
- **Cons**: 多表 JOIN 慢；并发差时延迟明显
- **Why not**: 仪表盘访问频率高（登录后即看），需要稳定性能

### Alternative B: 物化视图（Materialized View）
- **Pros**: 预计算快
- **Cons**: 需要定期刷新；schema 变更需重建；增加运维成本
- **Why not**: 数据量不大（22 张表，< 100K 行），实时查询足够

### Alternative C: 引入缓存层（Redis）
- **Pros**: 极快
- **Cons**: 引入新依赖；缓存失效策略复杂
- **Why not**: 当前未使用 Redis；过度工程

## Consequences

### Positive
- 5-7 个并行查询，总耗时 ~100ms（单机 PostgreSQL）
- 缓存 + 实时的混合策略平衡性能与新鲜度
- 单 SQL 易调试（可用 `EXPLAIN ANALYZE` 优化）

### Negative
- 增加 7 张表的全表扫描（数据增长后需关注）
- 子查询嵌套层数 ≤3，否则需重写为 CTE

### Risks
- **Risk**: 数据增长后查询变慢 → **Mitigation**:
  - 关键字段已加索引（subsidiary_id, created_at）
  - 增加查询超时保护（statement_timeout = 5s）
  - 数据 > 100K 行时引入缓存层（ADR 后续重新评估）
- **Risk**: 子查询导致性能问题 → **Mitigation**: 使用 `EXPLAIN ANALYZE` 验证；超过 200ms 触发告警