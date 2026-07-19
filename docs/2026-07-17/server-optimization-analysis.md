# Slock Server 端优化方向分析

> 日期：2026-07-17  
> 范围：`packages/server/src/`（约 4200 行，17 个路由文件、17 个 lib 模块、12 个测试文件）  
> 背景：此前 `docs/2026-07-14/server-review-scorecard.md` 评分 7.50/10（Phase A 止血已完成）。本文档基于当前代码重新通读，聚焦**尚未修复**的问题与新的优化方向。

---

## 一、总览

当前 server 端基础较扎实：Fastify 5 + postgres.js + JWT/Cookie 双态认证 + CSRF double-submit + 全局限流 + WS 心跳 + 12 个集成测试文件。此前 Phase A（dev-token 后门、CORS、hasMore、错误格式、`as any` 歼灭）已完成。

但仍存在 **2 个确定的线上 Bug、10 个安全缺口、1 个严重性能问题**，以及若干架构级改进空间。

---

## 二、🔴 确定的 Bug（建议立即修复）

### Bug 1：`@提及` 用户通知永远发不出去 — `content.split(/s+/)` 正则丢反斜杠

**位置**：`src/routes/messages.ts:118`

```ts
// 第一段（agent 提及，line 100）是正确的：
for (const word of content.split(/\s+/)) { ... }

// 第二段（用户提及通知，line 118）反斜杠丢了：
for (const word of content.split(/s+/)) { ... }   // ← 按字面量 "s+" 切分
```

`/s+/` 是按字面字符 `s` 切分而不是按空白切分。结果：`"hi @alice"` 这种最常见的提及（@ 不在消息开头）永远解析不出 handle，**普通用户的 @mention 通知基本不会触发**（Agent 提及走的是第一段，正常）。

**修复**：改回 `content.split(/\s+/)`，并把两段重复逻辑合并成一个解析函数。

### Bug 2：机器令牌认证是全表 bcrypt 扫描 — 每次 daemon 请求 O(N) 慢哈希

**位置**：`src/index.ts:125-137` 与 `src/ws/handler.ts:64-68`

```ts
const result = await server.pg.query(
  "SELECT user_id, server_id, scope, token_hash FROM machine_tokens WHERE token_prefix = 'sk_machine_' AND revoked_at IS NULL"
);
for (const row of result.rows) {
  if (await bcrypt.compare(token, row.token_hash)) { ... }
}
```

问题链：
1. `machine_tokens.token_prefix` 在签发时写入的是**字面常量** `"sk_machine_"`（`src/routes/profile.ts:155-164`），不是每个令牌唯一的前缀。
2. 因此 `WHERE token_prefix = 'sk_machine_'` 会捞出**系统里所有未吊销的机器令牌**。
3. 对每一条做 `bcrypt.compare`（单次约 50-100ms）。10 个令牌 = 每次认证约 1 秒 CPU 阻塞。
4. 该路径被**每个 daemon 的每次 API 请求和每次 WS 握手**命中，是服务端最贵的热路径。

**修复**（二选一）：
- **方案 A（推荐）**：机器令牌本身是高熵随机串，无需 bcrypt 抗爆破。改为存 `sha256(token)` 哈希，认证时 `WHERE token_hash = sha256(入参)` 走唯一索引直接命中，O(1)。
- **方案 B**：签发时把令牌随机段的前 12-16 位作为 `token_prefix` 落库，认证时按前缀精确查出单行，再做一次 `bcrypt.compare`。

方案 A 同时适用于 `agent_credentials`（`src/index.ts:105-120` 目前是按 agentId 查单行，尚可，但同样可换成 sha256 直接查找）。

---

## 三、🟠 安全缺口

### S1：附件下载接口无认证 — 任何人可凭 UUID 拉文件

**位置**：`src/routes/attachments.ts:41`

```ts
app.get("/:id", async (req, reply) => { ... })   // 没有 preHandler: [app.authenticate]
```

消息附件的元数据和字节流对**未登录用户**完全开放。UUID 虽难猜，但一旦链接泄露（转发、日志、搜索引擎）即永久暴露。

