# Slock Server 综合评估报告

> 评估日期：2026-08-28  
> 评估范围：`packages/server/src/` 61 个源文件（routes 23 + lib 28 + db 5 + ws 1 + index + types）、`test/` 31 个测试文件 + helpers（289 用例）；并交叉核对 daemon（client.ts / daemon-core / mcp / cli）、web（Vue3 api 层）与 `@collabagent/shared` 的三端契约  
> 评估方法：7 名子 agent 并行按维度精读源码与测试（架构 / 路由完成度 / 数据层与 WS / 安全 / 后台任务与集成 / 测试质量 / 接口契约），结构化结论由主编综合去重、定级；所有问题均带 file:line 证据，标注「待确认」处需运行时核实  
> 当前基线（2026-08-28 本机实测）：`tsc --noEmit` 零错误；server 本机可启动（`.env` + 本地 PG，`/api/health` 返回 `{db:true}`）；vitest 为黑盒集成测试，**须先以 `NODE_ENV=test` 启动 server**（`rate-limit.ts:74` 依赖此开关跳过限流），正确姿势下 **32/32 文件、283/283 用例全绿**（约 83s）；以普通模式起 server 会被套件自身注册量触发 429（实测 146 过 / 20 败，败因全部为 `请求过于频繁`）  
> 版本上下文：当前分支 `feature/web-vue3`（web 为 Vue3 重写版）；daemon 侧评估报告 P0.1–P1.16 已全部落地（`docs/2026-08-24/01-daemon-evaluation-report.md`）；**server 侧 P0.1–P0.10 已落地。注：P0.1/P0.2 修复（b230648/2670d0f）当时只提交推送到了 `feature/web-vue3`，未合并回 main，导致 main 工作区一度复核为「失实」；2026-08-30 经 merge（4fdf1f9）补入 main 并与 P0.3/P0.4 一并复验（33/33 文件 295 用例全绿）；P0.5 于同日落地后复验 299 用例全绿；P0.6/P0.7 同日落地复验 301 用例全绿；P0.8 同日落地复验 34/34 文件 306 用例全绿；P0.9 于 2026-08-31 落地复验 34/34 文件 307 用例全绿；P0.10 于 2026-08-31 落地复验 35/35 文件 310 用例全绿；P0.11 于 2026-08-31 落地复验 35/35 文件 312 用例全绿；P1.12 于 2026-08-31 落地复验 36/36 文件 320 用例全绿；P1.13 于 2026-08-31 落地复验 36/36 文件 323 用例全绿；P1.14 于 2026-08-31 落地复验 37/37 文件 331 用例全绿；P1.15 于 2026-08-31 落地复验 38/38 文件 345 用例全绿；P1.16 于 2026-08-31 落地复验 38/38 文件 349 用例全绿；P1.17 于 2026-08-31 落地复验 38/38 文件 354 用例全绿**

---

## 1. 执行摘要

### 1.1 总体健康度

| 维度 | 评分 | 简要评价 |
|---|---|---|
| 架构与模块组织 | 7.0 / 10 | 组装点单一、依赖方向干净（无循环依赖）、租户/权限层设计成熟；扣分：drizzle 死链、机器令牌校验双份漂移、`/files/` 限流缺口、配置集中度破洞 |
| 路由与业务功能完成度 | 7.0 / 10 | 核心链路（认证/消息/频道/任务/派发/提醒/通知/附件/审计）系统化还债后质量扎实；`/internal/agent` 旧版双轨留有一个必 500 坏端点与两处枚举缺口，integrations 纯 stub |
| 数据层与 WS 实时层 | 6.8 / 10 | schema 索引与并发正确性高水准（advisory lock、幂等 nonce、部分唯一索引、GIN）；但 broadcast fail-open、迁移无锁非事务、drizzle 双 schema 真相 |
| 安全与权限模型 | 7.5 / 10 | 分层防御成型（会话回查 fail-closed、双维度防爆破、CSRF 双提交、生产 secret 硬校验、审计哈希链）；**token 用 `Math.random()` 生成**是最大实质缺口 |
| 后台任务与 Agent 集成 | 6.0 / 10 | 调度认领（SKIP LOCKED）/patrol 护栏/T8 分诊/duty 模型设计正确且有测试；提醒 at-most-once 静默丢失、取号竞态、成本断链、多实例读路径系统性错误 |
| 测试覆盖与代码质量 | 7.0 / 10 | 集成网广且断言真实（20 并发 seq 一致性、幂等重放是教科书级）；agent API 面与 SSRF 面约 800 行零覆盖，89 处 any |
| 三端接口契约一致性 | 7.5 / 10 | WS 四方向 union 由 shared 真收口（全仓契约质量最佳实践）；但 web WS 路径漂移 + 3 组缺失端点 + 心跳模型不一致 |
| **综合** | **7.0 / 10** | 产品功能面已闭环、还债痕迹良好；剩余风险集中在**凭据生成源、WS 广播 fail-open、旧路由双轨、任务取号竞态、三端契约 drift** 五处 |

### 1.2 关键结论

1. **产品功能面已基本闭环**（完成度总评见 §2.2），但 `/internal/agent` 旧版 CRUD 与 `/api/agents` 新版双轨并存，遗留 1 个必 500 的 PATCH 端点 + 3 个无 org 校验的枚举/创建端点，是"该退役未退役"的最大单项债。
2. **安全框架成熟，但凭据随机源是硬伤**：`sk_agent_`/`sk_machine_` 用 `Math.random()`（V8 xorshift128+，非 CSPRNG）生成，与 `token-hash.ts:6` 声称的「~165 bit 熵」直接矛盾；Node 单进程共享 PRNG，理论上可由已签发 token 恢复 PRNG 状态后预测后续签发。修复是一行级改动、收益最高。
3. **WS 实时层是当前最薄弱的安全面**：`broadcast()` 查频道失败 fail-open 退回全发（DB 抖动 → 私有频道/DM 明文广播给全部浏览器）；`handleEnvelope` 对 daemon 无条件全发（所有用户 daemon 收到他人私有频道明文）；`deliver()` 无背压。
4. **后台任务"单实例正确、多实例半安全"**：SKIP LOCKED 已消除调度重复，但 presence/在线数、metrics 聚合恢复、task_number 取号三处在多实例下系统性错误；提醒投递 at-most-once，目标 daemon 离线即静默丢失且不可察觉。
5. **三端契约 daemon 侧最扎实，web 侧有隐形雷**：web 连接 `/ws/chat` 而 server 注册 `/ws`（dev 被 vite 代理掩盖，生产静态托管下实时功能全断）；忘记/重置密码端点不存在（页面已写好、CSRF 豁免已预留）；web 看门狗 70s 无消息即重连（感知不了协议层心跳）→ 空闲重连风暴。
6. **测试**：289 用例、断言质量高，但 agent API 面（agents-messages / agents-credentials / agents-tasks 共约 550 行）与 preview（服务端 URL 抓取 = SSRF 面）零覆盖；测试强依赖"先手起 server + PG"，离线即 21/32 文件失败。

### 1.3 最高优先级行动项（P0）

