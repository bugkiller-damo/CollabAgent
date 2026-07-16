# Server 端可优化方向分析报告

> 分析日期：2026-07-15 | 基于 `packages/server/src/` 全量代码通读
> 范围：功能性、架构质量、性能、安全、测试覆盖、可运维性

---

## 一、总览

Server 端共 **30 个源文件**（3,662 行 TypeScript）+ **6 个测试文件**（337 行）。整体基于 Fastify 5 + PostgreSQL，结构清晰，
但在代码组织、测试覆盖、性能、安全等方面存在可优化的空间。

### 当前做得好的

| 方面 | 评述 |
|---|---|
| 路由模块化 | 12 个 route 文件按功能拆分，prefix 统一，不错 |
| WebSocket 双通道模型 | daemon 与 browser 独立管理，channel-aware 定向投递 |
| 令牌认证 | 完整的三路径认证（cookie JWT / machine token / dev-token）+ 会话管理 |
| CSRF 防护 | double-submit cookie 模式覆盖所有改写型 API |
| 原子认领 | 提醒调度使用 `FOR UPDATE SKIP LOCKED` 实现多实例安全 |
| 指标系统 | 内存计数器 + 60s 持久化到 DB + 7 天保留策略 |
| 存储抽象 | Storage 接口设计良好，预留 MinIO/S3 扩展点 |
| 软删除 | 账户注销使用软删 + PII 清空策略，兼顾合规与消息完整性 |
| 统一错误处理 | setErrorHandler 结构化记录 + 不泄露堆栈 |

---

## 二、功能缺口

### 🟥 高优先级

| # | 缺失功能 | 说明 |
|---|---|---|
| 1 | **API 全局限流** | 目前仅登录有内存限流（5 次锁定 15 分钟），其余 API 无限制，存在暴力破解/滥用风险 |
| xxxxxxxxxx cd packages/server && pnpm typecheck && pnpm testbash | **WS 鉴权超时** | 浏览器 WS 握手仅解析 cookie，token 过期后仍可维持连接（只首次鉴权） |
| 3 | **消息编辑审计** | 编辑后无历史版本记录，无法追溯恶意改图/改内容 |
| 4 | **文件上传校验** | 无文件类型白名单、无病毒扫描、无每个文件大小上限独立配置 |
| 5 | **置顶消息** | 无 pinned_messages 表或对应 API，用户无法固定重要消息 |

### 🟨 中优先级

| # | 缺失功能 | 说明 |
|---|---|---|
| 6 | **查询超时** | 所有 SQL 查询无超时配置，慢查询可能耗尽连接池 |
| 7 | **批量消息操作** | 不支持批量删除、批量标记已读（通知已支持，消息未支持） |
| 8 | **用户屏蔽** | 无法屏蔽/静音指定用户的消息和通知 |
| 9 | **DM 分页** | `/api/channels/dms` 返回全量列表，频道多时可能很慢 |
| 10 | **Webhook 推送** | 不支持外部 webhook 集成（消息/事件推送） |
| 11 | **OAuth 集成** | integrations 表已设计但 `/api/integrations/login` 只是占位 |

### 🟩 低优先级

| # | 缺失功能 |
|---|---|
| 12 | 数据导出格式单一（仅 JSON） |
| 13 | 无 OpenAPI/Swagger 文档 |
| 14 | 无批量邀请功能 |
| 15 | 无频道归档恢复（archived 不能取消） |
| 16 | 无 Server-Sent Events 替代 WS 轻量通知 |

---

## 三、代码质量问题

### 3.1 路由组织混乱

**auth.ts** 包含了不应属于认证模块的端点：
- `POST /profile/password` 改密码
- `PATCH /profile` 更新资料
- `POST /change-password` 改密码（与上一个重复！）
- `GET /me` 获取当前用户
- `GET /export` 数据导出
- `POST /deactivate` 注销账户
- `POST /machine-token` 生成机器令牌

这些应该放在 `profile.ts` 中。同时存在两个改密码端点（`/profile/password` 和 `/change-password`），功能重复。

### 3.2 agents.ts 过大