**修复**：加 `app.authenticate`，并按「附件关联消息的频道成员」校验访问权（`canAccessChannel`）。

### S2：私有频道可通过 ID 直接加入 — join 接口不校验频道类型

**位置**：`src/routes/channels.ts:91-100`

```ts
app.post("/:channelId/join", { preHandler: [app.authenticate] }, async (req) => {
  await app.pg.query("INSERT INTO channel_members ... ON CONFLICT DO NOTHING", ...);
});
```

任何登录用户拿到私有频道 UUID 即可自行 `join` 成为成员，绕过邀请制。对比之下读取消息有 `canAccessChannel` 把关，但 join 这条写入路径是敞开的。

**修复**：join 前查频道 `type`，`private` 频道只允许 `canManageChannel` 的人代邀（走已有的 `/invite` 路径），公开频道才允许自主 join。

### S3：`/api/users` 全量用户名单无认证

**位置**：`src/index.ts:214-219`

未登录即可拉取全站用户的 `handle / display_name / avatar_url`，可被用于撞库、社工和爬虫。

**修复**：加 `app.authenticate`。

### S4：匿名浏览器 WS 客户端可收公开频道全量消息

**位置**：`src/ws/handler.ts:58-79`

浏览器 WS 握手 token 校验失败时不拒绝连接，而是降级为 `"anon"` 用户登记；`broadcast()` 对公开频道是全员投递（`src/ws/handler.ts:170-178`），anon 连接一样收到消息内容。任何人无需账号即可监听所有公开频道。

**修复**：浏览器 WS 在 token 无效时直接 `close(4001)`（daemon 路径已这么做），或至少不给 anon 投递消息内容。

### S5：Swagger UI 生产环境裸奔

**位置**：`src/index.ts:71`

`/docs` 展示完整 API 结构。生产环境建议仅在 `NODE_ENV !== 'production'` 时注册，或加认证。（注：当前路由未挂 JSON Schema，`/docs` 实际接近空壳——见 A6。）

### S6：配置默认值仅 warn 不阻断

**位置**：`src/lib/config.ts:22-25`

`JWT_SECRET` / `REFRESH_SECRET` / `DATABASE_URL` 使用默认值时只打印警告。生产环境应直接 `process.exit(1)` 拒绝启动。另：`config.ts:11` 的 `DATABASE_URL` 默认值含硬编码密码 `P@ssw0rd`，应从仓库中移除。

### S7：Reminders 全端点 IDOR — 可读/改/删他人提醒

**位置**：`src/routes/reminders.ts:39-85`

`GET /:id`、`PATCH /:id`、`DELETE /:id`、`snooze`、`log` 全部只按提醒 `id` 过滤，**不校验 `owner_id`**。任何登录用户拿到（或枚举到）提醒 ID 即可读取/修改/取消他人提醒。

**修复**：所有按 id 操作的端点加 `AND owner_id = $userId`（或显式校验后 403）。

### S8：JWT 只验签不验状态 — 注销/改密/全端下线后旧 token 仍有效

**位置**：`src/index.ts:141-145`

`tv`（token_version）与 `sid` 已签进 access token，但 `authenticate` 只做 `jwt.verify`，从不回查 DB。后果：**logout-all、修改密码、账户注销后，旧 access token 在 7 天有效期内照常可用**；`user_sessions` 吊销只影响 refresh 路径。

**修复**（二选一）：
- 认证时回查 `user_sessions.revoked_at` / `users.token_version`（每次请求一次索引查询，可用 2-5s 缓存摊薄，复用 `lib/access.ts` 的缓存模式）；
- 或将 access token TTL 缩短到 15 分钟，依赖 refresh 轮换兜底（改动小，泄露窗口从 7 天缩到 15 分钟）。

### S9：更多公开端点