| # | 行动项 | 位置 | 预期收益 |
|---|---|---|---|
| P0.1 | ~~`sk_agent_`/`sk_machine_` 生成换 CSPRNG（`crypto.randomBytes(24).toString("base64url")`）~~ **✅ 2026-08-30 已修**：两处生成点均换 `randomBytes(24).toString("base64url")`（192 bit 熵）；`token-hash.ts` 注释同步修正。注：修复（b230648）当时只推到了 `feature/web-vue3` 未合并回 main，2026-08-30 经 merge 补入并复验 | `routes/agents-credentials.ts:18-24`、`routes/profile.ts:206-210` | 消除凭据可预测性（一行级修复） |
| P0.2 | ~~`broadcast()` 查频道类型/成员失败改 fail-closed（放弃或仅公开频道）~~ **✅ 2026-08-30 已修**：解析失败一律丢弃事件并 warn（安全优先于送达，消息可按 seq 游标 REST 补拉）；private/dm 成员定向与 public 全发语义不变；新增 `test/ws-broadcast.test.ts` 8 用例回归。注：修复（2670d0f）当时只推到了 `feature/web-vue3` 未合并回 main，2026-08-30 经 merge 补入并复验 | `ws/handler.ts:436-471` | 消除 DB 抖动时私有频道内容全网广播 |
| P0.3 | ~~web WS 路径统一为 `/ws`（改 `AppLayout.vue:165`，删 vite 代理重写与测试 URL）~~ **✅ 2026-08-30 已修**：`AppLayout.vue:165` 连接路径改 `/ws`；`vite.config.ts` 删除 `/ws/chat` 重写代理条目（保留 `/ws` 直连代理）；`wsManager.test.ts` 测试 URL 同步改 `ws://test/ws`。全仓仅剩 docs 历史文档提及 `/ws/chat`；vue-tsc 零错误、web 41/41 用例绿 | web `AppLayout.vue:165` ↔ server `index.ts:259` | 消除生产静态托管下实时功能全断的隐形雷 |
| P0.4 | ~~`/internal/agent` 旧版路由收敛：修复/下线 PATCH（更新不存在的列 `runtime`/`model`，必 500）；`GET /`、`GET /channel/:id`、`POST /` 补 org/频道校验或直接下线改用 `/api/agents`；join/leave 限定 `(server_id, name)`~~ **✅ 2026-08-30 已修**：四个零调用方顶层端点（GET /、GET /channel/:id、POST /、PATCH /:agentId）下线（`/api/agents` 新版全覆盖；PATCH 更新不存在的列必 500）；join/leave 改租户候选集合解析（agent 所在 org 优先 + owner 所属 orgs + 单租户默认社区豁免，对齐 resolveTenant O3 哲学；候选外一律 404 不泄露存在性）；顺手清理 `agents.ts:5-7` 死 import。新增 5 个回归用例（旧端点 404 ×1、join/leave 租户收敛 ×4）；merge P0.1/P0.2 后全量复验 33/33 文件 295 用例绿 | `routes/agents.ts`（整文件重写） | 消除必 500 假实现 + 水平越权 + 跨租户串频道 |
| P0.5 | ~~任务取号加 `UNIQUE(channel_id, task_number) WHERE task_number IS NOT NULL` 部分索引；claim 改条件更新（`AND task_assignee IS NULL RETURNING *`）~~ **✅ 2026-08-30 已修**：① 迁移 `018_task_number_unique.sql`——先重排历史重号（每组保留最早、其余按频道 MAX+seq 顺延，无重号零影响）再建部分唯一索引 `uq_messages_channel_task_number`；② 取号 4 处（tasks POST /、/from-message、agents-tasks POST、dispatch 卡片）改 `app.pg.transaction` + 频道级 `pg_advisory_xact_lock('taskno:'||channel_id)`（`lib/task-numbering.ts` 统一封装，锁键独立于 seq 锁）——单语句 MAX+1 子查询「单语句≠原子」，锁内读 MAX+写入才真串行；③ claim 2 处（tasks/agents-tasks）改条件更新（WHERE 带非终态 + 无人认领或本人，RETURNING 拿旧状态记事件），0 行时按当前行分类 not_found/task_is_done/already_claimed_by_other 保持错误码兼容；新增 4 个回归用例（串行/并发双 claim、并发建任务连号、agent 侧 claim）；全量 33/33 文件 299 用例绿 | `db/migrations/018` + `lib/task-numbering.ts` + `tasks.ts` + `agents-tasks.ts` + `agents-dispatch.ts` | 消除并发重号 / 双 claim 串任务 |
| P0.6 | ~~`/api/messages` 两处 limit 加 clamp（`Math.min(≤200)`，对齐 notifications 写法）~~ **✅ 2026-08-30 已修**：`GET /`（messages.ts:71）与 `GET /history`（原 :435/438 双处 `Number(limit)||50` 收拢为单个 `lim`）均改 `Math.min(Math.max(parseInt(limit||"50",10)||50, 1), 200)`，默认 50 与 hasMore 语义不变；`messages.test.ts` 新增 2 用例（超上限钳 200 / 负数钳 1，两路由各一）；复验 33/33 文件 301 用例绿 | `routes/messages.ts:71、435` | 消除单请求全量捞取的响应体/DB 压力 DoS 面 |
| P0.7 | ~~`/files/` 静态路径补限流 hook（addHook 移到 filesScope 之前），并文档化 capability URL 模型或收敛到 by-key ACL~~ **✅ 2026-08-30 已修**：① `server.addHook("onRequest", rateLimitHook)` 上移到 filesScope 注册之前（Fastify 子作用域按 register 时父上下文快照继承 hook，后挂不回溯），`/files/` 纳入 api 桶（100/min）；② capability URL 模型选择「文档化」而非收敛 by-key——`index.ts` filesScope 块与 `storage.ts` `publicUrl` docstring 双处立此存照（uuid 前缀 122bit 为能力凭证、登录即可下载、泄漏由不可猜测性兜底、严 ACL 走 by-key、收敛方向已注明）。实测：非 test 模式 server（PORT=3002）打 `/files/probe` 110 次，恰 100×401 + 10×429；全量复验 33/33 文件 301 用例绿 | `index.ts:204-210`、`storage.ts:82-84` | 消除"不限流 + 登录即全量"的附件下载面 |
| P0.8 | ~~`actions.prepare` 补 `canAccessChannel` + action.type 白名单；无产品规划则冻结 action_cards~~ **✅ 2026-08-30 已修**：写入口保留但加固——type 白名单（`channel:create`/`agent:create`，取自历史审批卡片设计）、target 必填 + 频道 404（顺带修掉 `ch?.id||null` 撞 NOT NULL 约束的必 500）、`canAccessChannel` 403、action_data 8KB 上限；文件头注明「半成品冻结」状态与产品化重启清单。新增 `test/actions.test.ts` 5 用例（白名单收/拒、400/404、非成员 403、成员 200）；`test/helpers.ts` 清理补 `action_cards` 按 created_by/target_user 维度（投到 #general 的卡片原清理不到，会 FK 违例）；全量复验 34/34 文件 306 用例绿 | `routes/actions.ts:6-18` | 消除向任意私有频道投卡片的越权写入 |
| P0.9 | ~~`GET /server` 补私有频道过滤与成员校验（对齐 `GET /` 谓词），或确认产品语义后注释立此存照~~ **✅ 2026-08-31 已修**：channels 查询补 `AND (c.type <> 'private' OR cm.role IS NOT NULL)`，与 `GET /`（channels.ts:23）及 `orgs.ts /server/info`（已带同谓词）三处口径一致——产品语义定稿为「工作区总览不泄露非成员私有频道」；join 条件顺带对齐 `cm.member_id::text = $1`；server 成员 403 校验本已存在（channels.ts:380-384）无需改动。`channels.test.ts` 新增 1 回归用例（个人 org 加第二用户为 member：owner 可见私有频道、同 server 非频道成员 200 但不可枚举）；复验 34/34 文件 307 用例绿 | `channels.ts:385-391` | 消除私有频道名称/描述的枚举可见性 |
| P0.10 | ~~`migrate.ts` 加 `pg_advisory_lock` 包裹整个 runMigrations + 每文件包事务（`sql.begin`）~~ **✅ 2026-08-31 已修**：`sql.reserve()` 独占连接 + 会话级 `pg_advisory_lock(712043)`（固定 key，避开审计链 712042）包裹全程——多实例并发启动及 index.ts/pgPlugin 双处触发均串行，后到者锁后读到完整 _migrations 自然全 skip；每文件手动 BEGIN/COMMIT/ROLLBACK（postgres.js ReservedSql 无 `.begin()` 运行时方法，实测踩坑后改手写），迁移内容与 _migrations 记录同生共死、失败整体回滚可从断点续跑；签名加 `opts?: { dir?: string }`（测试注入 scratch 目录用）并返回应用数（现有三调用方不传参不读返回值，兼容）。新增 `test/migrate.test.ts` 3 用例（并发同目录恰应用一次、失败回滚+修复重入、真实目录 no-op）；复验 35/35 文件 310 用例绿 | `db/migrate.ts:27-36` | 消除多实例启动迁移竞态与半态迁移 |
| P0.11 | ~~`PATCH/DELETE /api/agents/:agentId` 补所有权校验（`requireOwnAgent` 或 `a.user_id = caller`，与 internal 侧对齐）~~ **✅ 2026-08-31 已修**：两路由 preHandler 挂 `requireOwnAgent`（404 不存在 / 403 "not your agent"，与 /internal/agent 侧语义一致），取代原先只查 org 成员的校验（该检查挡不住共享 org 内改/删他人 agent 的水平越权）；PATCH 顺带删掉被取代的存在性/org 查询，DELETE 的 `sendToDaemon` 目标直接用调用者本人（requireOwnAgent 已保证 agent.user_id 一致），各省一次查询。调用方核实：web `MemberProfileBody` 编辑/删除/工作区/巡检全按 `ownedByMe` 门控、`ComputerView` 删除走 `mine=1` 列表，daemon 无 PATCH/DELETE `/api/agents/:id` 调用方——收紧无 UI 破坏。`agents.test.ts` 新增 2 用例（共享 org 非 owner PATCH/DELETE 403 + owner 编辑/删除正常链路、非成员 DELETE 403）；复验 35/35 文件 312 用例绿 | `agents-public.ts:177、241` | 消除共享 org 内编辑/删除他人 agent 的水平越权 |

---

## 2. 各维度详细发现

### 2.1 架构与模块组织（7.0 / 10）

**优点**

- 单一组装点 + 有意识的注册时序：所有插件/hook/装饰器/路由集中在 `index.ts`，关键顺序决策均配因果注释（如 `index.ts:203`、`index.ts:216-217`）。
- 依赖方向干净无循环：`lib/*` 零反向 import `routes/*`（grep 证实），`routes → lib → db/config` 单向；18 处动态 import 均无环。
- `tenant.ts` 纯函数可单测、O3 豁免的安全权衡有完整推理注释；`access.ts` 缓存一致性（TTL 兜底 + 主动失效 + pub/sub 扇出）成熟。
- 配置 fail-fast（`collectInsecureConfig` 纯函数可测，生产命中危险默认值即 `exit(1)`）；统一错误处理器 5xx 掩蔽细节。
- 全局 grep `TODO|FIXME|HACK|XXX` **零命中**；机器令牌 sha256 快路径 + bcrypt 兼容路径可观测、有退役文档（O8）。

