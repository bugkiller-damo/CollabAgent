# ADR-0005: 策略下发走 WebSocket 广播通道

**Date**: 2026-07-08
**Status**: accepted
**Deciders**: 平台架构组

## Context

集团中枢智能体下发监管策略（扫描间隔、熔断阈值、禁止操作等）给所有子公司智能体。需要选择推送机制：实时 WebSocket、HTTP 轮询、消息队列。

约束：
- 当前 `ws/handler.ts` 已有 `broadcastToDaemons()` 基础设施
- 子公司 daemon 通过 WebSocket 长连接连入
- 策略变更要求"近实时"生效（不应有分钟级延迟）

## Decision

**WebSocket 广播模式**：策略下发时：

1. 服务端持久化（写入 `servers.config` JSONB 字段）
2. 通过 `broadcastToDaemons()` 向所有 daemon 推送 `policy_update` 消息
3. 在线 daemon 立即生效
4. 离线 daemon 标记为"待同步"，下次连接时拉取最新策略

```typescript
// routes/v1/group.ts
app.post('/policies', async (req) => {
  const { policyType, value, targetSubsidiaryIds } = req.body;
  for (const subId of targetSubsidiaryIds) {
    await app.pg.query(
      `UPDATE servers SET config = config || $1::jsonb WHERE id = $2`,
      [{ [policyType]: value }, subId]
    );
  }
  broadcastToDaemons({
    type: 'policy_update', policyType, value, targetSubsidiaryIds,
    effectiveAt: new Date().toISOString(),
  });
  return { status: 'broadcasted', count: targetSubsidiaryIds.length };
});
```

## Alternatives Considered

### Alternative A: HTTP 轮询（子公司每 30s 拉取）
- **Pros**: 实现简单；离线友好（下次轮询即生效）
- **Cons**: 延迟 30s；浪费流量
- **Why not**: 策略变更需要立即生效

### Alternative B: 引入消息队列（Redis Pub/Sub）
- **Pros**: 可靠、可持久化
- **Cons**: 引入 Redis 依赖；增加架构复杂度
- **Why not**: 当前 WS 已足够支撑

### Alternative C: Server-Sent Events（SSE）
- **Pros**: 单向推送简单
- **Cons**: 仅浏览器支持；daemon 是 Node 进程，需要 WebSocket
- **Why not**: 客户端类型多样

## Consequences

### Positive
- 复用现有 `broadcastToDaemons` 基础设施，零新组件
- 实时生效（< 1s）
- daemon 已通过 WS 长连接，无需额外连接管理

### Negative
- 离线 daemon 在重新连接前不感知策略变更
- 大量子公司时广播消息量 = N × 消息大小

### Risks
- **Risk**: 离线 daemon 错过策略 → **Mitigation**:
  - 客户端实现：连接时先 GET /group/policies 拉取最新
  - 服务端记录每条策略的 `effectiveAt`，离线超过 N 分钟的 daemon 主动告警
- **Risk**: 广播风暴（数千子公司） → **Mitigation**:
  - 子公司 > 100 时切换为分组广播（按 region/segment）
  - 策略采用增量更新（仅发变更字段）