**645 行** —— 远超其他 route 文件（平均 150 行）。包含：
- 消息发送/接收
- 频道/服务器信息
- 任务 CRUD
- 表情反应
- 搜索
- 资料管理
- 提醒 CRUD
- 提醒日志

应拆分为 `agents-messages.ts`、`agents-tasks.ts`、`agents-reminders.ts`。

### 3.3 index.ts 内联路由过多

`index.ts` 有 **469 行**，包含约 30 个不通过 `register()` 注册的内联端点：
- `/api/health`、`/api/daemon/status`、`/api/metrics`
- `/api/agents`（GET/POST/PATCH/DELETE + 完整逻辑）
- 全套组织管理 `/api/orgs/*`（GET 列表/成员/邀请/CRUD）
- 邀请链接 `/api/invites/:token`
- 服务器信息 `/api/server/info`

这些应拆分为独立的 route 文件。

### 3.4 authenticate 装饰器不一致

两种调用方式并存：

```typescript
// 方式一（推荐，类型安全）
{ preHandler: [app.authenticate] }

// 方式二（类型强制转换，散布在 index.ts 和 notifications.ts）
{ preHandler: [(server as any).authenticate] }
```

16 处使用 `(server as any).authenticate`，应统一。

### 3.5 代码重复

| 模式 | 出现次数 | 文件 |
|---|---|---|
| `SELECT id FROM channels WHERE name = $1` | 12 次 | messages.ts / tasks.ts / agents.ts / channels.ts / index.ts |
| Reactions JSON 聚合子查询 | 4 次 | messages.ts (GET/ /history) / agents.ts (receive/history) |
| Attachments JSON 聚合子查询 | 4 次 | messages.ts (send/GET/history) / agents.ts |
| `daemonClients.has(...)` 判定在线 | 3 次 | index.ts (GET /metrics + GET /api/agents) / agents.ts |
| 动态 SQL 参数构建模式 | 5 次+ | profile.ts / channels.ts / agents.ts / index.ts |
| 频道名解析（去 #、拆线程后缀） | 4 次 | messages.ts / tasks.ts / agents.ts |

### 3.6 动态 import 滥用

`routes/messages.ts` 在 **热路径** 中频繁使用动态 import：

```typescript
const { createNotification } = await import("../lib/notifications.js");
const { inc } = await import("../lib/metrics.js");
```

每次发消息都动态 import，尽管 Node.js 有模块缓存，但 `await import()` 返回 Promise 仍有微基准开销。
应改为顶层静态 import。

### 3.7 snake_case / camelCase 混合

路由中的 SQL 别名混合使用：

```sql
m.sender_id as "senderId",      -- camelCase
m.created_at as "time"          -- 缩写
m.edited_at as "editedAt"       -- camelCase
```

而某些地方直接返回 snake_case（`channel_id`、`server_id`），前端需要额外映射。

---

## 四、性能问题

### 4.1 大查询每次全量执行

消息列表查询（`GET /api/messages`）每次加载都完整执行反应聚合子查询 + 附件聚合子查询。
对于 50 条消息的页面，两个嵌套子查询对每条消息都运行。

**建议**：引入 Redis 缓存 reaction 计数，或为消息列表添加物化视图。

### 4.2 无连接池调优

`postgres`（`pg` 包的现代替代）使用默认连接池配置（可能低或无限）。
没有配置 `pool_max` / `pool_min` / `idle_timeout`。

### 4.3 N+1 查询模式

`/api/agents` 列表获取后逐条查在线状态（虽然用 daemonClients Map 实现了 O(1) 查找，但仍有线性扫描）。

更严重的是 `/api/orgs` 组织成员查询：
```sql
(SELECT count(*)::int FROM server_members WHERE server_id = s.id) as "memberCount",
(SELECT count(*)::int FROM agents WHERE server_id = s.id) as "agentCount"
```
关联子查询扫描全表。

### 4.4 Metrics 表增长

60s 周期性写入 metrics_samples，7 天后删除。如果有 1000 个采样点，7 天产生 ~1000 条。
随着实例运行时间增长，DELETE 操作压力增大。

**建议**：改用分区表（按月）或压缩历史数据。

### 4.5 无请求级缓存