**关键问题**

| 严重度 | 文件:行号 | 问题 | 后果 |
|---|---|---|---|
| 中高 | `index.ts:204-210` | ~~`filesScope`（`/files/` 静态附件）注册于 `rateLimitHook`/CSRF 的 `addHook` **之前**，Fastify hook 不回溯已注册路由~~ **✅ 2026-08-30 已修（P0.7，rateLimitHook 上移纳入限流；CSRF 仅管改写型方法，对 GET 静态下载本不适用）** | ~~附件静态下载完全不限流~~（另见 P0.7） |
| 中高 | `ws/handler.ts:451-453` | ~~`broadcast()` 频道类型查询失败时「退回全发」——fail-open~~ **✅ 2026-08-30 已修（P0.2，改 fail-closed）** | ~~DB 抖动窗口内私有频道消息事件广播给全部浏览器~~（另见 P0.2） |
| 中高 | `login-lock.ts:151-153` | ~~`clientIpOf` 无条件信任 XFF 第一段；全局限流用 `request.ip`（`rate-limit.ts:77`），两套 IP 判定方向相反~~ **✅ 2026-08-31 已修（P1.13，trustProxy 显式化 + clientIpOf 与限流同源 req.ip）** | ~~伪造 XFF 绕过 IP 维度登录锁定；反代下 API 限流按代理 IP 全员共享一桶~~ |
| 中高 | `index.ts:157-173`、`ws/handler.ts:163-174` | ~~未知 `sk_machine_` token 触发全表拉取 + 逐行 bcrypt（12 轮），HTTP/WS 两处、无熔断~~ **✅ 2026-08-31 已修（P1.14，per-IP 速率 + 并发护栏，超预算 429/4001 不触达 DB/bcrypt）** | ~~无效 token 可稳定触发 O(N×12) CPU，DoS 放大面~~ 已消除 |
| 中 | `index.ts:136-175` vs `ws/handler.ts:145-179` | ~~机器令牌校验逻辑逐行重复两份；WS 侧 JWT 不做 session 回查，与 HTTP 侧深度不一致~~ **✅ 2026-08-31 已修（P1.15，收敛 lib/auth-token.ts + WS session 回查）** | ~~logout-all/改密后 WS 长连接仍有效；修 bug 需改两处，注定漂移~~ 已消除 |
| 中 | `index.ts:9`、`ws/handler.ts:9` | ~~`@fastify/jwt` 与 `jsonwebtoken` 双 JWT 库并存，靠注释约定保持 secret/算法同步~~ **✅ 2026-08-31 已修（P1.15，双 namespace 收口 @fastify/jwt，依赖已删）** | ~~任一侧改动即静默验签失败，WS 全部降级 anon~~ 已消除 |
| 中 | `db/drizzle-pg.ts`、`db/schema.ts` | 整条 drizzle 链死重：`schema.ts` 全仓无运行时引用，查询全走 postgres.js 裸 SQL | 空转依赖 + 两份 schema 真相（已定性「最差中间态」未处置） |
| 中 | `index.ts:64-68`、`tenant.ts:75` | `CORS_ORIGINS`/`SERVER_HOST_MAP` 绕过 `lib/config.ts` 直读 env | 配置真相分裂，与 config.ts 自称「统一读取」的注释矛盾 |
| 中低 | `profile.ts:17`、`integrations.ts:12` | HTTP 200 + `{error}` 返回错误，与全仓 4xx 惯例相悖 | 错误被客户端当成功；错误形状名存实亡 |
| 中低 | `index.ts:72-78` + 23 个 route | swagger 零 schema、`/docs` 生产无鉴权暴露（含 `/internal/agent/*`） | OpenAPI 空壳 + 内部路由结构泄漏 |
| 中低 | `ws/handler.ts` 多处、`agent-duty.ts:109` 等 | 运行时路径 `console.log/warn` 直出绕过 pino | WS 日志无 reqId、不可分级采样、与 HTTP 日志割裂 |
| 低 | `agents.ts:5-7` 死 import；`agents-public.ts:12-22` ≡ `people.ts` 重复；seed 逻辑双份；`types/fastify.d.ts` scope any 等 | — | 卫生类债务，批量清单见 §4 P2 |

### 2.2 路由与业务功能完成度（7.0 / 10）

**优点**：认证体系完整度高（cookie+CSRF+refresh 轮换+会话回查+防爆破+scoped token 禁自续期）；消息发送是全仓最精的部分（`clientNonce` 部分唯一索引幂等 O15、`pg_advisory_xact_lock` 保证 seq 提交序防补拉漏消息 O9、消息+审计+附件+agent 入圈单事务）；审计读路径 fail-closed；附件访问控制统一出口；dm 解析考虑并发竞态回查。

**产品功能完成度总评**

- **已闭环**：认证/会话/资料/注销/机器令牌、组织+邀请链接、频道（成员/角色/经理/分诊开关/软删硬删）、消息全链路（幂等/编辑留痕/软删/线程/reaction/搜索/断线补拉游标）、DM、任务看板（人类+agent 双侧对称）、经理派发 dispatch（open→reported/cancelled，看板卡片/任务事件三方联动）、提醒+巡检（双侧完整，pause/resume/snooze/log）、通知中心、附件（双存储+统一 ACL）、审计哈希链+校验、agent 一等公民管理（duty/computer/workspace/凭证）、people 档案、metrics 采集。
- **半成品**：① action_cards 只有 prepare 写入口（无读取/完成端点）；② `/internal/agent` 旧版与新版权限语义互相矛盾；③ people stats `costUsd` 恒 null（D3 成本记账未接到档案页）；④ 忘记密码端点不存在（CSRF 豁免名单 `index.ts:225` 已预留 `forgot|reset`）；⑤ 任务无"被指派"实时通知；⑥ reaction/任务变更无 WS 推送。
- **纯 stub**：integrations（`GET /api/integrations` 硬编码 `logins: []`、`POST /login` 恒 200 假成功；agent_logins 表零写入方）。

**关键问题**（除 P0 表所列 6 条外）

| 严重度 | 文件:行号 | 问题 | 后果 |
|---|---|---|---|
| 中 | `auth.ts:78-89` | invite 消费 TOCTOU（SELECT 校验后 UPDATE 无 `WHERE uses < max_uses` 且不在事务） | 并发注册超额消费邀请链接 |
| 中 | `auth.ts:177-181` | ~~`/refresh` cookie 回退分支把 access cookie 当 refresh 用 REFRESH_SECRET 验证~~ **✅ 2026-08-31 已修（P1.16，cookie 兜底分支删除，仅收 body.refreshToken）** | ~~永远 401 的死码，误导维护者~~ 已删除 |
| 中 | `auth.ts:52-64` | 注册 email 无格式校验；查重非原子，并发 500 未映射 409 | 非法 email 入库；并发注册 500 |
| 中 | `channels.ts:39-51、77-81` | 频道 type 无枚举校验；重名检查原值口径 vs 唯一索引 `lower(name)` 口径不一致 | type 污染后 `canAccessChannel` 判定失真；大小写重名绕过检查后 500 |
| 中 | `channels.ts:134-146` | join 把 `body.memberType` 原样入库 | 人类可自登记为 'agent'，污染权限判定类型假设 |
| 中 | `messages.ts:104-145` | `/send` threadId 不校验存在性/同频道归属；content 无长度上限 | FK 500；跨频道线程错乱；超长消息无界 |
| 中 | `messages.ts:473-507、563-586` | 编辑/删除消息不校验 `canAccessChannel` | 被移出私有频道者仍可改/删旧消息并触发广播 |
| 中 | `tasks.ts:188-269` | unclaim/update-status 无 assignee 校验 | 任何人可抢放/改他人任务状态 |
| 中 | `preview.ts:53-64` | SSRF：302 跟随不复查、不解析 DNS | 公网 URL 跳内网 / DNS rebinding 绕过 |
| 中 | `reminders.ts:24-29` | fireAt/delaySeconds 未校验合法性（对照 agents-reminders 有完整校验） | 非法输入 → 500 |
| 低 | notifications `:id`/`ids`、orgs `maxUses/expiresInDays` 未预检；notifications `:36-45`、`orgs.ts:99-106` | uuid/数值不预检 | cast 异常 500（应 400）；NaN/负数边界 |
| 低 | `metrics.ts:4-37` | /api/metrics 无 admin 门禁 | 任意登录用户读全部 daemon 主机名/OS/版本 |
| 低 | `agents-messages.ts:161-164` | receive 首次置全表 `MAX(seq)` | 新 agent 历史全跳过（语义待确认） |
| 低 | `attachments.ts:31-44` | 非上传者只查前 5 条挂载链接 | 附件挂载 >5 条时可能误 403 |

**幂等性专项**：消息发送幂等完整（人类侧 O15 nonce；agent 侧无 nonce 但 daemon 语义可接受）；注册非幂等（并发 500）；任务创建非幂等（MAX+1 竞态）；computer POST /、machine-token 轮换幂等正确。