| 位置 | 问题 |
|------|------|
| `src/routes/metrics.ts:4,19` | `/api/metrics`、`/api/metrics/history` **无认证**，公开暴露内存用量、daemon hostname/版本、业务计数器 |
| `src/routes/agents.ts:10,18` | `GET /internal/agent/`、`/internal/agent/channel/:channelId` **无任何守卫**，公开返回 agent 列表含 user_id |
| `src/routes/channels.ts:279-299` | `GET /api/channels/server` 不校验 server 成员资格，任意 serverId 返回 channels/agents/humans |
| `src/routes/tasks.ts` 全部 5 端点 | 只 `resolveChannel`，**无 `canAccessChannel`**，非成员可操作私有频道任务 |
| `src/routes/messages.ts:242,248,259` | 消息编辑历史、reactions 读写无频道访问校验 |

### S10：鉴权/限流逻辑瑕疵

- **CSRF 豁免判断冗余**（`src/index.ts:157`）：`authHeader.startsWith("sk_machine_")` 永远为 false（实际格式是 `Bearer sk_machine_...`），该豁免无效但巧合下也无害（机器令牌不带 cookie 会话）——应修正为解析 Bearer 后判断。
- **限流 key 含完整 URL**（`src/lib/rate-limit.ts:51`）：`${ip}:${url}` 带 query string，攻击者改 query 参数即可绕过限流桶。应按 `method + 路由 pattern`（或去 query 的 path）做 key。
- **`agents-public.ts:84-135`**：PATCH/DELETE 只校验 org 成员、不校验 agent 归属——同组织成员可改/删他人 agent。注释显示有意为之，但边界建议再确认（至少应限制为 org owner/admin）。

---

## 四、🟡 数据一致性与健壮性

### R1：多步写入无事务

- `channels.ts:215-232` 删除频道 = 6 条串行 DELETE，中途失败留下孤儿数据。
- `messages.ts` 发消息 = 消息 INSERT + 成员 INSERT + 通知 INSERT + 附件 INSERT，无事务边界。
- `channels.ts` 创建频道 = 频道 INSERT + 成员 INSERT。

**修复**：用 `app.pg.transaction()`（postgres.js 的 `sql.begin()`）包裹多步写入。

### R2：登录失败计数 Map 无清理

**位置**：`src/routes/auth.ts:32` — `loginAttempts` 内存 Map 只增不删，长跑后内存膨胀。建议按 `lockedUntil` 过期惰性清理，或复用 Redis 限流后端。

### R3：无界增长的表

`notifications`、`user_sessions`、`metrics_samples`、`message_edits`、`reminder_events` 均无 TTL/归档策略，长期运行后无限膨胀。建议加定期清理任务（如 retention 90 天）。

### R4：WS 消息无大小/频率限制

`ws/handler.ts` 对每条 WS 消息直接 `JSON.parse`，无大小上限、无频率限制，daemon 或浏览器可以大消息/洪水打满 CPU。`earlyBuffer`（握手完成前缓冲）同样无上限。建议加消息大小上限（如 64KB）、缓冲条数上限和每连接频率窗口。

### R5：死路由 / 运行时错误

**位置**：`src/routes/agents.ts:29-41`

`POST /internal/agent/` 的 INSERT 引用 `runtime, model` 两列，但 canonical schema（`000_canonical_schema.sql`）中 agents 表只有 `runtime_profile` 一列——该端点一旦被调用即 SQL 报错。说明 `/internal/agent` 的 POST 路径零测试覆盖。应删除死路由或修正为 `runtime_profile` jsonb。

### R6：迁移执行两次

`runMigrations()` 在 `db/connection.ts` 的 pgPlugin 内和 `index.ts:222` 各跑一次（幂等所以无害，但每次启动白付一轮 IO）。保留一处即可。

### R7：索引与查询方式不匹配

- `resolveChannel`（`lib/channel.ts:35`）`WHERE name = $1` 全局按名查：现有索引建在 `(server_id, lower(name))`，函数索引不匹配纯等值，走全表扫描；且跨 server 同名会命中错误频道（正确性隐患，见 P4）。
- `users.handle = $1`、`agents.name = $1` 同理：索引在 `lower(handle)` 上，等值查询用不上。统一改为 `WHERE lower(handle) = lower($1)` 或补普通列索引。

