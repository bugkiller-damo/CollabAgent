# 计划：Phase 1 近期优化实现

**复杂度**: Large（4 个子项目）
**预计时间**: 5-8 天

## 概述

基于 `docs/2026-07-14/项目完成情况报告.md` 第六章路线图，实现 Phase 1 四项近期优化：

1. **通知中心** — 多用户协作基础功能缺口
2. **中文搜索分词** — 中文团队日常搜索体验
3. **纯 httpOnly Cookie 硬化** — 安全加固
4. **Daemon 健壮性收尾** — 运行稳定性

---

## 模式参考

| 类别 | 来源 | 模式 |
|---|---|---|
| 路由注册 | `server/src/routes/*.ts` | 每个模块独立文件，`export async function xxRoutes(app)`，在 index.ts 中注册 |
| 数据库操作 | `server/src/routes/messages.ts` | 原始 SQL（`app.pg.query`）+ Drizzle ORM 混合 |
| WS 消息推送 | `server/src/ws/handler.ts` | `broadcast(channelId, message)` / `broadcastToDaemons(message)` |
| 后台轮询 | `server/src/lib/reminder-scheduler.ts` | `setInterval` + 原子 SQL 认领 (`FOR UPDATE SKIP LOCKED`) |
| 认证装饰器 | `server/src/index.ts` | `server.decorate("authenticate", async ...)` 支持 Bearer + Cookie + 机器令牌 |
| 前端 Store | `web/src/stores/*.ts` | Zustand `create<>` 模式，通过 apiClient 调用后端 |
| 前端 API 调用 | `web/src/api/client.ts` | `apiGet<T>()` / `apiPost()` / `apiPatch()` 统一封装，自动携带 CSRF + Bearer |
| 前端组件树 | `web/src/components/**` | 按功能目录组织 (chat/ channel/ layout/ auth/ admin/ message/) |

---

## 子项目 1：通知中心（建议优先级：🥇 最高）

### 问题
当前仅有频道级别未读数，缺少 @我、被指派任务、DM 消息的聚合通知与红点提示。这是所有协作平台的标配功能。

### 方案

**后端（server）：**
1. 新建 `routes/notifications.ts` — 通知 CRUD 路由
   - `GET /api/notifications` — 拉取未读通知列表（分页）
   - `PATCH /api/notifications/read` — 批量标记已读
   - `PATCH /api/notifications/:id/read` — 单条标记已读
2. 新建 `lib/notifications.ts` — 通知写入工具函数
   - `createNotification(type, actorId, targetId, metadata)` — 插入通知并 WS 广播
3. 通知类型覆盖：
   - `@mention` — 消息发送时检测 @提及 → 通知被提及人
   - `task_assigned` — 任务被指派时 → 通知被指派人
   - `dm` — DM 消息 → 通知收件人
   - `reminder` — 提醒触发时同步生成通知
4. WS 通知推送：复用 `ws/handler.ts` 的 `broadcast` 机制，按 userId 定向推送

**前端（web）：**
1. 新建 `components/notifications/NotificationBell.tsx` — 顶部铃铛图标 + 未读红点
2. 新建 `components/notifications/NotificationPanel.tsx` — 下拉通知列表面板
3. 新建 `stores/notificationStore.ts` — 通知状态管理（未读计数、列表、WS 事件订阅）

### 工作量
| 层 | 文件 | 预计行数 |
|---|---|---|
| 后端工具函数 | `server/src/lib/notifications.ts` | ~80 |
| 后端路由 | `server/src/routes/notifications.ts` | ~120 |
| 后端 index.ts 注册 | `server/src/index.ts` | +2 行 |
| 前端 Store | `web/src/stores/notificationStore.ts` | ~80 |
| 前端组件 | `web/src/components/notifications/NotificationBell.tsx` | ~60 |
| 前端组件 | `web/src/components/notifications/NotificationPanel.tsx` | ~100 |
| 前端集成 | `web/src/components/layout/AppLayout.tsx` | +5 行 |
| **总计** | | **~450 行** |

### 风险
- WS 按 userId 广播已有基础设施（`browserClients Map<userId, Set<WebSocket>>`），无需额外建设

---