### 2.3 数据层与 WS 实时层（6.8 / 10；子评分：schema 8 / 租户隔离 6.5 / 迁移安全 6 / drizzle 4 / pubsub 7.5 / ws-handler 6.5 / task-events 7）

**优点**

- 消息表索引成熟：`(channel_id, seq)` 支撑分页与 DM LATERAL；thread/task 均部分索引；幂等键部分唯一索引带谓词。
- 并发正确性有真功夫：`/send` 用 `pg_advisory_xact_lock` 保证「提交序 == seq 序」（注释解释了 BIGSERIAL 赋值序 ≠ 提交序的断线补拉漏消息问题，`messages.ts:165-171`）。
- 事务边界清晰：消息+审计+@提及+附件同事务；通知/分诊/广播有意放事务外并注释取舍；幂等重放短路且跳过全部副作用。
- WS 鉴权失败统一 4001（注释记录历史漏洞与修复）；pubsub 双连接/重连重订阅/错误限流语义正确；迁移全程幂等可重试。

**关键问题**

| 严重度 | 文件:行号 | 问题 | 后果 |
|---|---|---|---|
| 高 | `ws/handler.ts:439-453` | ~~broadcast fail-open~~ **✅ 2026-08-30 已修（P0.2，改 fail-closed）**（另见 P0.2） | ~~私有频道明文跨租户广播~~ |
| 高 | `channels.ts:385-391` | ~~`GET /server` 无私有频道过滤/成员校验（另见 P0.9）~~ **✅ 2026-08-31 已修（P0.9，对齐 `GET /` 谓词）** | ~~私有频道名称/描述可枚举~~ |
| 中高 | `ws/handler.ts:553-558` | channel 信封对 `daemonClients` 无条件全发（含私有频道/DM） | 所有用户 daemon 收到他人私有频道明文；多用户托管应收敛 |
| 中高 | `db/migrate.ts:27-36` | ~~迁移非事务、无 advisory lock（另见 P0.10）~~ **✅ 2026-08-31 已修（P0.10，会话锁 + 每文件事务）** | ~~多实例并发启动失败；中途失败留半态~~ |
| 中 | `docker-compose.yml:28` | 挂载不存在的 `src/db/schema.sql` 到 initdb | 幽灵文件；双轨初始化已断裂成单轨仍误导排障 |
| 中 | `db/schema.ts` vs migrations | drizzle 模型系统性漂移（无 `client_nonce`、索引口径、无 TZ、缺 dispatches 等） | 两份 schema 真相；drizzle-kit 生成迁移会灾难 |
| 中 | `pubsub.ts:97-102` | Redis 故障 publish 静默吞错仅一次日志 | 多实例下 Valkey 抖动 → 实例间互达中断且无告警 |
| 中 | `pubsub.ts` + `handler.ts:276,282` | 全部 WS 事件共用单频道扇出，terminal-frame 每帧 PUBLISH 到所有实例 | 多实例 pubsub 流量 = 全局事件量 × 实例数 |
| 中 | `ws/handler.ts:533-541` | deliver 裸 send 不查 `bufferedAmount` | 慢消费者无背压，高频帧内存无限积压 |
| 中低 | `channels.ts:354-372` | `/dms` 查询无 type 索引 + `member_id::text` cast 弃用索引 | DM 增长后顺序扫描（cast 模式散布多处） |
| 中低 | `ws/handler.ts:103-107,134` | 未认证 earlyBuffer 无上限；bcrypt 全表扫描窗口拉长 | 未认证连接可灌消息占内存 |
| 中低 | `channels.ts:236-264` | role 与 is_manager 两条 UPDATE 无事务 | 部分失败留半态 |
| 低 | 冗余/死索引 ×3、seed 重复插入、`/history` hasMore 边界、审计全局单锁 | 见 §4 P2 清单 | 写放大与串行点（当前量级自评无压力） |

**SQL 注入评估结论**：全仓 raw SQL 均为 postgres.js 参数化；动态拼接点（`channels.ts:70-107`、`agents.ts:172`、`channel.ts:40`、`audit.ts:69`）标识符全部来自代码内白名单，`/search` 走 `plainto_tsquery` 参数化。**未发现注入面**。

---

### 2.4 安全与权限模型（7.5 / 10）

**优点**

- bcrypt cost 12；会话状态回查 fail-closed（sid 吊销 + token_version 双检，DB 异常宁可误拒，`session-check.ts:19-41`）；refresh 轮换把旧 access token 窗口从 7 天缩到秒级。
- 登录防爆破双维度（账号 5/IP 20 次，15min，Valkey 共享；P1.13 起 IP 判定与限流同源 req.ip，XFF 仅在 TRUST_PROXY 显式声明反代链时采信）+ pttl 边界兜底；CSRF 双提交 + SameSite=Lax 双保险，Bearer 豁免判断正确。
- token 存储双轨迁移干净（sha256 快路径走唯一索引 + bcrypt 兼容分支带计数器观测与退役文档）；`sk_agent_` scoped token fail-closed（仅 `:agentId` 路由可认证、24h TTL、签发即撤旧、禁自我续期）。
- `requireOwnAgent` 覆盖 `/internal/agent` 全部 24 处 `:agentId` 路由（grep 核实）；上传防穿越双重防御（文件名净化 + uuid 前缀 + resolve 前缀比较）；审计哈希链 advisory lock 防分叉；生产 secrets O5 硬校验；预提交敏感文件拦截。
- `security-fixes.test.ts` 直接锚定历史安全修复（附件 ACL 三态、私有频道禁自 join、IDOR、会话吊销即时失效）。

**关键问题**

| 严重度 | 文件:行号 | 问题 | 后果 |
|---|---|---|---|
| 高 | `agents-credentials.ts:18-24`、`profile.ts:206-210` | ~~token 随机部分用 `Math.random()`~~ **✅ 2026-08-30 已修**（P0.1）：生成源换 `crypto.randomBytes(24)` CSPRNG | ~~凭据可预测（PRNG 状态恢复攻击）~~ 已消除 |
| 中 | `index.ts:204-207`、`storage.ts:82-84` | `/files/` 仅登录即放行，无频道级 ACL；S3 后端走 by-key 有完整 ACL——两后端鉴权模型不一致 | 登录用户持 storage_url 可绕过私有频道 403 直取文件（uuid 前缀构成弱 capability URL，泄漏即失效） |
| 中 | `agents-public.ts:177-189、241-250` | ~~PATCH/DELETE agent 只校验 org 成员不校验所有权（另见 P0.11）~~ **✅ 2026-08-31 已修（P0.11，requireOwnAgent）** | ~~共享 org 内水平越权（改 runtime/删 agent）~~ |
| 中 | `login-lock.ts:151-154` | ~~XFF 无条件采信（另见 §2.1 中高）~~ **✅ 2026-08-31 已修（P1.13）** | ~~IP 维度锁定可旁路，分布式撞库喷洒~~ |
| 中 | `profile.ts:217-220` | ~~machine_tokens 无 `expires_at`（对比 sk_agent_ 24h）~~ **✅ 2026-08-31 已修（P1.12，默认 90 天滚动续期 + 签发上限）** | ~~账号级全权 token 永不过期、可无限签发~~ 已消除 |
| 中低 | `auth.ts:140-152` | ~~登录错误细分用户不存在/密码错误；用户不存在时跳过 bcrypt 时序差~~ **✅ 2026-08-31 已修（P1.16，统一 401「用户名或密码错误」+ 假 bcrypt 时序平衡）** | ~~用户名枚举 + 存在性探测~~ 已消除 |
| 中低 | `cookies.ts:26-31` | cookie 永不设 `Secure`、无 `__Host-` 前缀，依赖反代改写 | 部署疏漏即凭据明文传输 |
| 中低 | `auth.ts:177-185` | ~~`/refresh` cookie 兜底死码；无 sid 的 refresh 跳过吊销校验~~ **✅ 2026-08-31 已修（P1.16，死码删除 + 无 sid 一律拒绝）** | ~~带 cookie 不带 body 的刷新全挂；理论吊销缺口~~ 已消除 |
| 中低 | `session-check.ts:28-32`、`index.ts:184` | 无 tv/sid 的历史 token 跳过 token_version/会话校验 | 存量旧 token 对 logout-all/改密免疫（迁移边界，待确认存量） |
| 低 | ~~dev-token 靠 NODE_ENV 挡、`/docs` 生产暴露~~（✅ 2026-08-31 已修，P1.17：`SLOCK_DEV_TOKEN=1` 显式开关 + 生产不注册 swagger；生产误配由 collectInsecureConfig 启动拦截）、session 缓存无清扫、MIME 无魔数嗅探、Valkey PEXPIRE NX 需 ≥7.0、审计链无外部锚定、org 内 hostname 泄漏 | 见 §4 P2 | 择期处理 |

