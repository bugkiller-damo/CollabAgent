# ADR-0001: JWT 携带 effectiveSubsidiaryId 实现上下文切换

**Date**: 2026-07-08
**Status**: accepted
**Deciders**: 平台架构组

## Context

平台需要支持集团管理员在「全局视角」与「以某子公司身份操作」之间切换。当前 JWT 仅包含 `userId / handle / role`，无法表达"当前以哪个子公司身份查看数据"。需要一种机制让单一 JWT 同时承载多子公司身份切换的语义。

约束：
- JWT 必须保持无状态（不要每次切换都查数据库）
- 切换必须是显式的、可审计的（每次切换写入审计日志）
- 子公司管理员不应能切换到其他子公司视角
- 前端需要在 UI 上明确显示当前视角

## Decision

扩展 JWT payload，新增 `effectiveSubsidiaryId: UUID | null` 字段：
- `null` = 全局视角（仅 system_admin 角色允许）
- `UUID` = 以该子公司视角查看

上下文切换通过独立端点实现：

```
POST /api/v1/auth/switch-context
  请求: { subsidiaryId: null | UUID }
  响应: { token, effectiveSubsidiaryId, role, expiresAt }

GET  /api/v1/auth/current-context
  响应: { role, effectiveSubsidiaryId, availableSubsidiaries[] }
```

## Alternatives Considered

### Alternative A: URL query 参数 (`?subsidiaryId=xxx`)
- **Pros**: 实现简单，无需切换 token
- **Cons**: 容易被跨站/跨链接泄露；每个请求都需要传；不支持在单一请求中"我是子公司 A 身份但请求子公司 B 数据"
- **Why not**: 安全风险高且无法统一处理

### Alternative B: 多 Cookie 携带切换上下文
- **Pros**: 浏览器自动附带
- **Cons**: 跨域处理复杂；多个 source of truth（cookie + JWT）；攻击面更大
- **Why not**: 引入额外的认证状态分裂，难以审计

### Alternative C: 每次切换查数据库（基于 session）
- **Pros**: 实时生效、可强制下线
- **Cons**: 破坏 JWT 无状态特性；每次请求增加 DB 查询
- **Why not**: 与现有 JWT 架构冲突，扩展性差

## Consequences

### Positive
- JWT 仍是唯一认证 source of truth，便于排查
- 切换语义清晰（重新签发 token），前后端无需额外状态机
- 与现有 httpOnly cookie 模式天然兼容
- 切换事件可记入 `audit_logs`，便于追溯

### Negative
- 切换后旧 token 仍短期有效（TTL 期内）—— 通过短 TTL（如 15 分钟）缓解
- 角色升级风险：必须在服务端严格校验切换请求的角色权限（见 ADR-0003）

### Risks
- **Risk**: 切换过程中 token 泄露导致越权 → **Mitigation**: JWT TTL 缩短至 15 分钟；切换需 CSRF token；审计日志记录 IP/UA
- **Risk**: 系统管理员被恶意切换到非授权子公司 → **Mitigation**: 服务端校验目标子公司必须在管理员有权列表内