### R8：响应形状不统一 & 缺响应压缩

- `{ error }` / `{ ok: true }` / `{ state: "sent" }` 混杂；`profile.ts:17` 返回 `{ error: "not found" }` 但状态码 200。
- 未注册 `@fastify/compress`，消息列表等大 payload 无 gzip/br 压缩，白白浪费带宽。

---

## 五、🔵 性能优化

### P1：全文搜索无 GIN 索引

**位置**：`src/routes/messages.ts:206-221`

`to_tsvector('simple', m.content)` 在查询时现算，messages 表增长后搜索退化为全表扫描。建议：

```sql
ALTER TABLE messages ADD COLUMN content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED;
CREATE INDEX idx_messages_tsv ON messages USING GIN (content_tsv);
```

查询改为 `content_tsv @@ plainto_tsquery('simple', $1)`。

### P2：`broadcast()` 每条消息最多 2 次 DB 查询

**位置**：`src/ws/handler.ts:152-179`

私有/DM 频道每次广播都现查「频道类型 + 成员列表」。`lib/access.ts` 已有 2 秒 TTL 缓存（`getChannelType`），但 WS 层没有复用，成员列表也没缓存。建议：频道类型与成员快照走 2-5s TTL 缓存（成员变更时主动失效），高频聊天频道可显著降 DB 压力。

### P3：消息列表的 replyCount 相关子查询

**位置**：`src/routes/messages.ts:32, 194`

每行一个 `(SELECT COUNT(*) FROM messages WHERE thread_id = m.id)`。已有 `idx_messages_thread` 索引撑着，小数据量无感；量级上去后建议改为 `LEFT JOIN ... GROUP BY` 单次聚合。

### P4：channel resolve 未按 server 限定

**位置**：`src/routes/channels.ts:248`

`SELECT * FROM channels WHERE name = $1` 全库按名字查，跨 server 可能命中错误频道。应带上当前默认 serverId。

---

## 六、⚙️ 架构演进方向（中期）

### A1：多实例水平扩展

当前所有关键状态都在进程内存：

| 状态 | 位置 | 多实例影响 |
|------|------|-----------|
| `browserClients` / `daemonClients` | `ws/handler.ts` | 消息只能投递到本进程连接 |
| `loginAttempts` | `auth.ts` | 锁定策略实例间不一致 |
| 限流 MemoryBackend | `rate-limit.ts` | 配额按实例独立计算 |
| metrics 计数器 | `lib/metrics.ts` | 各实例独立计数（已有注释说明） |

路径：WS 投递层引入 **Redis Pub/Sub**（broadcast 先 publish，各实例订阅后投递本地连接）；登录锁定与限流复用已有 Redis 后端（`REDIS_URL` 配置即可，限流已支持，loginAttempts 需改造）。

### A2：drizzle-orm 死依赖清理

`drizzle-orm` 仍在 dependencies，但运行期查询全部走 postgres.js 裸 SQL（`db/schema.ts` 只用其类型声明能力）。要么真正用 drizzle 统一查询层（收益：类型安全 SQL），要么移除（收益：-1 依赖）。当前是最差的中间态。

### A3：`index.ts` 剩余内联路由归位

`/api/health`、`/api/daemon/status`、`/api/users` 仍内联在入口文件（此前从 366 行减到 271 行，可再减到 ~200 行）。

### A4：API 版本化

`src/routes/v1/` 目录已存在雏形但未启用。对外接口稳定前建议完成 `/v1/` 挂载，给后续 breaking change 留路。

### A5：日志脱敏与审计

pino 已就位，但无 body 脱敏配置（`password`、`token` 字段如果进入日志即泄露）。建议配置 `redact: ['req.headers.authorization', 'body.password', 'body.token', 'body.oldPassword', 'body.newPassword']`。管理类操作（删频道、删 Agent、角色变更）建议落审计表。

### A6：输入校验与 API Schema 体系