**安全机制状态清单（摘要）**：bcrypt12 ✅ / 双密钥 JWT ✅ / refresh 轮换 ✅ / 会话回查 ✅ / 防爆破 ✅（~~IP 维度可旁路~~ P1.13 后 IP 判定与限流同源 req.ip，XFF 默认不采信、反代需显式 TRUST_PROXY）/ 全局限流 ✅（未配 trustProxy）/ CSRF ✅ / cookie httpOnly ✅（~~Secure ❌~~ P1.17 起应用层判定：生产默认开启，可显式覆盖）/ sk_machine_ ⚠️（~~Math.random~~ 生成已换 CSPRNG ✅ P0.1；~~永不过期/无限签发~~ 默认 90 天滚动续期 + 单用户活跃上限 10 ✅ P1.12）/ sk_agent_ scoped ✅ / legacy bcrypt 退役观测 ✅（P1.14 起兼容路径带 per-IP 速率 + 并发护栏，超预算 429/4001） / requireOwnAgent ✅（/api 侧 agent PATCH/DELETE 例外已于 P0.11 补齐）/ 上传防护 ✅（无魔数/配额）/ 附件 ACL ⚠️（/files/ 无）/ 租户边界 ✅（默认豁免是文档化决定）/ 审计链 ✅（无外部锚定）/ secrets 硬校验 ✅。

### 2.5 后台任务与 Agent 集成（6.0 / 10）

**优点**

- reminder-scheduler 多实例认领正确（单事务 `FOR UPDATE SKIP LOCKED`，沉默判定用旧 `last_fired_at` 顺序正确）；patrol 护栏完整（频率下限/数量上限/沉默自动暂停+owner 通知，注释记录 E2E 实锤教训）。
- fire 定向投递而非广播（只发 owner daemon，避免误拉起 403）；T8 分诊纯函数 + 全分支单测；duty 意愿与进程分层。
- runtime-probe 归一化防御性好；task_events best-effort 不拖垮主流程；WS 心跳 30s/10s 清死连接；metrics_samples 7 天自动清理。

**关键问题**

| 严重度 | 文件:行号 | 问题 | 后果 |
|---|---|---|---|
| 高 | `agents-dispatch.ts:117-125` | task_number 取号「MAX+1 子查询」在 READ COMMITTED 下可重号，且无唯一约束兜底（注释自称「原子」不成立）（另见 P0.5） | 并发派发重号；claim/看板按 task_number 定位会串任务 |
| 中高 | `reminder-scheduler.ts:70-73、117-134` | 认领不校验目标 owner daemon 在线；`sendToDaemon` daemon 分支找不到连接静默丢弃 | daemon 离线 → 提醒被标 fired 但无人接收，一次性提醒永久丢失 |
| 中 | `reminder-scheduler.ts:98-104` | 认领（标 fired）与投递间有崩溃窗口，at-most-once，无 ack | server 重启丢已认领未投递提醒，不可察觉 |
| 中 | `agents-tasks.ts:66-88、110-160` | claim 先 SELECT 再无条件 UPDATE（双 claim 双成功）；unclaim/update-status 无归属校验 | 看板写权限开放，agent 可互相破坏任务状态 |
| 中 | `lib/reminders.ts:24-26`、`reminder-scheduler.ts:137` | `daily@HH:MM` 依赖 server 本地时区；周期重排以处理时刻为基准逐轮漂移 | UTC 部署时东八区用户提醒错 8 小时；every:1h 实际 >1h |
| 中 | `people.ts:135` + daemon `agent-cost-tracker.ts:219` | daemon 成本记账纯本地 JSON，无上报通道；metrics_samples 无 cost 列；`costUsd: null` 硬编码 | server/Web 侧成本观测完全断链（daemon 本地 `slock cost show` 不受影响） |
| 中 | `agent-duty.ts:13-15`、`metrics.ts:10-12` | presence/在线数基于本实例 `daemonClients` Map，HTTP 读路径未跨实例 | 多实例下 daemon 连在实例 B 时实例 A 系统性显示离线 |
| 中 | `routes/reminders.ts:35` | 人类侧提醒端点 owner 语义与 scheduler 认领（要求 agents.duty）不兼容，且全仓无调用方 | 僵尸端点：一旦调用即创建永不触发的提醒 |
| 中 | `agents.ts:97-99、118-119` | join/leave `WHERE name=$1` 不限定 server_id | 跨租户串频道（另见 P0.4） |
| 中 | `lib/notifications.ts:5` vs 3 处调用点 | `"dm"`/`"reminder"` 通知类型从未被产生 | DM/普通提醒无通知中心通知 |
| 中 | `agents-dispatch.ts:162-297` | dispatch 状态机无 completed 终态、无验收端点；reported 永挂，与看板卡片不同步 | 任务合同无闭环 |
| 中低 | `metrics.ts:51-69` | restoreCounters 仅恢复 5/10 计数器，patrol/machineAuth* 重启清零 | 重启后观测归零、累计有静默缺口 |
| 中低 | `ws/handler.ts:198-219` | runtimes/last_ready_at 仅连接时上报，长连接不刷新 | 装机变化需重连可见；活性语义失真 |
| 中低 | `002_notifications.sql` | notifications 无 TTL 清理、无删除端点 | 通知表无限增长 |
| 低 | scheduler cleanup 未在 shutdown 调用；fired 提醒 snooze 后永不触发（僵尸端点掩盖）；已读不广播多端不同步；notifications 测试无数据时静默 return（假绿风险） | — | 见 §4 P2 |

**后台机制状态**：Reminder 调度（闭环·单实例）/ Patrol 沉默暂停（闭环，tick 无自动化测试）/ 通知链路（部分：DM/reminder 未接线、无清理、多端已读不同步）/ Metrics 计数（闭环·单实例）/ 采样持久化（部分：无 cost 列）/ 成本落库（**缺失**：server 侧无接收端点无表）/ Runtime probe（闭环·连接时点）/ WS 心跳（闭环）/ T8 分诊（闭环）/ duty（闭环）/ Dispatch（部分：离线黑洞 + 无终态 + 取号竞态）/ 任务看板（部分：claim 竞态、无归属校验）。

### 2.6 测试覆盖与代码质量（7.0 / 10）

**优点**

- 集成网广且断言真实：`message-seq-concurrency.test.ts`（20 真并发、响应侧 seq 集合 == 补拉侧、严格升序、同 nonce 恰一个 deduplicated）与 `message-idempotency.test.ts`（重放/跨频道 nonce/无 nonce 兼容/非法 400 四路径）直接验证 advisory lock + 唯一索引语义，是教科书级。
- `security-fixes.test.ts` 全部是回归测试且注释指向具体修复；storage-s3/login-lock/sensitive-files 隔离意识良好（fake client / fake Valkey / tmpdir）。
- Biome 95 文件仅 5 条违规全 FIXABLE；71 处 catch 中 43 空但多带注释、无静默吞错绑定，整体健康。

**覆盖映射（摘要）**

- **覆盖良好**（真实行为断言）：auth、messages（+幂等/并发）、channels（+dm）、agents-reminders（patrol）、profile、people、computers、attachments、audit（哈希链端到端）、notifications、metrics、access-cache、config、cookies、dm、login-lock、manager-triage、runtime-probe、storage(-s3)、tenant、token-hash(+bcrypt)、ws（认证/广播/定向 14 it）、session-check、audit-api。
- **部分覆盖**：tasks（6 it，看板查询类未全）、agents（duty 良好其余少）、agents-dispatch（GET 台账无测）、agents-public（P0.11 已补 PATCH/DELETE 所有权矩阵；成员查询仍无测）、orgs（invites 全套无测）、reminders（人类侧仅 1 次命中）、metrics restore、pubsub（Valkey 真实路径无测）、task-events（间接）。
- **零覆盖（按风险排序）**：① `agents-messages.ts`（327 行 12 端点，agent 侧消息面全盲）；② `preview.ts`（SSRF 面）+ `integrations.ts`；③ `agents-credentials.ts`（凭据生命周期，安全敏感）；④ `lib/reminder-scheduler.ts`（194 行，tick 逻辑仅手动 E2E）；⑤ `lib/rate-limit.ts`（全局 hook 无回归网）；⑥ orgs invites；⑦ actions.ts；~~⑧ `db/migrate.ts`（坏一次全员启动失败）~~（2026-08-31 P0.10 已补 3 用例）。

**测试基建两个脆弱点**

1. **离线不可跑**：黑盒集成测试强依赖「3001 server + PG」，21/32 文件离线全挂；且必须 `NODE_ENV=test` 起 server 否则限流 429（本次实测踩坑，`rate-limit.ts:74`）。建议评估 `app.inject` in-process 模式。
2. **清理不完整**：`cleanupTestData` 缺 `dispatches`/`notifications`/`events`/`attachments`/`invites` 等；agents 删除靠 dispatches.channel_id 间接 CASCADE，挂在种子频道上的 dispatch 会使 afterAll FK 失败。

**类型与风格**：any 约 89 处（最重 `agents-public.ts` 11、`orgs.ts` 10、`ws/handler.ts` 8）；`as` 断言机械重复（agents-reminders/agents-messages 各 17 处，Fastify 路由泛型一处即可消除）；**WS 入站消息 `JSON.parse(raw) as X` 无运行时校验**（纵深防御缺失）；122 个导出函数 31% 无返回类型；`validators.ts` 全文件仅 7 行（只有密码强度，无集中 schema 校验层——无 zod/typebox/fastify-json-schema）。

---

## 3. 三端接口契约核对（7.5 / 10）