- `getDefaultServerId()` 有进程级缓存（已做 ✅）
- 但频道信息查询、频道成员角色查询没有缓存，每次请求都查 DB
- `canAccessChannel()` 每次请求 2 次 SQL 查询（type + 成员角色）

### 4.6 日志性能

Fastify logger 设为 `true`（默认 info 级别），生产环境可能日志过多。
应支持 `LOG_LEVEL` 环境变量配置。

---

## 五、安全问题

### 5.1 JWT Secret 硬编码默认值

3 处使用相同默认值：

```typescript
// index.ts (fastify-jwt 注册)
secret: process.env.JWT_SECRET || "dev-secret-change-in-production"

// ws/handler.ts (WS 连接鉴权)
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";

// auth.ts (refresh token)
const REFRESH_SECRET = process.env.REFRESH_SECRET || "dev-refresh-secret";
```

`"dev-secret-change-in-production"` 是公开的已知值，生产环境未设置环境变量时直接暴露。

### 5.2 Machine Token 哈希成本低

`auth.ts` 中机器令牌使用 bcrypt cost=8（hash 函数第 2 参数），比用户密码的 cost=12 低。理论上应一致。

### 5.3 Refresh Token 无轮换

`POST /api/auth/refresh` 每次刷新发回新的 access_token，但 refresh_token 本身不变。
被窃取的 refresh_token 可无限使用。应实现 refresh token rotation。

### 5.4 CSRF Token 无轮换

每次 `setAuthCookies` 生成新的 CSRF token，但 refresh 端点不签发新 CSRF。
登录态长期保持时 CSRF token 不变，增加风险。

### 5.5 SQL 注入风险

少数地方使用字符串拼接构建 SQL：

```typescript
// profile.ts:43-45
"UPDATE users SET display_name = COALESCE($2, display_name), description = COALESCE($3, description), updated_at = now() WHERE id = $1"
```

大多数使用参数化查询 `$1, $2` 模式，但需要审计所有拼接处。

### 5.6 DaemonMeta 未限制大小

`daemonMeta` Map 存储每个连接的 `hostname`、`daemonVersion`、`runtimes` 列表，
没有大小限制。如果大量 daemon 连接不断创建/断开，可能导致内存泄漏。

### 5.7 浏览器客户端 Map 无清理

`ws/handler.ts` 中的 Set 在客户端断开时清理，但如果连接异常断开（进程崩溃、网络中断），
可能导致死连接集合残留。需要心跳 + 过期清理。

---

## 六、测试覆盖

### 现状

| 测试文件 | 行数 | 覆盖内容 |
|---|---|---|
| `auth.test.ts` | 74 | 注册/登录/刷新/退出 基本流程 |
| `dm.test.ts` | 56 | DM 频道创建 + 发消息 |
| `tasks.test.ts` | 31 | 任务 CRUD |
| `health.test.ts` | 20 | Health endpoint |
| `metrics.test.ts` | 44 | 指标端点 |
| `helpers.ts` | 112 | 测试工具函数 |

### 未覆盖的核心功能

| 路由文件 | 端点数 | 测试覆盖 |
|---|---|---|
| `routes/messages.ts` | 9 端点 | ❌ 无测试 |
| `routes/channels.ts` | 12 端点 | ❌ 无测试 |
| `routes/notifications.ts` | 4 端点 | ❌ 无测试 |
| `routes/agents.ts` | ~20 端点 | ❌ 无测试 |
| `routes/attachments.ts` | 2 端点 | ❌ 无测试 |
| `routes/auth.ts` | ~15 端点 | ✅ 仅基础流程 |
| `ws/handler.ts` | — | ❌ 无测试 |
| `lib/*` | — | ❌ 无单元测试 |

### 测试改进建议

1. **补充消息模块测试**：发送、编辑、删除、搜索、历史分页
2. **补充频道模块测试**：创建、邀请、权限控制、DM 列表
3. **补充 Agent 模块测试**：消息接收、任务 CRUD、提醒 CRUD
4. **补充 WebSocket 测试**：连接鉴权、广播投递、私有频道过滤
5. **补充单元测试**：cookies、access、dm、reminders 工具函数
6. **补充安全测试**：CSRF 校验、SQL 注入尝试、权限越权