## 子项目 2：中文搜索分词（建议优先级：🥇 最高）

### 问题
当前消息搜索使用 `to_tsvector('simple', m.content)`，只做英文分词（按空格/标点切词）。中文连续文本不分词、命中率为 0。

### 方案

最简单路径：用 PostgreSQL 扩展实现中文分词。

**选项 A：`pg_jieba`**（推荐，轻量无编译）
- PostgreSQL 扩展，基于 jieba 分词算法
- 安装：`CREATE EXTENSION pg_jieba;`
- 使用：`to_tsvector('jiebacfg', content)` 替代 `to_tsvector('simple', content)`

**选项 B：`zhparser`**（功能更强，但需编译）
- SCWS 分词 + PostgreSQL 扩展
- 更适合"搜索精确度要求高"的场景

**改动文件：**

1. 新建 `server/src/db/migrations/003_chinese_search.sql`
   - `CREATE EXTENSION IF NOT EXISTS pg_jieba;`
   - 添加 GIN 索引：`CREATE INDEX IF NOT EXISTS idx_messages_content_cn ON messages USING gin (to_tsvector('jiebacfg', content));`
2. 修改 `server/src/routes/messages.ts` 第 180 行
   - `to_tsvector('simple', m.content)` → `to_tsvector('jiebacfg', m.content)`
   - `plainto_tsquery('simple', $1)` → `plainto_tsquery('jiebacfg', $1)`
3. 文档更新：`docs/ENV.md` 注明需启用 pg_jieba 扩展

### 工作量
| 文件 | 操作 | 工作量 |
|---|---|---|
| `server/src/db/migrations/003_chinese_search.sql` | 新建 | 极小（~10 行） |
| `server/src/routes/messages.ts:180` | 修改 2 个参数 | 极小 |
| **总计** | | **~0.5 天** |

### 风险
- **依赖 PostgreSQL 服务器端扩展**：部分托管 PostgreSQL（如 RDS）可能不支持 `pg_jieba`。需确认数据库环境
- 如果无法安装扩展，后备方案：用 Elasticsearch / Meilisearch 作为专用搜索后端（但工程量大，不是 Phase 1 范围）

---

## 子项目 3：纯 httpOnly Cookie 硬化（建议优先级：🥇 最高）

### 问题
前端同时在 localStorage 存 JWT 作 Bearer header、同时也有 httpOnly Cookie。localStorage 中的 token 可被 XSS 窃取。需去掉 Bearer 过渡方案，全走 httpOnly Cookie。

### 方案

**后端（server）：**
1. 登录/刷新路由 `auth.ts` 已签发 httpOnly cookie（`setAuthCookies`），保留现状
2. index.ts 中的 `authenticate` 装饰器修改：优先从 Cookie 取 token，去掉 Bearer 回退
   - 当前逻辑：先读 `Authorization` header → 失败后退到 cookie
   - 改为：**只**从 cookie 读 `access_token`，不再读 Bearer header

**前端（web）：**
1. `authStore.ts`：
   - 登录后不再 `localStorage.setItem("auth_token", ...)`
   - 取消 `savedToken` 从 localStorage 初始化
   - `loginWithToken()` 简化——不再写 localStorage
2. `api/client.ts`：
   - `apiClient()` 不再读取 `useAuthStore.getState().token` 并添加 Bearer header
   - 请求天然带 cookie（已有 `credentials: "include"`）
3. `LoginPage.tsx` / `RegisterPage.tsx`：检查是否有渲染依赖 token 的逻辑需要调整
4. **强制重登**：已有 token 的用户需要重新登录一次（因为后端不再接受 Bearer 旧 token 的无 cookie 请求）

### 工作量
| 文件 | 操作 | 修改行数 |
|---|---|---|
| `server/src/index.ts` | authenticate 装饰器去掉 Bearer fallback | ~10 行 |
| `web/src/stores/authStore.ts` | 去掉 localStorage 读写 | ~15 行 |
| `web/src/api/client.ts` | 去掉 Bearer header 写入 | ~5 行 |
| **总计** | | **~30 行** |