zod 已从依赖移除但没有替代：所有输入校验靠手写 if 判断，覆盖不全；Fastify 自带的 JSON Schema 校验未使用，导致注册的 Swagger `/docs` 接近空壳。建议：为关键路由（auth、channels、messages、agents）补 JSON Schema（请求校验 + 响应序列化一举两得，fast-json-stringify 还能提速），Swagger 文档随之自动完整。

---

## 七、🧪 测试缺口

现有 12 个测试文件覆盖 auth/channels/messages/dm/tasks/notifications/metrics/ws/agents/lib。建议补：

| 缺口 | 说明 |
|------|------|
| @mention 通知链路 | 能直接挡住 Bug 1 这类回归（`split(/s+/)` 这种错误单测一抓一个准） |
| 附件访问控制 | S1 修复后的鉴权用例 |
| 私有频道 join / tasks / edits / reactions | S2、S9 修复后的权限用例 |
| Reminders owner 校验 | S7 修复后的 IDOR 回归 |
| 机器令牌认证 | 性能改造（sha256 查找）后的正确性回归 |
| agents-dispatch | 经理派发是 7-17 新功能，零覆盖 |
| `/internal/agent` POST | R5 死路由暴露了这条路径零覆盖 |
| 频道删除级联 | 事务化改造后的完整性用例 |

---

## 八、优先级建议

### 立即（今天，低风险高收益）

| # | 事项 | 工作量 |
|---|------|--------|
| 1 | Bug 1：`split(/s+/)` → `split(/\s+/)` | 5 分钟 |
| 2 | S1：附件下载加认证 + 频道成员校验 | 30 分钟 |
| 3 | S2：join 校验频道类型 | 20 分钟 |
| 4 | S3：`/api/users` 加认证 | 1 行 |
| 5 | S7：reminders 五个端点加 owner 过滤 | 30 分钟 |
| 6 | S9：`/api/metrics*`、`/internal/agent/*` 加守卫 | 30 分钟 |

### 本周

| # | 事项 | 工作量 |
|---|------|--------|
| 7 | Bug 2：机器令牌改 sha256 查找（含迁移 + 新旧兼容） | 半天 |
| 8 | S8：JWT tv/sid 回查（或缩短 access TTL 至 15 分钟） | 半天 |
| 9 | S9 剩余：tasks / `/channels/server` / edits / reactions 访问校验 | 半天 |
| 10 | S4：anon WS 不投递消息 | 1 小时 |
| 11 | R1：频道删除/消息发送事务化 | 半天 |
| 12 | R5：删除/修正 `agents.ts` 死路由 | 30 分钟 |
| 13 | P1：tsvector 生成列 + GIN 索引迁移 | 1 小时 |
| 14 | S10：限流 key 去 query、CSRF 豁免修正 | 1 小时 |
| 15 | 补 @mention / 附件 / join / reminders 的回归测试 | 半天 |

### 中期（按需排期）

| # | 事项 |
|---|------|
| 16 | P2：WS 广播路径缓存复用 |
| 17 | R2/R3：loginAttempts 清理 + 表数据 retention 策略 |
| 18 | R4：WS 消息大小/频率限制 |
| 19 | R6：迁移去重；R7：索引与查询对齐（`lower(handle)` 等） |
| 20 | R8：响应形状统一 + `@fastify/compress` |
| 21 | A1：Redis Pub/Sub WS 扇出（多实例） |
| 22 | A2：drizzle 去留决断 |
| 23 | A5：日志脱敏 + 管理操作审计 |
| 24 | A6：关键路由 JSON Schema（校验 + Swagger 补全） |
| 25 | S5/S6：生产环境 Swagger 与配置硬校验（含移除默认密码） |

---

## 九、关联文档

- `docs/2026-07-14/server-review-scorecard.md` — 上一轮换评分（7.50/10，Phase A 已完成项）
- `docs/2026-07-14/server-optimization-roadmap.md` — 此前 Phase A/B/C 路线图
- `docs/2026-07-16/15-remaining-gaps-summary.md` — daemon 侧遗留问题
- `docs/2026-07-17/dispatch-manager-feature-state`（记忆中）— 派发功能现状