---

## 七、可运维性

### 7.1 健康检查不完整

当前 `/api/health` 只返回静态 `{ status: "ok" }`，不检查：
- 数据库连接状态
- WebSocket 服务状态
- 磁盘空间（上传目录）

### 7.2 无优雅关闭

未注册 `process.on('SIGTERM')` / `SIGINT` 处理器：
- WS 连接未正常关闭
- DB 连接池未 drain
- 进行中的请求被截断

### 7.3 日志不够结构化

- 请求日志中不包含用户标识
- 错误日志中无请求体（body 泄露隐私风险已考虑，但可选择性记录）
- 无慢查询日志

### 7.4 错误计数器永不重置

`inc("errors")` 只增不减，`GET /api/metrics` 返回历史累加值，无法判断当前健康状态。

**建议**：增加 `rate`（每分钟/每小时错误数）计算。

### 7.5 提醒调度器无退避

`startReminderScheduler` 固定的 20s 轮询间隔。
如果 daemon 全部离线，20s 间隔空转消耗资源。应支持动态间隔。

### 7.6 配置散落各处

| 配置 | 位置 | 默认值 |
|---|---|---|
| JWT_SECRET | index.ts, ws/handler.ts | dev-secret-change-in-production |
| REFRESH_SECRET | auth.ts | dev-refresh-secret |
| DATABASE_URL | connection.ts | hardcoded |
| PORT | index.ts | 3001 |
| HOST | index.ts | 0.0.0.0 |
| UPLOAD_DIR | storage.ts | cwd/uploads |

配置分散在多个文件中，应集中到一个 config 模块。

### 7.7 测试 environment 无显示名

`test/helpers.ts` 创建测试用户使用 hardcoded 值，测试失败时难以追踪是哪个测试的问题。

---

## 八、优化优先级建议

### Sprint 1 — 高影响易修复（1-2 天）

| # | 任务 | 影响 | 估算 |
|---|---|---|---|
| 1 | `auth.ts` 路由拆分：将 profile/password/me/export/deactivate/machine-token 移到 `profile.ts` | 代码组织 | 30min |
| 2 | 统一 `authenticate` 用法（消除 `(server as any).authenticate`） | 代码一致性 | 15min |
| 3 | `messages.ts` 中动态 import 改为顶层静态 import | 微性能 | 10min |
| 4 | 统一 SQL 字段别名风格（camelCase vs snake_case） | 前端兼容 | 30min |
| 5 | 增加 `process.on('SIGTERM')` 优雅关闭 | 🐛 运维 | 20min |
| 6 | `/api/health` 增加 DB 连通性检查 | 运维 | 10min |

### Sprint 2 — 核心路由拆分（1-2 天）

| # | 任务 | 说明 | 估算 |
|---|---|---|---|
| 7 | `agents.ts` 拆分为 3-4 个文件（messages/tasks/reminders/profile） | 降低文件复杂度 | 1h |
| 8 | `index.ts` 内联端点抽成独立 route 文件（orgs、invites、agents 内联） | 50+ 行清理出 index.ts | 1h |
| 9 | 频道名解析逻辑提取为公共 lib 函数 | 消除 12 处重复 | 30min |
| 10 | Reactions + Attachments JSON 聚合提取为 SQL 视图或公共函数 | 消除 4 处重复 SQL | 30min |

### Sprint 3 — 安全保障（1-2 天）

| # | 任务 | 说明 | 估算 |
|---|---|---|---|
| 11 | JWT Secret 集中配置 + 启动时校验环境变量 | 防部署事故 | 15min |
| 12 | Machine token bcrypt cost 统一到 12 | 加固 | 5min |
| 13 | Refresh Token Rotation 实现 | 防 refresh 盗用 | 30min |
| 14 | 全局限流中间件（基于内存或 Redis） | 防滥用 | 1h |
| 15 | CSRF Token 在 refresh 时轮换 | 加固 | 10min |
| 16 | WS 心跳 + 过期连接清理 | 防资源泄漏 | 30min |
| 17 | 文件上传类型白名单 + 大小独立配置 | 防恶意上传 | 20min |

