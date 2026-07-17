# Server 端 Agent 对接对比分析：Hive vs Slock

**日期**: 2026-07-16
**范围**: `D:\code\hive-main\src\server\`（agent↔server 认证/调用链）对照 `D:\code\slock\packages\server\src\`
**触发背景**: 当天早些时候的实机联调（见 `08-hive-alignment-gap-analysis.md` 第 7 项 bug）发现 slock daemon 注入的 `SLOCK_AGENT_TOKEN`（`tokenRegistry.issue()` 生成的本地 UUID）服务端完全不认识，被迫先用真实 apiKey 顶上。本次分析回答一个问题：如果之后要把这个"临时顶替"换成 Hive 那样真正的 per-agent-run scoped token，服务端需要补哪些东西。

---

## 0. 结论先行

**Hive 的服务端有一套真实、在请求路径上生效的 per-agent-run token 校验机制；slock 的服务端完全没有——不仅没有 scoped token，连"这个请求是不是这个 agent 本人发的"这个最基本的检查都没有。** 任何一个有效的 `sk_machine_...` machine token，理论上可以冒充服务器上**任意用户的任意 agent**去发消息、认领任务、设提醒。这比"没有 scoped token"更严重，属于当前就存在的越权漏洞，不是"补齐 Phase 2 设计"级别的待办。

同时发现一个巧合：slock 的数据库 schema 里已经有一张 `agent_credentials` 表（`agent_id` 唯一外键 + `token_hash` + `expires_at`/`revoked_at`），结构跟"per-agent 运行时 token"要求的字段几乎一模一样——但整个代码库里**只有 schema 定义引用它，没有任何路由/中间件/业务逻辑读写过这张表**。这看起来是之前就规划好了这个功能、数据库迁移也做了，但服务端代码从没接上。

---

## 1. Hive 的 agent↔server 认证架构（完整链路）

```
1. 启动时（agent-run-starter.ts:60）
   tokenRegistry.issue(agentId) → 生成 randomUUID，覆盖该 agentId 之前的 token
   注入子进程 env：HIVE_AGENT_ID / HIVE_AGENT_TOKEN / HIVE_PORT

2. Agent 子进程调用（src/cli/team.ts）
   team send/report/status/cancel → POST http://127.0.0.1:${HIVE_PORT}/api/team/...
   body 带 from_agent_id + token + project_id
   （team list 走 header：x-hive-agent-id / x-hive-agent-token）

3. 全局网络层门禁（local-request-guard.ts，对所有请求生效）
   assertLocalRequest：socket 地址/Host/Origin 必须是 loopback，否则直接拒绝

4. 路由级认证（team-authz.ts::authenticateCliAgent）
   ├─ validateToken(fromAgentId, token) → tokenRegistry.validate()（真实生效，非死代码）
   ├─ getAgent(workspaceId, fromAgentId) → 在"这个 workspace 的 agent 列表"里找，
   │    找不到直接 401（"Agent not found in workspace"）——这一步就是 workspace 级隔离
   └─ requireCommandForRole(agent, command) → orchestrator/worker 角色 ACL，403

5. 业务逻辑（team-operations.ts）
   dispatchTask / reportTask / statusTask / cancelTask
   → 写消息日志 + dispatch ledger → agentRuntime.write*Prompt 写回目标 agent 的 PTY

6. 退出/失败时撤销（agent-run-exit-handler.ts / agent-run-starter.ts）
   tokenRegistry.revokeIfMatches(agentId, token) —— 仅在 token 仍匹配时撤销，
   防止旧 run 的延迟退出回调误删新 run 的 token
```

**关键点**：token 校验（`validate`）+ workspace 归属校验（`getAgent(workspaceId, agentId)`）是**两道独立的门**，前者证明"这个 token 确实是这个 agentId 当前持有的"，后者证明"这个 agentId 确实属于调用方声称的这个 workspace"。两道都过了才放行。UI 侧（浏览器人类用户）走的是完全独立的 `ui-auth.ts` cookie 机制，跟这套 agent token 系统没有任何交叉。

---

## 2. Slock 的 agent↔server 认证架构（现状）

```
1. 启动/dispatch 时（daemon: agent-runtime.ts，今天已改）
   SLOCK_AGENT_TOKEN = options.apiKey（daemon 的机器级 apiKey，所有 agent 共用同一个值）

2. Agent 子进程调用（daemon: slock CLI, auth.ts legacy-machine 模式）
   Authorization: Bearer <apiKey> → 直接发到 /internal/agent/:agentId/send 等端点