---

*本文档基于 `packages/server/src` 当前代码逐文件通读生成，Bug 1、Bug 2、S1-S3 均已对照源码确认。*

---

## 十、修复实施记录（2026-07-17）

### 已完成（「立即」档全部 6 项 + S1 延伸修复）

| # | 修复 | 文件 |
|---|------|------|
| 1 | Bug 1：`split(/s+/)` 修复，两段 @提及解析合并为 `parseMentionHandles()` | `src/routes/messages.ts` |
| 2 | S1：`GET /api/attachments/:id` 加认证 + 上传者/频道成员校验（未挂消息的附件仅上传者可见） | `src/routes/attachments.ts` |
| 2b | S1 延伸：**`/files/` 静态路由同步加守卫**（前端实际经此拉取字节，仅挡未登录；细粒度校验在 /api/attachments/:id） | `src/index.ts` |
| 3 | S2：`POST /channels/:id/join` 仅允许 public 频道自主加入，private/DM 须走 /invite | `src/routes/channels.ts` |
| 4 | S3：`/api/users` 加认证 | `src/index.ts` |
| 5 | S7：reminders 五个 id 端点全部加 `AND owner_id = $userId`（log 端点先验归属再查事件） | `src/routes/reminders.ts` |
| 6 | S9：`/api/metrics`、`/api/metrics/history`、`GET /internal/agent/`、`GET /internal/agent/channel/:channelId` 加认证 | `src/routes/metrics.ts`、`src/routes/agents.ts` |

### 验证

- `pnpm exec tsc --noEmit` ✅ 通过。
- **`pnpm test`：11 个测试文件、102 个用例全部通过**（2026-07-17，针对 `NODE_ENV=test` 模式运行的服务执行）。
- 首次联调发现并修复一个自引入问题：`/files/` 守卫 hook 最初挂在 `authenticate` 装饰器注册之前，`addHook` 拿到 `undefined` 导致启动即崩（`FST_ERR_HOOK_INVALID_HANDLER`）——已把静态文件 scope 移到装饰器注册之后。
- 同步更新 `test/metrics.test.ts`、`test/health.test.ts`：metrics 端点改为带 cookie 调用，并新增「未认证 401」断言。
- 兼容性说明：
  - `/internal/agent/*` 的 daemon 调用均带 sk_agent_ 令牌且 URL 含 `:agentId`，authenticate 的 agent-token 分支按 agentId 索引查找，不受影响。
  - `/files/` 守卫依赖浏览器同源自动带 cookie（`<img>`/`<a>` 均同源）与 daemon 的 sk_* Bearer，正常用户无感知；此前把附件链接贴给未登录用户的场景将收到 401（预期行为）。
- 注意：限流在非 test 模式启用（`rateLimitHook` 对 NODE_ENV=test 豁免），本地手动起 dev 服务跑测试会因注册用户触发 429——测试需针对 `NODE_ENV=test` 的服务执行。

### 下一步（「本周」档，未开始）

机器令牌 sha256 查找、JWT tv/sid 回查、tasks/`channels/server`/edits/reactions 访问校验、anon WS 不投递、事务化、死路由、GIN 索引、限流 key 修正、回归测试。

---

## 十一、「本周」档实施记录（2026-07-17）

### 已完成（9 项全部 + 配套回归测试）

