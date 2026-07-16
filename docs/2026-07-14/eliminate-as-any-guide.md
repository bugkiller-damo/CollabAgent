# 歼灭 `as any` 行动指南

> 目标：消除 server 端 186 处 `as any`，评分 7.60→8.50
> 估算：2-3 小时 | 涉及 25 个文件

---

## 三大模式

### A — `rows[0] as any`（~80 处）

```typescript
// ❌
const user = r.rows[0] as any;

// ✅
interface UserRow { id: string; handle: string }
const user = r.rows[0] as UserRow;
```

### B — `(req as any).xxx`（~60 处）

```typescript
// types/fastify.d.ts — 增强 FastifyRequest
declare module "fastify" {
  interface FastifyRequest {
    user: { sub: string; handle?: string; sid?: string };
  }
}
// 使用处：req.user.sub 已类型化
```

### C — `req.body as any`（~30 处）

```typescript
// ❌
const { name } = req.body as any;

// ✅
interface Body { name?: string }
const { name } = req.body as Body;
```

---

## 先决条件（第 1 步做）

```typescript
// types/fastify.d.ts
import "fastify";
declare module "fastify" {
  interface FastifyRequest {
    user: { sub: string; handle?: string; sid?: string; display_name?: string };
  }
  interface FastifyInstance {
    authenticate: any;
    pg: { query: <T = any>(text: string, params?: unknown[]) => Promise<{ rows: T[] }> };
  }
}
```

## 执行顺序（按文件）

lib/ 文件（7 个，共 18 处）→ routes/ 小文件（5 个）→ routes/ 大文件（8 个）→ index.ts + ws/

完整文件列表见 `/d/code/slock/docs/2026-07-14/eliminate-as-any-guide.md`

## 验证

```bash
cd packages/server && npx tsc --noEmit && pnpm test
```
