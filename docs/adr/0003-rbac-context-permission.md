# ADR-0003: RBAC + 上下文双层权限检查

**Date**: 2026-07-08
**Status**: accepted
**Deciders**: 平台架构组

## Context

平台存在 4 种角色（`system_admin` / `subsidiary_admin` / `pen_tester` / `auditor`），且每种角色在不同 subsidiary 视角下权限不同。例如：
- `system_admin` 在全局视角 → 可看所有
- `system_admin` 以子公司 A 身份 → 只能看 A（与子公司管理员同权）
- `subsidiary_admin` → 始终只能看自己子公司
- `pen_tester` → 仅执行权限，无管理权限

单一角色判断不足以保护数据。需要**双层校验**：(1) 角色本身权限 (2) 当前上下文（effectiveSubsidiaryId）是否被允许。

## Decision

抽象出统一的权限守卫函数，在每个路由 preHandler 中调用：

```typescript
// lib/permissions.ts
export async function checkPermission(
  app: FastifyInstance, req: any,
  required: { resource: ResourceType; action: ResourceAction }
): Promise<{ allowed: boolean; reason?: string }> {
  const role = req.user.role as PlatformRole;
  const ctx = req.user.effectiveSubsidiaryId;  // null = 全局
  // 1. 角色矩阵检查
  const roleDef = ROLE_PERMISSIONS[role];
  if (!roleDef?.permissions.some(p =>
    p.resource === required.resource &&
    p.action === required.action &&
    (p.scope === 'global' || (p.scope === 'subsidiary' && ctx !== null) || (p.scope === 'self' && ctx !== null))
  )) return { allowed: false, reason: 'role denied' };
  // 2. 上下文检查：非管理员 + 全局视角 → 拒绝
  if (role !== 'system_admin' && ctx === null && required.resource !== 'audit') {
    return { allowed: false, reason: 'subsidiary role requires context' };
  }
  return { allowed: true };
}
```

作为 Fastify preHandler 钩子使用：

```typescript
app.post('/group/policies', {
  preHandler: [
    app.authenticate,
    (req) => checkPermission(app, req, { resource: 'admin', action: 'create' }),
  ],
}, async (req) => { /* ... */ });
```

## Alternatives Considered

### Alternative A: 路由级硬编码判断
- **Pros**: 直观
- **Cons**: 每个路由重复写，4 角色 × N 路由 = 易出错
- **Why not**: 维护噩梦，难以审计

### Alternative B: 数据库 RBAC（每用户每资源权限）
- **Pros**: 灵活、动态
- **Cons**: 当前 `role_permissions` 表已存在但未被代码使用；查询性能差
- **Why not**: 角色数少（6 角色），不需要动态 RBAC；可未来扩展

### Alternative C: ABAC（属性基访问控制）
- **Pros**: 表达力最强
- **Cons**: 复杂度高；策略语言难调试；性能差
- **Why not**: 过度工程，当前规模不需要

## Consequences

### Positive
- 权限规则集中在一处，code review 容易
- 双层检查明确分离"角色允许"与"上下文允许"
- 加新角色只需在 `ROLE_PERMISSIONS` 表注册
- 拒绝原因可记入审计日志

### Negative
- 每次请求额外查表（角色 → 权限映射）
- 错误信息泄露风险（"subsidiary role requires context" 可能给攻击者线索）

### Risks
- **Risk**: 权限矩阵设计错误导致越权 → **Mitigation**:
  - ADR-0001 的 effectiveSubsidiaryId 字段是单 source of truth
  - 每次新接口上线必须有 8 种组合测试（4 角色 × 2 上下文）
  - Code review checklist 强制要求权限测试
- **Risk**: 权限检查被遗漏 → **Mitigation**: Fastify preHandler 钩子在框架层强制