3. 服务端认证（index.ts:85-124，三选一）
   ├─ Bearer dev-token（非 prod）→ request.user = {sub:"dev-user", ...} 固定身份
   ├─ sk_machine_... → 全表扫描 machine_tokens，bcrypt 逐行比对，命中则
   │    request.user = {sub: user.id, handle, scope}（scope 恒为 {send,read,tasks}，
   │    从来没有任何地方读取/校验这个 scope 字段）
   └─ Cookie JWT（浏览器会话，agent CLI 不会用）

4. 路由层（agents.ts / agents-messages.ts / agents-tasks.ts / agents-reminders.ts）
   直接从 URL path 取 :agentId，从不检查 request.user.sub 是否等于这个
   agent 记录的 owner（agents.user_id）—— getAgent() 只是裸的
   `SELECT ... WHERE id = $1`，没有任何归属谓词。

   唯一存在的访问检查是 agentCanAccessChannel（channel 成员校验），
   但这只防"合法冒充后还想跨频道偷看"，防不了冒充本身。
```

**问题**：第 3 步验证的是"这个 token 属于哪个人类用户"，第 4 步却直接信任 URL 里的 `agentId`，中间完全没有"这个用户名下确实有这个 agent"的校验。只要拿到任意一个有效的 `sk_machine_...` token（哪怕是别的用户的），就能对**服务器上任意 agentId**发消息、建任务、设提醒、改 profile、甚至 `PATCH`/`DELETE` 掉别人的 agent 记录（`agents-public.ts` 的这两个端点也没做 org 校验）。

---

## 3. 数据库里已经有、但完全没接上的东西

`db/schema.ts` 里有两张寂静无声的表（迁移文件 `000_canonical_schema.sql:231-249` 也有对应 DDL）：

```sql
agent_credentials: id, agent_id (UNIQUE FK→agents), token_hash, token_prefix,
                    expires_at, revoked_at, created_at
agent_logins:       id, agent_id (FK→agents), integration_id, access_token,
                    refresh_token, expires_at, status
