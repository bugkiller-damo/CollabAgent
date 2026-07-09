# Architecture Decision Records

> 本目录记录分层架构增强（Phase 后续）的核心架构决策。
> 每个 ADR 是一次**明确的决策**，记录动机、备选方案与权衡。

| ADR | 标题 | 状态 | 日期 |
|-----|------|------|------|
| [0001](0001-jwt-context-switching.md) | JWT 携带 effectiveSubsidiaryId 实现上下文切换 | accepted | 2026-07-08 |
| [0002](0002-app-level-data-isolation.md) | 跨子公司数据隔离采用应用层过滤 | accepted | 2026-07-08 |
| [0003](0003-rbac-context-permission.md) | RBAC + 上下文双层权限检查 | accepted | 2026-07-08 |
| [0004](0004-aggregated-dashboard-queries.md) | 集团仪表盘使用单 SQL 聚合查询 | accepted | 2026-07-08 |
| [0005](0005-websocket-policy-broadcast.md) | 策略下发走 WebSocket 广播通道 | accepted | 2026-07-08 |

## 主题索引

### 认证与权限
- ADR-0001: JWT 上下文切换机制
- ADR-0003: RBAC + 上下文双层检查

### 数据访问
- ADR-0002: 跨子公司隔离策略
- ADR-0004: 集团聚合查询实现

### 通信与通知
- ADR-0005: 策略下发通道

## 状态说明

- **proposed**: 决策讨论中，未最终敲定
- **accepted**: 决策生效，正在实施
- **deprecated**: 决策已不再适用
- **superseded**: 被更新的 ADR 取代（必填替换 ADR 编号）