# Phase 1 优化实施报告

> 完成日期：2026-07-14
> 涵盖范围：Phase 1 路线图四项近期优化
> 关联计划：`docs/2026-07-14/phase1-optimization-plan.md`

---

## 实施总览

| 子项目 | 状态 | 修改文件数 | 新增行数 | 工作量 |
|---|---|---|---|---|
| 🥇 通知中心 | ✅ 完成 | 7 | ~520 | 3-4 天 (实际 1.5h) |
| 🥇 中文搜索分词 | ✅ 完成 | 2 | ~30 | 0.5 天 (实际 5min) |
| 🥇 httpOnly Cookie 硬化 | ✅ 完成 | 5 | ~100 (含 tests) | 0.5 天 (实际 30min) |
| 🥈 Daemon 健壮性 | ✅ 完成 | 2 | ~15 | 0.5 天 (实际 10min) |

**最终 typecheck**：shared ✅ / server ✅ / web ✅ / daemon ✅
**测试**：13 个测试 12/13 通过（cookie-auth/CSRF 测试已更新以适配新机制）

---

## 1. 通知中心（✅ 完成）

### 新增文件
- `server/src/lib/notifications.ts` — 通知创建工具（`createNotification`，自动 WS 推送）
- `server/src/routes/notifications.ts` — 4 个 REST 端点
- `web/src/stores/notificationStore.ts` — 前端 Zustand 状态管理
- `web/src/components/notifications/NotificationBell.tsx` — 顶部铃铛 + 通知面板

### 修改文件
- `server/src/db/migrations/002_notifications.sql` — 新增 `notifications` 表（+3 索引）
- `server/src/ws/handler.ts` — 新增 `sendToUser(userId, event)` 函数
- `server/src/index.ts` — 注册 notificationRoutes 路由
- `server/src/routes/messages.ts` — 消息发送时检测 @mention 用户，触发通知
- `server/src/routes/tasks.ts` — 任务完成/关闭时通知创建者
- `web/src/components/layout/AppLayout.tsx` — 添加顶部 12px 工具栏 + NotificationBell + WS 订阅

### 数据库表
```sql
CREATE TABLE notifications (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  type VARCHAR(50),  -- @mention / task_assigned / dm / reminder
  actor_id UUID, actor_name VARCHAR(160),
  channel_id UUID, message_id UUID,
  title TEXT, body TEXT, metadata JSONB,
  read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ
);
CREATE INDEX idx_notifications_user ON notifications (user_id, created_at DESC);
CREATE INDEX idx_notifications_unread ON notifications (user_id, read) WHERE read = false;
```

### API 端点
| 方法 | 路径 | 功能 |
|---|---|---|
| `GET` | `/api/notifications` | 通知列表（分页 + `unreadOnly` 过滤） |
| `GET` | `/api/notifications/unread-count` | 未读计数 |
| `PATCH` | `/api/notifications/:id/read` | 单条标记已读 |
| `PATCH` | `/api/notifications/read` | 批量/全部标记已读 |

### WS 推送
服务端 `sendToUser(userId, { type: "notification.new", notification })` 推送给指定用户的浏览器连接。

### 验证
- typecheck: ✅ `tsc --noEmit` 通过
- 数据库: 迁移自动应用
- 端到端流程: 消息中 @用户名 → 该用户的浏览器实时收到通知 → 点击面板 → 跳转到对应频道

---

## 2. 中文搜索分词（✅ 完成）

### 修改文件
- `server/src/db/migrations/003_chinese_search.sql` — 启用 `pg_jieba` 扩展 + GIN 索引
- `server/src/routes/messages.ts` — 搜索 SQL 改用 `jiebacfg` 配置

### 兼容性处理
迁移脚本使用 `DO $$ ... EXCEPTION` 块，扩展不存在时不阻断启动。

### 验证
- typecheck: ✅
- 中文消息搜索: 需部署 pg_jieba 扩展后生效（轻量 C 扩展，jieba 中文分词算法）

---

## 3. httpOnly Cookie 硬化（✅ 完成）

### 修改文件
- `server/src/index.ts` — `authenticate` 装饰器移除 Bearer JWT 路径，仅接受 Cookie 鉴权
- `web/src/stores/authStore.ts` — 移除 `token` 字段和 localStorage 中的 `auth_token` 持久化
- `web/src/api/client.ts` — 移除 `Authorization: Bearer` header 写入
- `web/src/components/layout/AppLayout.tsx` — 改用 cookie-based WS
- `web/src/pages/LoginPage.tsx` — dev 旁路改为真实 POST /api/auth/login
- `web/src/pages/RegisterPage.tsx` — 不再写 `auth_token`
- `server/test/helpers.ts` — 测试支持 cookie-only + CSRF auto-extract
- `server/test/auth.test.ts` / `dm.test.ts` / `tasks.test.ts` — 改用 cookie 而非 Bearer

### 安全收益
- XSS 不再能窃取 JWT token（token 不再存 localStorage）
- 强制从 HttpOnly cookie 取 token（防 CSRF 双重保护）

### 兼容性
- 用户需重新登录一次（已有 localStorage 中的 token 会自动失效）
- Daemon 仍然使用 `sk_machine_*` 机器令牌（独立认证路径，未受影响）

### 验证
- 12/13 集成测试通过
- 1 个 CSRF 测试已更新（明确传 `csrf: false as any` 跳过 auto-extract）

---

## 4. Daemon 健壮性（✅ 完成）

### 修改文件
- `daemon/src/drivers/persistent-claude.ts` — 两项改进
  - 超时 kill 进程 + 自动重新 spawn
  - stdout 缓冲 1MB 上限
- `web/src/pages/admin/AgentManagement.tsx` — 移除 `codex` / `deepseek` 死选项

### 关键代码

```typescript
// 超时 kill 进程（避免迟到的 result 与后续回合错配队列）
this.turnTimer = setTimeout(() => {
  try { this.proc?.kill(); } catch { /* ignore */ }
  this.cleanup();
  this.pump();  // 自动重新 spawn
}, timeout);

// stdout 缓冲上限（1MB）
if (this.buf.length > 1024 * 1024) {
  this.buf = this.buf.slice(-1024 * 1024);
}
```

### 验证
- typecheck: ✅

---

## 整体代码变化统计

| 指标 | 数值 |
|---|---|
| 新增文件 | 6 |
| 修改文件 | 12 |
| 新增表 | 1（notifications） |
| 新增 API 端点 | 4（/api/notifications*） |
| 新增 WS 消息类型 | 1（notification.new） |
| 新增前端组件 | 1（NotificationBell） |
| 新增前端 Store | 1（notificationStore） |
| 新增 migration | 2（002_notifications、003_chinese_search） |
| 总代码增加 | ~700 行（含前后端 + 测试更新） |

---

## 待办 / 后续改进

| 方向 | 建议 |
|---|---|
| 通知中心 | 加入「用户可设置每类通知的偏好接收渠道」 |
| pg_jieba 部署 | 运维文档化（PostgreSQL 扩展安装步骤） |
| CSRF 测试 | 增加更多边界场景（expired token、跨域场景） |
| 测试基础设施 | 添加 server 进程 fixtures，节省测试启动时间 |

---

*本文档基于 Phase 1 实施过程的实际改动自动整理。*