```

`agent_credentials` 的结构（`agent_id` 唯一约束 + hash 存储 + 过期/撤销时间戳）**正是** per-agent 运行时 token 需要的形状——甚至比 Hive 纯内存版的 `agent-tokens.ts` 更进一步（Hive 的是进程重启就丢；slock 这张表如果接上，daemon 重启后理论上还能恢复）。但除了 schema 定义和迁移 SQL 之外，全代码库 grep 不到任何路由/lib/中间件引用过 `agent_credentials`/`agentCredentials`。这看起来是数据库设计阶段就规划好了这个功能，服务端 API 代码却从没跟上。

---

## 4. 调整建议（按优先级）

### P0 —— 立刻能修、修复的是当前就存在的越权漏洞（不是"补齐设计"）

1. **给 `/internal/agent/*` 路由加 agent-归属校验**：在 `agents.ts`/`agents-messages.ts`/`agents-tasks.ts`/`agents-reminders.ts` 里，取到 agent 记录后加一行 `if (agent.userId !== request.user.sub) return reply.status(403).send(...)`。这是最小改动、不需要新 token 基建，立刻关闭"任意 machine token 冒充任意 agent"这个洞。等价于把 Hive `team-authz.ts` 里 `getAgent(workspaceId, agentId)` 起到的"归属校验"作用，用 slock 已有的 `agents.user_id` 字段实现一个简化版（slock 目前是"user 拥有多个 agent"扁平模型，没有 Hive 的 workspace 概念，所以校验维度是 user 而不是 workspace）。
2. **`agents-public.ts` 的 `PATCH /api/agents/:id`、`DELETE /api/agents/:id` 补 org 归属校验**——create 端点已经检查了 `getUserOrgIds`，这两个操作型端点却没有，同一类缺口，修法一致。

### P1 —— 对齐 Hive 的 scoped runtime token（真正解决今天临时顶替 apiKey 的问题，工作量较大）

3. **把 `agent_credentials` 表接上**：新增一个内部端点（例如 `POST /internal/agent/:agentId/credentials`，仅限该 agent 的 owner 或 daemon 自身的 machine token 调用）供 daemon 在 spawn 时注册一个新签发的 per-run token（hash 存表，daemon 侧只留明文）。
4. **认证装饰器加第 4 种模式**：`token_prefix` 快速定位 + `token_hash` 校验通过 `agent_credentials`，命中后 `request.user = {sub: agent.userId, agentId: agent.id, scope: "agent-run"}`，天然带上 agent 级别的身份（不需要再额外查 `agents.user_id` 比对，因为 token 本身就是 1:1 绑定这个 agentId 的）。
5. **daemon 侧配合改动**（这次不在本文档范围，但要预告）：`daemon-core.ts`/`agent-runtime.ts` 需要在 spawn 时调用新端点换取 token，再把这个换来的 token（而不是今天临时用的 apiKey）注入 `SLOCK_AGENT_TOKEN`；退出时调用撤销端点或让 `expires_at` 自然过期。这样才能真正做到"每个 agent 子进程只能操作自己"，而不是共享一个全权限的机器 token。

### P2 —— 次要，跟安全无直接关系但顺手可以做

6. `machine_tokens.scope` 字段目前恒为 `{send,read,tasks}` 且从未被任何路由读取——要么开始在路由里强制检查，要么干脆去掉这个字段造成的"看起来有权限细分、实际没有"的误导。
7. 服务端整体没有 `zod`（或任何 schema 校验库），所有校验都是手写的 `if (!field) return 400`——跟 daemon 侧 WS 消息缺 zod 校验是同一类欠账（`05-security-model.md §8` 已经记过 daemon 那一半，这里补上 server 那一半）。

---

## 4.1 P0 执行记录（2026-07-16 当天完成）

- `lib/agent-helpers.ts`：`getAgent()` 的 SELECT 补了 `user_id` 字段；新增 `requireOwnAgent` preHandler（读 `request.server`，不需要额外传 `app`，可以直接作为 bare 函数引用接在 `app.authenticate` 后面）。
- `routes/agents.ts`：`GET/POST /:agentId/profile`、`PATCH /:agentId` 三个路由加了 `requireOwnAgent`（`POST /` 创建端点没有 `:agentId`，不需要加，原样不动）。
- `routes/agents-messages.ts`：全部 9 个路由（send/receive/history/server/channel-members/upload/reactions×2/search）加了 `requireOwnAgent`。
- `routes/agents-tasks.ts`：全部 5 个路由加了 `requireOwnAgent`。
- `routes/agents-reminders.ts`：全部 6 个路由加了 `requireOwnAgent`。
- `routes/agents-public.ts`：`PATCH /agents/:agentId`、`DELETE /agents/:agentId` 补了跟 `POST /agents`（创建端点）一致的 org 归属校验（`getUserOrgIds` + 目标 agent 的 `server_id` 比对）。

**验证**：`tsc --noEmit` 干净。`test/agents.test.ts` 等集成测试需要一个以 `NODE_ENV=test` 启动的服务器实例（该模式下限流中间件会跳过），但本机当前跑着的是开发模式的服务器进程（同一个 daemon 联调一直在用的那个，端口 3001），不在测试模式下，反复跑测试会撞到限流（`请求过于频繁`）——这是环境问题，不是本次改动引入的回归；grep 确认 `test/agents.test.ts`/`tasks.test.ts`/`messages.test.ts` 都不覆盖被改动的这些 `:agentId` 路由（它们测的是 cookie 认证的人类侧路由），所以现有测试集本来就没有针对这批改动的覆盖。改动本身是纯新增的 preHandler 检查，逻辑经过手工核对。

## 5. 与 daemon 侧待办的关系

`08-hive-alignment-gap-analysis.md` 第 7 项 bug 记录的"服务端不认 scoped runtime token，daemon 先注入真实 apiKey 顶上"这个决定，现在有了明确的后续路径：完成本文档 P1 的服务端改动后，daemon 侧要把 `agent-runtime.ts` 里两处 `SLOCK_AGENT_TOKEN: options.apiKey` 换回真正的 per-run token（从新端点换取），`tokenRegistry.issue()`/`revokeIfMatches` 的调用也要重新接回去（目前因为没有真实凭证可撤销，`revokeIfMatches` 是个永久空操作）。在那之前，P0 的两处归属校验修复是可以独立于这个大工程、立刻上线的安全加固。

---

## 4.2 P1 执行记录（2026-07-16 当天完成）

真正接上了 `agent_credentials` 这张之前只有 schema 没有代码的表：

**服务端**：
- 新文件 `routes/agents-credentials.ts`：`POST /internal/agent/:agentId/credentials`（签发/刷新，upsert 到 `agent_credentials`，覆盖同一 agent 之前的凭证——`agent_id`/`token_hash` 都是 UNIQUE，upsert 天然实现"重新签发即撤销旧的"）、`DELETE /internal/agent/:agentId/credentials`（撤销，`revoked_at = now()`，找不到可撤销的也返回 `ok:true`，不当错误）。两个端点都要求 `requireOwnAgent`，并且新增了 `requireMachineAuth` 二次校验——不允许一个已经签发出去的 `sk_agent_...` token 自己给自己续期/撤销，必须用账号级 `sk_machine_...` token 才能管理凭证（否则万一 token 泄露，攻击者可以无限自我续期，TTL 这道防线就形同虚设）。
- Token 格式沿用 `sk_machine_` 的生成方式（32 位随机小写字母数字），改前缀为 `sk_agent_`；TTL 定为 24 小时（覆盖单次长会话足够，daemon 重启后下次 dispatch 会自然重新签发，不需要更长）。
- `index.ts` 的 `authenticate` 装饰器新增第 4 种模式（排在 `sk_machine_` 前面判断）：`sk_agent_...` 走 `agent_credentials` 单条按 `agent_id` 索引查找（比 `sk_machine_` 现有的"全表扫描+逐行 bcrypt"更高效，因为 URL 里的 `:agentId` 在 preHandler 阶段已经可用），校验通过后 `request.user = {sub: agent.userId, handle: agent.name, scope: "agent-run", agentId}`——跟 machine-token 认证设置的字段形状一致，所以已经接在这批路由后面的 `requireOwnAgent` 会自然通过，不需要额外改。

**daemon 侧**：
- `agent-runtime.ts` 新增 `mintAgentCredential(agentId)`/`revokeAgentCredential(agentId)`（沿用 `loadExistingAgents()` 已有的裸 `fetch` + `Authorization: Bearer <apiKey>` 约定，因为换 token 本身必须用账号级 apiKey 认证，这时候还没有 scoped token）。
- PTY 分支：`env` 的构造从"每次 dispatch 都建一次"改成只在**真正 spawn 新 PTY 时**才建（换 token 只需要在 spawn 时做一次，写入已运行 PTY 的消息不需要新 env）——`SLOCK_AGENT_TOKEN` 现在是 `await mintAgentCredential(agentId)` 换来的 `sk_agent_...`，不再是 `options.apiKey`。换取失败会直接让本次启动失败（走已有的 catch 块，转 idle + 打日志），不会静默退回共享 apiKey——如果连服务端都换不到 token，agent 起来了也没法调 `slock message send`，不如现在就失败得明确。
- 兜底路径（PersistentClaude/claudePrint，非默认路径）同样换成 `mintAgentCredential`，每次 dispatch 都重新换一个（这条路径用得少，简单起见没有像 PTY 分支那样做"只在真正 spawn 时才换"的优化）。
- PTY 退出清理链（`exitCoordinator` 回调）里加了 `void revokeAgentCredential(ctx.agentId)`——best-effort，失败只打警告不影响其余清理步骤（反正 24h TTL 兜底）。
- `agent-tokens.ts`/`tokenRegistry` 保持不动：它现在纯粹是本地记账（`runContext.token` 存的是真实 `sk_agent_` token，`revokeIfMatches` 会尝试匹配 tokenRegistry 内部 Map，但因为从 P0 那轮起就没有任何地方调用过 `.issue()`，这个 Map 永远是空的，所以 `revokeIfMatches` 永远是无害的空操作）——没有削掉它，因为它不影响正确性，专门为这个模块做清理不是这次的目标。

**验证**：`packages/server`、`packages/daemon` 两边 `tsc --noEmit` 都干净；daemon 36 个单测全过。服务端集成测试受限于本机开发服务器不在 `NODE_ENV=test` 模式（会撞限流），跟 P0 那轮一样没法完整跑，逻辑靠手工核对。

**尚未做/明确排除在这轮之外**：
- 服务端没写针对 `agents-credentials.ts` 的自动化测试（新路由，仓库里也没有类似端点的现成测试模板可参考）。
- 没有做"daemon 重启后主动清理所有遗留 `agent_credentials` 行"的逻辑——不需要：下次这个 agent 被 dispatch 时会重新 mint，upsert 自然覆盖旧行；真正孤儿的（agent 从此再没被 dispatch 过）会在 24h TTL 后自然失效，不清理也不会一直有效。
- 没有改 `tokenRegistry`/`agent-tokens.ts` 本身（保留为无害死代码，见上）。