**结论**：daemon↔server 的 WS 线协议与 agent REST 面是三端中最扎实的（`WsToDaemonMessage` / `WsFromDaemonMessage` / `WsToBrowserMessage` / `WsFromBrowserMessage` 四方向 union 由 `@collabagent/shared` 真收口，全仓 38 个源文件 import shared：daemon 14 / web 17 / server 7；`presence.ts`/`progress.ts` 组包方与解析方同源）——这是本项目契约质量最佳实践。但 web↔server 有 1 个生产级路径漂移 + 缺失端点；daemon 侧 2 个 CLI 端点打在不存在的路径上；另有一批"注释还在、代码已走"的死亡兼容面。

**一致性面（抽查证据）**：WS 端点/鉴权/4001 关闭语义双侧一致；daemon→server 12 类事件（ready / agent:status / delivery-queued / dead-letter / tool-call / progress / terminal:frame / obs-frame / obs-history / history / workspace:result / pong）与 server 处理点逐一吻合；server→daemon 8 类事件（connected / agent:start 三变体 / agent:stop / agent:duty / agent:deliver（channelId `#name`/`dm:<uuid>` 双侧对齐）/ reminder.fire / terminal:watch 等 / workspace:read）全部吻合；daemon MCP/CLI 的 send/upload/tasks/dispatch/history/receive/search/reminders/profile/credentials 全部一致（参数名逐一核对）。

**drift 清单**

| # | 严重度 | 位置 | 漂移内容 | 后果 |
|---|---|---|---|---|
| 1 | **P0** | web `AppLayout.vue:165` ↔ server `index.ts:259` | web 连 `/ws/chat`，server 是 `/ws`；仅 `vite.config.ts:23` dev 代理重写（另见 P0.3） | 生产 server 静态托管下浏览器 WS 升级 404，实时消息/终端/进度/通知全断，退化为纯 REST |
| 2 | P1 | web `ForgotPasswordPage.vue` ↔ server `auth.ts` | `/api/auth/forgot-password`、`/reset-password` 不存在（CSRF 豁免已预留） | 忘记密码页提交必 404，找回通道不可用 |
| 3 | P1 | daemon `cli/action.ts:18` ↔ server `actions.ts:6` | CLI 打 `/internal/agent/:agentId/prepare-action`，server 只有 `/api/actions/prepare` | agent 侧操作卡片链路 404 |
| 4 | P1 | daemon `cli/integration.ts:11,25` | CLI 打 `/internal/agent/:agentId/integrations(/login)`，server 无 agent 面集成端点 | agent 集成登录 404/401 |
| 5 | P1 | daemon `client.ts:22-63` | 14 条重写规则指向不存在的 `/internal/agent-api/*` surface（仅 managed/self-hosted-runner 模式激活，当前 spawn 链路不触发） | 潜伏地雷：启用 proxy/credential auth 模式时 agent REST 全 404 |
| 6 | P1 | web `wsManager.ts:67,92-98` ↔ server `handler.ts:601-647` | web 看门狗 70s 无 onmessage 即重连；server 心跳是协议层 ping（不触发 onmessage），从无 JSON ping | 空闲时段 ~70s 强制重连，每次触发 backfillAll+flushAllPending → 重连风暴 + 冗余补拉 |
| 7 | P2 | web `taskStore.ts:46` | `moveTask` POST `/api/tasks/${number}/status`，server 只有 `/update-status`；`moveTask` 无调用方 | 死代码埋雷 |
| 8 | P2 | web `channelStore.ts:70-81` | join/leave 传频道名，server `WHERE id=$1` 只认 UUID | 潜伏：UI 接按钮即炸（名字 → uuid cast 500） |
| 9 | P2 | web `wsDispatch.ts:66` | `agent:activity` 死分支（server/daemon 均无人发送） | 误读 |
| 10 | P2 | web `wsDispatch.ts:100` | channelId UUID 匹配 vs server 广播的 `#name`/`dm:<uuid>` 标签 | 正在看的频道也涨未读 |
| 11 | P2 | shared `TaskStatus` 缺 `"closed"`（server/MCP 均有） | web 收到 closed 类型不成立（运行时 as any 兜住） | closed 卡片无类型约束 |
| 12 | P2 | daemon `client.ts:53` | receive 重写到不存在的 `/events` 端点形状 | 同 #5 旧设计残留 |

**shared 包残留**：web `types.ts:95-123` 把 shared 已覆盖的事件重新建模为 `LocalWsEvent`（注释过时、双份维护、已轻微软化）；web 组件大量 `(msg as any)`；web 仍用 deprecated 别名 `WsServerMessage/WsClientMessage`（shared `index.ts:570-579` 注释承诺「web 过渡期后删除」）。

---

## 4. 改进路线图（汇总去重，供 tracker 式勾选推进）

### P0（§1.3 已列 P0.1–P0.11，不再重复）

### P1（本迭代~下迭代）