### Sprint 4 — 测试补充（2-3 天）

| # | 任务 | 端点/函数数 | 估算 |
|---|---|---|---|
| 18 | 消息模块测试（9 端点） | 9 | 1h |
| 19 | 频道模块测试（12 端点） | 12 | 1h |
| 20 | 通知模块测试（4 端点） | 4 | 30min |
| 21 | 附件模块测试（2 端点） | 2 | 20min |
| 22 | Agent 模块基础测试 | ~10 | 1h |
| 23 | lib/ 工具函数单元测试 | ~8 函数 | 30min |
| 24 | WebSocket handler 集成测试 | — | 1h |

### Sprint 5 — 性能优化（1-2 天）

| # | 任务 | 说明 | 估算 |
|---|---|---|---|
| 25 | 消息查询缓存（reactions 计数 cache） | 减少重复聚合查询 | 1h |
| 26 | DB 连接池显式配置（pool_max） | 防连接耗尽 | 15min |
| 27 | `getDefaultServerId` 缓存有效性校验（加 TTL） | 加固 | 10min |
| 28 | Metrics 表分区策略 | 改善长周期查询性能 | 30min |
| 29 | `canAccessChannel` 增加缓存（进程级短 TTL） | 减少重复查询 | 20min |

### Sprint 6 — 新功能（按需）

| # | 任务 | 说明 |
|---|---|---|
| 30 | 置顶消息（pinned_messages 表 + API） | 用户视角高感知 |
| 31 | Webhook 推送 | 外部系统集成 |
| 32 | 消息编辑历史 | 审计能力 |
| 33 | OpenAPI/Swagger 文档自动生成 | 开发者体验 |
| 34 | Config 模块集中化 | 工程规范 |

---

## 九、文件级细节

### 9.1 各文件量化指标

| 文件 | 行数 | 复杂度 | 问题 |
|---|---|---|---|
| `src/index.ts` | 469 | 🔴 极高 | 内联路由过多 |
| `src/routes/agents.ts` | 645 | 🔴 极高 | 需拆分 |
| `src/routes/auth.ts` | 380 | 🟡 高 | 责任混杂 |
| `src/routes/messages.ts` | 274 | 🟡 高 | SQL 重复 |
| `src/routes/channels.ts` | 265 | 🟡 中 | 正常 |
| `src/ws/handler.ts` | 204 | 🟡 中 | 功能集中 |
| `src/routes/notifications.ts` | 73 | 🟢 低 | 清晰 |
| `src/routes/tasks.ts` | 128 | 🟢 低 | 清晰 |
| `src/routes/profile.ts` | 67 | 🟢 低 | 过于简单，未包含应有内容 |
| `src/lib/*` (11 文件) | 均值 50 | 🟢 低 | 整体良好 |

### 9.2 重复代码统计

| 重复段 | 重复次数 | 建议 |
|---|---|---|
| 频道名 → id 解析 | 12 次 | 提为 `lib/channel.ts` 的 `resolveChannelId()` |
| Reactions 聚合 | 4 次 | 创建 SQL 视图 `v_message_reactions` |
| Attachments 聚合 | 4 次 | 创建 SQL 视图 `v_message_attachments` |
| 动态 SET 构建 | 5 次 | 提为 `lib/sql.ts` 的 `buildSetClause()` |

### 9.3 已废弃/死代码

| 代码 | 位置 | 说明 |
|---|---|---|
| `"dev-token"` 兼容路径 | index.ts:63 | 用于开发环境快速鉴权，应检测 `NODE_ENV` 决定是否启用 |
| ioredis 依赖 | package.json | 声明但未使用 |
| `POST /auth/profile/password` | auth.ts:247 | 与 `POST /auth/change-password` 功能重复 |

---

## 十、关联文档

- [`项目完成情况报告.md`](项目完成情况报告.md) — 总体项目状态
- [`todo-pending.md`](todo-pending.md) — 待做任务追踪
- [`frontend-ux-analysis.md`](frontend-ux-analysis.md) — 前端 UI 分析

---

*本文档基于代码库完整通读自动生成，建议每轮优化后更新。*