| # | 修复 | 文件 |
|---|------|------|
| R5 | `POST /internal/agent/` 死路由改用 `runtime_profile` jsonb（原引用不存在的 runtime/model 列） | `src/routes/agents.ts` |
| S4 | 浏览器 WS token 无效时直接 4001 关闭，不再降级为可收公开频道消息的 anon | `src/ws/handler.ts` |
| S9 | tasks 全部 5 端点加 `canAccessChannel`；`GET /channels/server` 校验 server 成员；消息 edits/reactions 三个端点加频道访问校验 | `src/routes/tasks.ts`、`channels.ts`、`messages.ts` |
| R1 | `pg.transaction()` 基建（postgres.js `sql.begin`）；频道创建/删除级联、消息发送（本体+提及+附件）事务化，通知留事务外 | `src/db/connection.ts`、`channels.ts`、`messages.ts` |
| S10 | 限流 key 改为 `ip:method:pathname`（去 query，防绕过）；CSRF 豁免改判 Bearer 头整体 | `src/lib/rate-limit.ts`、`src/index.ts` |
| P1 | migration 008：`content_tsv` stored 生成列 + GIN 索引；search 查询改用生成列 | `src/db/migrations/008_messages_tsv.sql`、`messages.ts` |
| Bug 2 | **机器/Agent 令牌改 sha256 落库**：新增 `lib/token-hash.ts`（sha256 + bcrypt 前缀分流）；签发（profile machine-token、agents-credentials mint）写 sha256；认证（index.ts authenticate、ws/handler resolveUserId）先 sha256 索引命中，未命中再回退历史 bcrypt 逐行比对（轮换后可删） | `lib/token-hash.ts`、`index.ts`、`ws/handler.ts`、`profile.ts`、`agents-credentials.ts` |
| S8 | **JWT 会话状态回查**：新增 `lib/session-check.ts`（sid 未吊销 + token_version 匹配，5s TTL 缓存）；authenticate cookie 分支接入；logout/logout-all/吊销会话/改密/注销后 `clearSessionCache()` 立即失效 | `lib/session-check.ts`、`index.ts`、`auth.ts`、`profile.ts` |
| 测试 | 新增 `test/security-fixes.test.ts`（@mention 通知、附件访问控制、私有频道 join、reminders IDOR、sha256 令牌认证+吊销、会话吊销即时失效）；更新 ws.test.ts 三处 anon 断言为期望 4001；更新 metrics/health 测试带 cookie | `test/security-fixes.test.ts`、`ws.test.ts` |

### 验证

- `pnpm exec tsc --noEmit` ✅ 通过
- **`pnpm test`：12 个测试文件、108 个用例全部通过**（2026-07-17，NODE_ENV=test 服务）

### 实施中发现并顺带修复的问题

1. **tsx watch 热重载顺序**：首轮 `/files/` 守卫挂在 authenticate 注册前导致 `FST_ERR_HOOK_INVALID_HANDLER`，已调整注册顺序（见第十节）。
2. **会话缓存击穿**：logout-all 后 5s TTL 内旧 token 仍可用——为吊销类操作补 `clearSessionCache()` 主动失效。
3. **ws 测试断言旧行为**：anon/invalid-JWT 三个用例原本断言「降级 anon 连接成功」，与 S4 修复目标直接冲突，已改为断言 4001 拒绝。

### 剩余「中期」项（未开始）

P2（WS 广播缓存复用）、R2/R3（loginAttempts 清理、表 retention）、R4（WS 消息大小/频率限制）、R6（迁移去重）、R7（索引与查询对齐）、R8（响应压缩）、A1（Redis Pub/Sub）、A2（drizzle 去留）、A5（日志脱敏/审计）、A6（JSON Schema）、S5/S6（Swagger 与配置硬校验）。

---

## 十二、@提及唤醒拦截与 daemon 联动修复（2026-07-17）

> 起因：私有频道 @ 一个非成员 agent 时，daemon 仍会 spawn PTY 让 agent 完整思考一轮，回复时才被 server 403 —— 资源空转。结论：在**投递前**拦截，无权回应的 agent 根本不唤醒。

### 已完成