| # | 行动项 | 位置 |
|---|---|---|
| P1.12 | ~~`machine_tokens` 加默认过期（如 90 天滚动续期）+ 同用户签发数量上限~~ **✅ 2026-08-31 已修**：① 新增 `lib/machine-token-policy.ts` 集中承载策略（TTL 90 天 / HTTP 续期阈值 30 天 / 单用户活跃上限 10 个 / `ACTIVE_TOKEN_PREDICATE` 过期谓词）；② 迁移 `019_machine_token_expiry.sql` 把存量 NULL `expires_at` 统一回填为「迁移时刻 + 90 天」（完整轮换缓冲，不再有永不过期的令牌）；③ 签发点两处——`POST /api/profile/machine-token` 加活跃令牌计数上限（超限 409，吊销/过期即释放额度）+ INSERT 带 90 天 `expires_at`；`POST /api/computers/me/token` 轮换签发同样带 90 天（该端点先吊销全部旧钥，rotation 自限无需 cap）；④ 校验点四处——HTTP/WS sha256 快路径加过期谓词（NULL 豁免存量/手工行），HTTP 剩余 <30 天才写库顺延到 +90 天（阈值门控把写放大压到每令牌最多每 60 天一次，续期失败仅 warn 不影响认证），WS 连接即续期（连接频率低不做阈值，与 HTTP 共同构成「活跃令牌不过期」），legacy bcrypt 全表扫描路径加过期谓词但**不续期**（靠过期压力促成 O8 轮换退役）；⑤ `GET /tokens` 本就返回 `expires_at` 可直接展示。新增 `test/machine-token-expiry.test.ts` 8 用例（签发 90 天、上限 409+吊销释放、过期 HTTP 401 / WS 4001、阈值续期、充裕期不写、WS 连接续期、NULL 豁免）；全量复验 36/36 文件 320 用例绿 | `lib/machine-token-policy.ts`（新）+ `db/migrations/019`（新）+ `profile.ts` + `computers.ts` + `index.ts:136-198` + `ws/handler.ts:150-190` | 消除账号级全权令牌永不过期、可无限签发 |
| P1.13 | ~~统一 IP 策略：Fastify 显式 `trustProxy` 配置 + 仅在确认反代链时采信 XFF；`clientIpOf` 与 `rateLimitHook` 同源~~ **✅ 2026-08-31 已修**：① `lib/config.ts` 新增 `TRUST_PROXY` 配置（默认空 = **不信任任何代理**，fail-closed——req.ip 即 TCP 对端地址，伪造 XFF 无法影响任何 IP 判定；确认真处于反代链后时显式设 `true`/可信代理 IP-CIDR 列表，nginx 同机反代填 `127.0.0.1`；不支持 Express 式跳数——Fastify 语义无此选项且 IP 列表更精确）+ `parseTrustProxy` 纯函数；② `index.ts` Fastify 实例显式传 `trustProxy: config.TRUST_PROXY`，`true` 全信任时启动打 warn（引导收敛到 IP 列表）；③ `clientIpOf` 改为与 `rateLimitHook` 同源——一律取 Fastify `req.ip`（XFF 解析全权交给 trustProxy），删除自行读 `x-forwarded-for` 第一段的旧逻辑（全仓此后仅 trustProxy 一处决定 XFF 采信）；④ 测试：`config.test.ts` 新增 `parseTrustProxy` 3 用例；`login-lock.test.ts` clientIpOf 用例改断言「伪造 XFF 不影响判定 + 截断 64」；`auth.test.ts` 防爆破 describe 注明 XFF 头已惰性（保留头部恰作为伪造 XFF 无效的回归验证，IP 维度阈值语义由 login-lock 高层 API 直测覆盖）；行为级探针：登录带 `X-Forwarded-For: 6.6.6.6, 7.7.7.7` 后 `user_sessions.ip` 记录的是 socket 地址 127.0.0.1 而非伪造值。全量复验 36/36 文件 323 用例绿。**部署注意**：反代部署必须显式设置 `TRUST_PROXY`，否则限流/登录锁定/会话 IP 都按代理 IP 记账（安全但降级） | `lib/config.ts`（TRUST_PROXY + parseTrustProxy）+ `index.ts:48-77` + `lib/login-lock.ts:150-159` | 消除伪造 XFF 绕过 IP 维度登录锁定；反代下限流不再全员共享一桶（需配 TRUST_PROXY） |
| P1.14 | ~~bcrypt 兼容路径加全局并发/速率护栏，或按退役文档加速轮换~~ **✅ 2026-08-31 已修**：① 新增 `lib/machine-token-guard.ts` 进程级护栏（HTTP/WS 共用单例）——per-IP 固定窗口速率（默认 20/min，进入路径的尝试均消耗预算）+ 全局并发信号量（默认并发 2、有界队列 16、排队超时 3s 即拒绝），合法存量令牌的重连/请求远低于预算；护栏内部故障 fail-open（与 login-lock/rate-limit 一致，全局限流 hook 仍兜底）；进程内实现与 metrics 计数器同口径（多实例各算各的预算）。② 接入两端——HTTP `authenticate` 超限 → 429；WS `resolveUserId` 超限 → anon → 4001 关闭；扫描循环 try/finally 保证 release；`clientIp` 侧 WS 取 `req.ip ?? socket.remoteAddress`（与 HTTP request.ip 同源，P1.13 语义）。③ 观测：新增 `machineAuthBcryptRejected` 计数器 + reject warn 日志（持续增长 = 假令牌探测流量）。④ 退役加速：legacy 全表扫描查询加 SQL 侧 `BCRYPT_TOKEN_PREDICATE` 预过滤（`token_hash LIKE '$2…$%'`，与 08-bcrypt-token-retirement.md 审计 SQL 同口径）——存量轮换完后该查询稳定 0 行，兼容路径退化为一次廉价查询（JS 侧 `isBcryptHash` 保留作纵深防御）；叠加 P1.12 的 019 迁移 90 天过期回填，存量令牌轮换死线 ~2026-11-29。⑤ 新增 `test/machine-token-guard.test.ts` 8 用例（离线 7：per-IP 预算/窗口重置/IP key 空值与 64 截断/并发打满排队超时 busy/排队交接/队列满立即拒/release 幂等+默认常量口径；在线 1：未知假令牌经护栏放行后 401 + 新计数器接线）。行为级探针：127.0.0.1 连发 25 个假 `sk_machine_` token 恰 **20×401 + 5×429**（per-IP 预算熔断），reject warn 日志 5 条对应；全量复验 37/37 文件 331 用例绿 | `lib/machine-token-guard.ts`（新）+ `lib/metrics.ts` + `lib/machine-token-policy.ts`（BCRYPT_TOKEN_PREDICATE）+ `index.ts` + `ws/handler.ts` | 消除「无效 token 稳定触发 O(N×12) CPU」的 DoS 放大面 |
| P1.15 | ~~抽 `lib/auth-token.ts` 收敛机器令牌校验（HTTP/WS 共用）；WS 侧 JWT 补 session 回查并与 `@fastify/jwt` 同源，消灭 `jsonwebtoken` 直用~~ **✅ 2026-08-31 已修**：① 新增 `lib/auth-token.ts`——`verifyMachineToken`（sha256 快路径 + P1.12 滚动续期 `renewal:"threshold"`(HTTP)/`"always"`(WS) 双模式 + bcrypt 兼容路径 + P1.14 护栏 + O8 退役指引，HTTP/WS 共用单一实现）与 `verifyBrowserToken`（浏览器 access token 统一走 @fastify/jwt access namespace 验签 + **新增强制 sid（无 sid 存量 token 直接拒绝，fail-closed）+ 会话回查**，与 HTTP 同源）；② `@fastify/jwt` 双 namespace 注册（`access`/`refresh` 各自独立 secret；`types/fastify.d.ts` 声明 `FastifyJWT.namespaces`，`app.jwt.access/refresh` 取代 jsonwebtoken 直签/直验）；③ WS 侧删除 jsonwebtoken 直验，`resolveUserId` 浏览器分支改走 `verifyBrowserToken(req.server.jwt.access, wsPg, token)`（logout-all 后 WS 重连即 4001）；④ `session-check.ts` `isSessionValid` 首参从 FastifyInstance 放宽为最小 pg 形状（WS 的 wsPg 可复用）；⑤ 删除 `jsonwebtoken` + `@types/jsonwebtoken` 依赖（lockfile 同步）。新增 `test/auth-token.test.ts` 13 离线用例（快路径/续期双模式/用户缺失/护栏拒绝不触达兼容路径/legacy 命中 warn+release 配对/浏览器强制 sid/会话吊销 fail-closed）+ `ws.test.ts` 1 在线回归（logout-all 吊销后 WS 握手 4001）；全量复验 38/38 文件 345 用例绿。**行为变更提示**：无 sid 的存量浏览器 token 将被拒绝（需重新登录）——评估 §5.2 #3 的存量核查项就此按 fail-closed 定稿 | `lib/auth-token.ts`（新）+ `index.ts` + `ws/handler.ts` + `routes/auth.ts` + `lib/session-check.ts` + `types/fastify.d.ts` + `package.json` | 消灭校验逻辑双份漂移 + WS 会话吊销盲区 + 双 JWT 库并存 |
| P1.16 | ~~登录/注册/注销错误统一 401 通用文案 + 用户不存在路径插入假 bcrypt 平衡时序；修 `/refresh` cookie 兜底死码并强制 sid 必须存在~~ **✅ 2026-08-31 已修**：① 登录失败形态统一——「用户不存在」与「密码错误」同返回 401 `{error:"用户名或密码错误"}`，前者先做一次常量假 bcrypt 比对（cost 12 恒失败哈希）平衡 KDF 时序，消除「跳过 bcrypt」的响应时序差（账号存在性探测面）；② 注销账号 403 挪到密码校验之后——原先任意密码即可探测「存在且已注销」，现需正确密码才暴露注销状态；③ `/refresh` cookie 兜底死码删除（原先读 access cookie 顶替后仍按 REFRESH_SECRET 验签、恒 401 误导维护者），仅接受 `body.refreshToken`，缺参 400；④ refresh 无 sid 一律拒绝（`throw`→401）——本服务签发的 refresh 均带 sid，封掉「无 sid 绕过会话吊销检查」的理论缺口；⑤ **「注册」范围的取舍立此存照**：register 的 400 输入校验与 409 重名提示保留（邀请/重名场景的功能性需要，且属公开接口有限枚举面、受全局限流缓解），注册侧加固（email 格式校验 + 23505→409）归 P1.31，不在本项重复处理。新增 auth.test.ts 4 用例（统一文案不可区分、注销账号错误密码 401/正确密码才 403、refresh 缺参 400、refresh 轮换闭环含「access 不可当 refresh 用」跨 secret 拒绝）；行为探针：ghost（不存在）0.685~0.760s ≈ wrong（密码错）0.713~0.804s，时序平衡生效；全量复验 38/38 文件 349 用例绿 | `routes/auth.ts` | 消除登录枚举/时序探测面 + refresh 死码与吊销缺口 |
| P1.17 | ~~cookie 按环境设 `Secure`（应用层判断）；生产关 `/docs`；dev-token 改显式 `SLOCK_DEV_TOKEN=1` 开关~~ **✅ 2026-08-31 已修**：① Cookie Secure 应用层判定——`lib/config.ts` 新增 `parseCookieSecure`（`"1"/"true"/"yes"/"on"` 显式开、`"0"/"false"/"no"/"off"` 显式关、缺省 `"auto"` = NODE_ENV=production 开启）+ `config.COOKIE_SECURE`；`lib/cookies.ts` `setAuthCookies/clearAuthCookies` 按判定追加 `Secure`（清除与下发同属性）。此前「永不设 Secure、依赖反代改写」——部署疏漏即凭据明文传输；本地 http 开发不受影响，反代部署若 TLS 终止在代理层需确认链路为 https 或显式 `COOKIE_SECURE=0`（注意语义风险）。② 生产不注册 swagger（`/docs` 404，不再泄露 `/internal/agent/*` 路由结构；本地保留）。③ dev-token 改 `SLOCK_DEV_TOKEN=1` 显式开关（默认关，任何环境）——此前仅靠 NODE_ENV 挡生产，dev server 暴露到网络即无凭据后门；`collectInsecureConfig` 新增标记项，生产（无 ALLOW_INSECURE_DEV_SECRETS）启动即 exit(1)；`scripts/smoke-agent.mjs` 注释同步（须 `SLOCK_DEV_TOKEN=1` 起 server）。新增 config.test.ts 5 用例；行为探针：生产 `/docs` 404 ✅、生产 Set-Cookie 双 cookie 均含 `Secure` ✅、dev-token 默认 401 ✅、生产+SLOCK_DEV_TOKEN=1（无豁免）启动被拒（唯一标记项即 SLOCK_DEV_TOKEN）✅、dev+开关 dev-token 200 ✅；全量复验 38/38 文件 354 用例绿 | `lib/config.ts`（parseCookieSecure + COOKIE_SECURE + collectInsecureConfig）+ `lib/cookies.ts` + `index.ts` + `test/config.test.ts` + `scripts/smoke-agent.mjs` | 消除凭据明文传输面 + /docs 信息泄露 + dev-token 误开面 |
| P1.18 | 处置 drizzle 死链：移除 `drizzle-orm`+`drizzle-pg.ts`+`schema.ts`（413 行），或真正迁移——不要停在中间态 | `db/` |
| P1.19 | 删除/补齐 docker-compose 的 `schema.sql` 幽灵挂载 | `docker-compose.yml:28` |
| P1.20 | 契约缺失端点补齐或砍掉：forgot/reset-password；`prepare-action`、`integrations` agent 面（或改 CLI 指向）；删 `/internal/agent-api` 重写面 | 见 §3 drift #2/3/4/5 |
| P1.21 | server 每 30s 加一条 JSON `{type:"ping"}` 广播（或 web 拉长 watchdog），消除 70s 重连风暴 | `handler.ts:601-647` ↔ web `wsManager.ts` |
| P1.22 | WS 收敛：`handleEnvelope` daemon 全发改按频道 agent 成员定向；deliver 查 `bufferedAmount` 做背压；pubsub 按事件类型/userId 分频道 | `ws/handler.ts:533-558`、`pubsub.ts` |
| P1.23 | 提醒可靠性：认领前校验 owner daemon 在线（或两阶段 claimed→delivered）；`daily@HH:MM` 存 IANA 时区；重排以原 fire_at 为基准消漂移 | `reminder-scheduler.ts:76-137`、`lib/reminders.ts` |
| P1.24 | 打通 daemon→server 成本上报（WS 或 internal REST 上报 `(agent, channel, utcDay, usd)`，与 `createSessionCostDelta` 差值语义对齐），`people.ts:135` 接真数据 | server 建表 + daemon 上报 |
| P1.25 | 通知补齐：DM 产生 `dm` 通知；notifications 过期清理 job（挂 metrics-persist tick）；已读广播 `notification.read` | `lib/notifications.ts`、`routes/messages.ts` |
| P1.26 | dispatch 增加 `completed` 终态 + 经理验收端点，看板卡片与 dispatches 双向同步；daemon 离线时产生 server 侧可见告警（对齐 dead-letter） | `agents-dispatch.ts` |
| P1.27 | presence/metrics 读路径跨实例化（Redis 在线集合替代本地 Map；metrics_samples 加实例标识列，restoreCounters 全量恢复） | `agent-duty.ts`、`metrics*.ts` |
| P1.28 | 补测试盲区：agents-messages（含 requireOwnAgent 越权 403 矩阵）、agents-credentials（签发→使用→吊销生命周期）、preview/integrations、rate-limit、scheduler（假时钟）；WS 入站消息加 zod 运行时校验 | `test/` |
| P1.29 | preview 的 fetch 改 `redirect:"manual"` 逐跳复查 + 最终 IP 内网段校验 | `preview.ts:53-64` |
| P1.30 | `/api/metrics(/history)` 加 admin（org owner）门禁 | `metrics.ts:4-37` |
| P1.31 | invite 消费改条件更新 `WHERE uses < max_uses` 并入注册事务；注册 email 格式校验 + 23505 捕获映射 409 | `auth.ts:52-89` |
| P1.32 | 频道 type 枚举校验 + 重名检查改 `lower(name)` 口径 + 冲突 409；join 的 memberType 服务端定死 'human' | `channels.ts:39-146` |
| P1.33 | `/send` 校验 threadId 存在且同频道；content 加长度上限；编辑/删除消息补 `canAccessChannel`；tasks unclaim/update-status 补 assignee/manage 校验 | `messages.ts`、`tasks.ts` |