### 风险
- **兼容性**：所有用户（包括 daemon 的机器令牌用户）需要重新登录一次。daemon 侧的机器令牌（`sk_machine_*`）不使用 Bearer，走独立认证路径，不受影响
- **daemon 认证**：WS 的 `ws/handler.ts` 也支持从 cookie 读 token（见 `parseAuthToken`），daemon 用机器令牌独立认证，不受影响

---

## 子项目 4：Daemon 健壮性（建议优先级：🥈 中）

### 4a：卡死回合应 kill 进程

**现状**：`PersistentClaude.turnTimer` 超时只 `busy=false` 继续下一回合，不 kill 卡死的 Claude 进程。其迟到 result 会与后续回合错配导致混乱。

**改动**：`packages/daemon/src/drivers/persistent-claude.ts`
```typescript
// 超时回调（第 101-105 行）改为：
this.turnTimer = setTimeout(() => {
  console.warn(`[Persistent${this.opts.label ? " " + this.opts.label : ""}] turn timeout, killing process`);
  try { this.proc?.kill(); } catch { /* ignore */ }
  this.cleanup();
  this.pump(); // pump 会检测到 proc 已死并重新 spawn
}, timeout);
```

### 4b：stdout 缓冲上限保护

**现状**：`PersistentClaude.buf` 无换行时无限增长，可能耗尽内存。

**改动**：`persistent-claude.ts` 在 `onStdout` 方法开始时加入：
```typescript
private onStdout(chunk: string): void {
  this.buf += chunk;
  if (this.buf.length > 1024 * 1024) { // 1MB 上限
    console.warn(`[Persistent${this.opts.label ? " " + this.opts.label : ""}] stdout buffer >1MB, truncating`);
    this.buf = this.buf.slice(-1024 * 1024); // 保留尾部 1MB
  }
  // ... 后续原逻辑
```

### 4c：Runtime 死选项清理

**现状**：Agent 创建页面下拉可选 `codex` / `deepseek`，但运行时只实现了 `claude`，产生误导。

**改动**：`packages/web/src/pages/admin/AgentManagement.tsx` 移除 `codex` 和 `deepseek` 选项：

```diff
- <option value="claude">Claude</option>
- <option value="codex">Codex</option>
- <option value="deepseek">DeepSeek</option>
+ <option value="claude">Claude</option>
```

同时 model 下拉保留 `sonnet` / `opus` / `haiku`（均为有效 Claude 模型）。

### 工作量
| 文件 | 操作 | 修改行数 |
|---|---|---|
| `daemon/src/drivers/persistent-claude.ts` | kill 超时进程 + stdout 缓冲上限 | ~10 行 |
| `web/src/pages/admin/AgentManagement.tsx` | 移除死选项 | ~2 行 |
| **总计** | | **~12 行** |

### 风险
- kill 进程后 `pump()` 会自动重新 spawn，序列正确

---

## 优先级建议

| 排序 | 子项目 | 原因 |
|---|---|---|
| 🥇 1 | **通知中心** | 多用户刚需缺口，影响日常协作体验 |
| 🥇 2 | **中文搜索分词** | 中文团队搜索体验硬伤，改动极小 |
| 🥇 3 | **httpOnly 硬化** | 安全收益高，改动集中 |
| 🥈 4 | **Daemon 健壮性** | 小改进，消除潜在错配与误导 |

### 建议执行顺序

```
通知中心 ─→ 中文搜索 ─→ httpOnly 硬化 ─→ Daemon 健壮性
  (3-4天)    (0.5天)      (0.5天)          (0.5天)
```

前三项互不依赖，可并行推进。建议按上述顺序串行，确保每项完成后 typecheck + 测试通过再进入下一项。

---

## 验证清单

- [ ] `pnpm -r typecheck` 全部通过
- [ ] `pnpm --filter @collabagent/server test` 全部通过（13/13）
- [ ] `pnpm --filter @collabagent/web build` 通过
- [ ] 通知中心：创建消息含 @提及 → 被提及人收到通知
- [ ] 中文搜索：含中文关键词的消息可被搜索到
- [ ] httpOnly：移除 localStorage token 后登录/API 调用正常
- [ ] Daemon：超时卡死的 PersistentClaude 进程被 kill + 重新 spawn
- [ ] 更新 `docs/2026-07-14/项目完成情况报告.md` 中对应章节