| # | 修复 | 文件 |
|---|------|------|
| 1 | **server 投递前过滤**：`/send` 广播载荷新增 `mentionAgents`（有权回应的 agent handle 列表）。公开频道：自动入圈后全量可投递（入圈范围 = 频道 server 内 + 发送者名下，与 /invite 跨 server 回退一致）；私有频道：不自动入圈，仅已是成员的 agent 入列 | `server/src/routes/messages.ts` |
| 2 | **daemon 按列表路由**：`agent:deliver` 有 `mentionAgents` 字段（含空数组）时只 spawn 列表内 agent，空列表 = 有人被 @ 但无人有权回应 → 不起 PTY；无字段（旧 server）退回本地文本解析，向后兼容 | `daemon/src/daemon-core.ts` |
| 3 | **agent join/leave 路由补齐**：daemon CLI `slock join/leave` 调的 `POST /internal/agent/:agentId/channels/:name/join|leave` 此前不存在（404），已补上；join 仅限公开频道，私有频道须管理员 invite | `server/src/routes/agents.ts` |
| 4 | **STUCK 看门狗阈值放宽**：硬编码 30s 刷误报（正常大任务单回合 1-2 分钟），改为 `SLOCK_STUCK_WARN_MS` 环境变量可调，默认 90s | `daemon/src/agent-runtime.ts` |
| 5 | 回归测试 ×2：私有频道 @非成员 agent（不入圈 + `mentionAgents: []`）、公开频道 @发送者名下 agent（自动入圈 + 列表包含） | `server/test/security-fixes.test.ts` |

### 行为变化说明

- **公开频道**：@任何 agent（频道 server 内或自己名下）→ 自动入圈 → 正常唤醒回复（与之前一致，且跨 server 回退与 /invite 对齐，修复了跨 server 不生效的问题）。
- **私有频道**：@非成员 agent → **不再自动入圈、不再唤醒**（daemon 不 spawn，零 token 消耗）；@已是成员的 agent → 正常唤醒。要拉 agent 进私有频道，频道管理员在成员面板 invite。
- 旧版本 daemon 连新 server：识别 `mentionAgents` 正常工作；旧 server 连新 daemon：无该字段，daemon 退回原文本解析，行为与之前一致。

### 验证

- `pnpm exec tsc --noEmit`（server + daemon）✅ 通过
- **`pnpm test`：12 个测试文件、110 个用例全部通过**（2026-07-17，NODE_ENV=test 服务）

---

## 十三、中文 agent 名 mention 解析修复 + daemon 状态机修复（2026-07-17 第二轮）

> 起因：第一节的 `mentionAgents` 拦截上线后，@中文名 agent 完全无反应。根因是 server 端
> 解析 @提及的正则 `replace(/[^a-zA-Z0-9_]/g, "")` 会剥掉中文字符——`@716测试机` 被解析成
> `716`（查无此 agent → mentionAgents 空数组 → daemon 按新逻辑正确地不 spawn，但用户预期
> 它能响应）；`@悬疑小说家` 被剥成空串（mentionAgents 字段缺失 → daemon 退回文本解析，
> 反而能工作）。两种中文名行为不一致。

### 已完成

| # | 修复 | 文件 |
|---|------|------|
| 1 | agent 提及检测改为**候选集子串匹配**：公开频道候选 = 频道 server + 发送者名下 agent；私有频道候选 = 频道成员 agent。`contentMentions()` 带边界判断（名字后紧跟字母/数字/中文不算提及，防 "test" 误中 "@tester"）。中文名（含数字+中文混合）全部正常工作 | `server/src/routes/messages.ts` |
| 2 | 人类用户提及保持 `parseMentionHandles`（注册时 handle 限死 `^[a-zA-Z0-9_]{2,20}$`，ASCII 解析够用） | 同上 |
| 3 | **daemon 状态机补 idle→working 合法迁移**：PTY 复用分支（agent 空闲但进程活着）收到新消息直接 idle→working，此前被状态机拒绝（日志 `Invalid state transition: idle → working (ignored)`），导致状态与实际脱节、round-end 检测失效 | `daemon/src/agent-runtime-state.ts` |
| 4 | 回归测试：公开频道 @`716测试机`（数字+中文名）mentionAgents 正确包含 | `server/test/security-fixes.test.ts` |

### 验证

- `pnpm exec tsc --noEmit`（server + daemon）✅ 通过
- **`pnpm test`：12 个测试文件、111 个用例全部通过**（2026-07-17，NODE_ENV=test 服务）