### P2（卫生/债务，批量处理）

1. 统一错误形状：消灭 200+`{error}`（`profile.ts:17`、`integrations.ts:12`）；错误响应加稳定 `code` 字段；统一分页协议（hasMore 统一 lim+1 探测）；统一中英文文案。
2. 路由入口统一 uuid 预校验（复用 `tenant.ts:21` 的 `UUID_RE`），notifications/orgs 参数补预检。
3. `ws/handler.ts` 日志换 pino（child logger 绑 userId）；`pino-pretty` 配 dev transport 或移除；`access.ts`/`rate-limit.ts` 的 `setInterval` 加 `.unref()`。
4. swagger：高频路由补 request/response schema + securitySchemes；生产 env 开关关 `/docs`。
5. 清理冗余/死索引（machine_tokens_hash、idx_reminders_due、jieba 死索引）；`task_events` 补 `(channel_id, task_number)` 索引。
6. 播种逻辑二选一（`index.ts:320-328` 改调 `db/seed.ts`）；seed.ts 硬编码密码与 ON CONFLICT 口径修正。
7. 删 `agents.ts:5-7` 死 import；开 `noUnusedLocals`；`parseRuntimeProfile`/`iso` 收敛进 shared/lib；`npx biome check --write` 清 5 条违规。
8. agent 搜索改用 `content_tsv` 生成列 + GIN（对齐人类侧）；附件 ACL 去掉 LIMIT 5 改 EXISTS。
9. web 死代码清理：`taskStore.moveTask/updateStatus`、`channelStore.joinChannel/leaveChannel`、`wsDispatch` 的 `agent:activity`；修 `wsDispatch.ts:100` 的 channel 匹配（正在看的频道涨未读）。
10. shared 收尾：`TaskStatus` 加 `"closed"`；删 web `types.ts` 重复事件建模与 `WsServerMessage/WsClientMessage` 别名；立纪律「WS 事件名与 REST 路径改动必须先改 shared 再动两侧实现」。
11. 为 16 个逻辑型导出函数补返回类型；`reminderToDto(r: any)` 换行类型；评估 in-process `app.inject` 测试模式。
12. session-check 缓存补过期清扫；`session-check`/`rate-limit` 的 Valkey 版本 ≥7.0 确认与 pexpire 结果自愈。
13. 审计链按 `(server_id, day)` 分链；`broadcastOwnerPresence` N+1 改 JOIN。
14. 清理 `/api/reminders` 僵尸端点（或为人类提醒开独立认领分支）；runtime-probe 未知 status 保留原值；ready 消息支持周期重报。

---

## 5. 附录

### 5.1 验证基线（2026-08-28 本机实测）

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit`（packages/server） | ✅ 零错误 |
| server 启动 | ✅ `npx tsx src/index.ts`（.env + 本地 PG），`/api/health` = `{status:"ok", db:true}` |
| `npx vitest run`（普通模式 server） | 146 过 / 20 败 / 117 跳过——败因全部为 register 触发 429 限流（环境问题，非代码缺陷） |
| `npx vitest run`（`NODE_ENV=test` server，正确姿势） | ✅ **32/32 文件、283/283 用例通过**（约 83s）。注：首轮曾出现 1 例一次性失败（`validatePatrolRepeat` 纯函数断言，lib.test.ts），复跑两轮均绿，判定为 flaky 测试基建，建议后续关注 |
| Biome | 95 文件 5 条违规 0 error，全 FIXABLE |
| 测试用例总数 | 289 `it()`（11 个纯单元文件可离线跑） |

**测试流程要点（写给后续迭代）**：

```
cd packages/server
NODE_ENV=test npx tsx src/index.ts > server.log 2>&1 &   # 必须带 NODE_ENV=test，跳过限流
DATABASE_URL='postgresql://<user>:<pass>@localhost:5432/collabagent' npx vitest run
```

注意：`.env` 的 DATABASE_URL 密码与 `test/helpers.ts` 回退值不一致，跑测试时显式传 `DATABASE_URL`。

### 5.2 待确认清单（运行时核实项）

1. 部署形态：是否反代部署（决定 XFF/trustProxy/Secure 的修法优先级）；当前生产是否仍走 vite 独立静态服务（drift #1 未爆的可能原因）。~~XFF/trustProxy 修法待定~~——2026-08-31 P1.13 已落地 fail-closed 机制（默认不采信 XFF，`TRUST_PROXY` 显式声明反代链），**若实际部署在反代后需配置该 env**，否则限流/登录锁定/会话 IP 按代理 IP 记账（安全但降级）。
2. `forgot/reset` 路由是否曾存在后删除（CSRF 豁免名单引用了它们）。
3. ~~线上是否存在无 sid/tv 的存量 JWT（决定旧 token 下线日期）~~——2026-08-31 P1.15 已按 fail-closed 定稿：无 sid 的浏览器 token 直接拒绝（HTTP 401 / WS 4001），持旧 token 用户需重新登录，不再依赖存量核查。
4. Valkey/Redis 服务端版本是否 ≥7.0（PEXPIRE NX）。
5. drift #6 的实际体感：长期空闲是否已出现 ~70s 周期的 reconnect 日志。
6. ~~`GET /server` 列私有频道是否有意（工作区总览页语义？）~~——2026-08-31 P0.9 已定稿：非有意，按「对齐 `GET /` 谓词、非成员不可枚举」修复。
7. `agents-messages.ts:161-164` receive 首次置 `MAX(seq)` 是否有意（"只收新消息"）。
8. 任务 unclaim/update-status 无归属校验是否有意（协作式看板 vs 需要保护）。

### 5.3 评估方法说明

- 7 名子 agent 按维度并行精读（read-only），输出结构化发现；主编综合去重、定级、定优先级。
- 严重度分级：高（实质安全/正确性缺口）/ 中高 / 中 / 中低 / 低（卫生债务）。
- 改进项编号沿用 daemon 评估报告惯例：P0.n（尽快修）、P1.n（本迭代）、P2（择期）。本文档可作为 `docs/2026-08-20/02-daemon-evolution-tracker.md` 同款执行跟踪的 server 侧依据。