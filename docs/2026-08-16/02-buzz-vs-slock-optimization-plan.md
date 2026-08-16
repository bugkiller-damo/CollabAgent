# Slock (collabagent) 对标 Buzz 全方位优化方案

> 日期：2026-08-16
> 分支：`feature/web-vue3`
> 对比基线：`block/buzz`（main @ `d8281b9c9`，31 个 Rust crates + 桌面/Web/移动三端）
> 被审视对象：`D:\code\slock`（Fastify 5 + Drizzle/Postgres 16 + Valkey + React/Vue3 + daemon）
> 结论定位：slock 代码质量与工程纪律在同规模项目里属中上，差距不在"写得对不对"，而在**架构少了几根大梁**（事件日志/审计、pub/sub 扇出、多租户边界、对象存储抽象、可扩展部署）。本文按"止血 → 提质 → 精进"给出 20 项可落地优化点。

---

## 0. 执行摘要

- **一句话**：把"AI 协作平台"升级为"可被 agent 理解、复盘、审计的事件系统"，同时补齐可扩展性与安全硬约束。
- **Top 5 高优先**：① Redis pub/sub 扇出；② 事件日志/审计；③ 配置硬校验；④ CI 分层（daemon/web/lint 全没跑）；⑤ 依赖审计。
- **已由本项目自审文档覆盖的部分**（`docs/2026-07-14/` 的 scorecard/roadmap/sprint 报告）：CORS 白名单、`as any` 清理、hasMore 修复、错误格式统一、上传白名单、CSRF 轮换、优雅关闭——本文不重复，只聚焦 Buzz 独有视角 + 尚未解决的缺口。

### 优先级总表

| # | 优化点 | 优先级 | 涉及面 |
|---|---|---|---|
| O1 | Redis pub/sub 扇出（跨实例广播） | 🔴 高 | server |
| O2 | 事件日志 / 审计（事件流水线） | 🔴 高 | server |
| O5 | 配置危险默认值硬校验 | 🔴 高 | server |
| O17 | CI 分层（daemon/web/lint 未跑） | 🔴 高 | 工程化 |
| O18 | 依赖安全审计 | 🔴 高 | 工程化 |
| O3 | 多租户边界（URL 即社区） | 🟡 中 | server |
| O4 | 对象存储抽象 | 🟡 中 | server |
| O6 | 登录防爆破去内存化 | 🟡 中 | server |
| O7 | 权限缓存一致性 | 🟡 中 | server |
| O8 | WS 认证 bcrypt 兼容分支退役 | 🟡 中 | server |
| O10 | daemon 生产启动路径 | 🟡 中 | daemon |
| O11 | MCP 凭据传递安全 | 🟡 中 | daemon |
| O12 | claude driver 权限收敛 | 🟡 中 | daemon |
| O14 | Vue3 迁移收尾（Phase G） | 🟡 中 | 前端 |
| O15 | 前端离线增量同步 | 🟡 中 | 前端 |
| O19 | 生产部署形态 | 🟡 中 | 部署 |
| O9 | messages.seq 竞态确认 | 🟢 低 | server |
| O13 | daemon 代码面收敛 | 🟢 低 | daemon |
| O16 | 前端 WS 层收敛 | 🟢 低 | 前端 |
| O20 | 仓库卫生 | 🟢 低 | 卫生 |

---

## 1. 定位与成熟度对比

| 维度 | Buzz | Slock (collabagent) |
|---|---|---|
| 定位 | 自托管 Nostr 协作工作区，人与 agent 平等协作 | AI 原生团队协作平台，agent 是队友不是工具 |
| 唯一事实源 | Nostr 事件日志（消息/补丁/审批/workflow/git 同一形状） | 关系型表快照（messages/users/tasks 各自表） |
| 后端 | Rust，31 crates，Axum + Postgres + Redis + S3/MinIO | Node/TS，Fastify 5 + Drizzle + Postgres 16 + Valkey |
| 客户端 | 桌面(Tauri)+Web+Mobile+CLI+agent 全家桶 | React web（迁移 Vue3 中）+ daemon |
| 认证 | NIP-42/NIP-98 签名 + 身份模型 | JWT + Cookie + machine token + dev-token |
| 可扩展 | Redis pub/sub 扇出 + 多实例 | 单进程内存 Map（WS 连接态） |
| CI | 19 个 workflow（分层 E2E/跨平台/canary/安全） | 1 个 workflow（仅 server tests） |
| 发布 | 不可变候选 + 自动 tag + 签名 | 无正式发布流程 |

---

## 2. 后端 server 优化点

### O1【🔴 高】Redis pub/sub 扇出——WS 广播目前是单进程内存态

- **位置**：`packages/server/src/ws/handler.ts`（模块级 `browserClients` / `daemonClients` / `terminalWatchers` 三个 `Map`）；`routes/messages.ts` 等直接 `broadcast(...)`。
- **现状/问题**：Valkey 只用于限流（`lib/rate-limit.ts`），**消息广播完全不经过 Valkey**。后果：① 多实例/多进程部署时广播互相看不见；② 进程重启即丢全部连接态；③ 与"按频道成员定向投递"的注释意图不一致（内存态无法跨实例定向）。
- **Buzz 对照**：`buzz-pubsub` crate 专门做 Redis pub/sub 扇出、presence、typing 指示；relay 与 pubsub 解耦，水平扩容自然成立。
- **建议**：
  1. 消息落库后 `PUBLISH` 到 channel（`channel:{id}` / `user:{id}`），每个 WS 实例 `SUBSCRIBE` 后转发给本地 socket；
  2. presence（`isOnline`/`lastSeenSeq`）改走 Valkey（`SETEX` 心跳 + `GET` 查询），删除 `daemonMeta` 内存态；
  3. `terminalWatchers` 的引用计数语义保留，但把"谁在哪个实例看"的登记放到共享存储，跨实例时通知到正确 daemon。
- **验收**：两个 server 实例 + 一个 Valkey，实例 A 发的消息能被连到实例 B 的浏览器实时收到；kill A 后 B 仍正常广播。

### O2【🔴 高】事件日志 / 审计——当前只有状态快照，无留痕

- **位置**：`packages/server/src/db/schema.ts`（`messages` 有 `seq` + `idx_messages_channel_seq`，但无统一事件表）；`routes/messages.ts`（编辑/删除只改当前行）。
- **现状/问题**：无"谁在什么时间做了什么"的不可变流水。编辑无历史（Sprint 6 加了 `message_edits` 是点状补丁）、任务流转无审计、频道删除/成员变更无记录。对"AI agent 复盘/审计"这一核心卖点是硬缺口。
- **Buzz 对照**：`buzz-core`（StoredEvent 统一事件形状）+ `buzz-audit`（哈希链审计日志），所有动作是同一形状的签名事件，可追溯可验证。
- **建议**：
  1. 新增 `events` 表：`id / actor_id / actor_type / verb / object_type / object_id / payload(jsonb) / prev_hash / hash / created_at`，`prev_hash` 连成哈希链（SHA-256）；
  2. 消息发送/编辑/删除、任务创建/指派/状态变更、频道成员增删、审批动作统一走"写入业务表 + 追加 event"事务；
  3. 暴露 `GET /api/audit?object_type=&object_id=` 供前端与 agent 查询；
  4. 保留 `message_edits` 作为可读视图，但底层数据源统一为 events。
- **验收**：一次"发送→编辑→删除"产生 3 条事件且哈希链可校验；`GET /api/audit` 可追溯全程。

### O5【🔴 高】配置危险默认值——漏配 env 时静默使用已知密钥

- **位置**：`packages/server/src/lib/config.ts`：`JWT_SECRET` 默认 `"dev-secret-change-in-production"`、`REFRESH_SECRET` 默认 `"dev-refresh-secret"`、`DATABASE_URL` 默认含明文 `P@ssw0rd`。
- **现状/问题**：`validateConfig()` 只是 `console.warn`，生产漏配时用公开常量密钥，JWT 可被伪造。
- **Buzz 对照**：Buzz 启动对配置做校验，缺关键项即失败（`.env.example` 模板 + 显式校验）。
- **建议**：
  1. `validateConfig()` 改为硬校验：当 `NODE_ENV === 'production'` 且命中默认值时 `process.exit(1)`（错误信息指明缺失变量）；
  2. `DATABASE_URL` 移除默认明文密码，缺失直接失败；
  3. 加一个 `ALLOW_INSECURE_DEV_SECRETS=1` 显式开关仅供本地开发。
- **验收**：生产环境无 env 启动直接退出并报错，不启动服务。

### O3【🟡 中】多租户边界——`getDefaultServerId()` 是单租户事实

- **位置**：`packages/server/src/lib/server.ts`（`getDefaultServerId` 缓存 60s 返回"默认 server"）。
- **现状/问题**：`schema.ts` 已有 `servers` + `server_members`，但多数路由隐式落到"默认 server"，URL/host 不决定租户，无法支撑多社区托管。
- **Buzz 对照**：Buzz 的核心约定是"URL 即社区"，租户边界由 relay URL 决定，所有状态社区内自洽。
- **建议**：
  1. 引入请求级租户解析（从 host/子域或显式 `X-Server-Id` header 解析 `serverId`），替代全局默认 server；
  2. `messages` 表已冗余 `server_id`，把 RBAC 断言从 channel 级提升到 server 级；
  3. 短期可先保留 `getDefaultServerId` 作为单租户部署的降级，但所有路由显式取 serverId 而非隐式默认。
- **验收**：两个 host 各自解析到不同 server 数据，互不串号。

### O4【🟡 中】对象存储抽象——媒体目前落本地 `uploads/`

- **位置**：`packages/server/src/lib/storage.ts`（`UPLOAD_DIR`）；`schema.ts` 的 `attachments.storage_key/storage_url`。
- **现状/问题**：文件落本地磁盘，无抽象层；多实例、备份、迁移、缩略图均受限（已有 `ALLOWED_MIME_TYPES` 白名单，但缺存储后端可插拔）。
- **Buzz 对照**：`buzz-media` 抽象 Blossom/S3 媒体存储，含校验与缩略图管线，与对象存储解耦。
- **建议**：
  1. 定义 `Storage` 接口（`put/get/delete/url`），提供 `LocalStorage`（现状）与 `S3Storage`（MinIO/S3）两个实现，按 `STORAGE_BACKEND` 选择；
  2. `storage_key` 生成统一走 `uuid/checksum`，MIME 校验 + 每文件大小上限（`MAX_UPLOAD_SIZE` 已存在，独立 per-file 校验）；
  3. 图片缩略图管线（sharp）作为可选项。
- **验收**：切换 `STORAGE_BACKEND=minio` 后上传/下载/删除全链路可用，路由代码零改动。

### O6【🟡 中】登录防爆破锁在单进程内存 Map

- **位置**：`packages/server/src/routes/auth.ts`（`loginAttempts` Map + `checkLoginLock`/`recordLoginFail`）。
- **现状/问题**：重启清零、多实例不共享；且只有 per-IP 维度，无 per-account 维度（换 IP 撞同一账号密码不受限）。
- **Buzz 对照**：Buzz 认证限流在 `buzz-auth` 统一处理，走共享存储。
- **建议**：并入已有 `rate-limit.ts` 后端（Valkey `INCR + EXPIRE`），采用 `login:{account}` + `login:{ip}` 双 key；删除内存 Map。
- **验收**：两实例共享登录锁定状态；同账号 5 次失败后 15 分钟锁定，换 IP 仍锁定。

### O7【🟡 中】权限缓存一致性——2s TTL 全局 Map，多实例行为不可预测

- **位置**：`packages/server/src/lib/access.ts`（`cached()` Map + 10s 清理，TTL=2000ms）。
- **现状/问题**：单实例可接受，但多实例各自缓存不同步；撤销成员/改频道类型后最长 2s 旧权限仍生效。
- **Buzz 对照**：Buzz 授权按身份断言，per-request 校验，不依赖易失效的全局缓存。
- **建议**：
  1. 若接受 2s 窗口，把 TTL/清理周期提升为常量并注释清楚语义；
  2. 多实例化时改用 Valkey 缓存 + 变更时主动失效；
  3. 至少补单测覆盖"改类型后权限变更"的时序。
- **验收**：明确记录 TTL 语义 + 单测；或迁移 Valkey 后多实例一致。

### O8【🟡 中】WS 认证的 bcrypt 全表扫描兼容分支需退役计划

- **位置**：`packages/server/src/ws/handler.ts`（`resolveUserId` 快路径 sha256 索引命中，兼容路径 `SELECT ... WHERE revoked_at IS NULL` 后逐行 `bcrypt.compare`）。
- **现状/问题**：设计正确（`lib/token-hash.ts` 快路径优雅），但兼容分支 O(N×100ms) 是隐患，且无退役时间表。
- **Buzz 对照**：Buzz 认证无历史包袱，纯索引命中。
- **建议**：
  1. 给兼容分支加命中率统计日志；
  2. 在文档标注"旧 bcrypt token 全部轮换/吊销后可删除"的判定条件与检查 SQL；
  3. 提供一个 `scripts/audit-bcrypt-tokens` 迁移脚本统计剩余旧 token。
- **验收**：日志可观测命中率；文档含退役判定标准。

### O9【🟢 低】`messages.seq` 生成需确认无并发竞态

- **位置**：`packages/server/src/db/schema.ts`（`seq` 字段 + 索引）；`routes/messages.ts`（未见 seq 生成逻辑，疑似 DB 序列/触发器）。
- **现状/问题**：seq 是事件排序的命根子，若并发发送非原子生成会乱序/冲突。
- **建议**：确认 seq 为原子生成（序列 / `SELECT ... FOR UPDATE` / `INSERT ... RETURNING`）；补一条并发发送集成测试（同 channel 并发 N 条，seq 严格递增且无重复）。
- **验收**：并发测试通过，seq 无空洞冲突（空洞可接受，重复/乱序不可接受）。

---

## 3. daemon / Agent 运行时优化点

### O10【🟡 中】supervisor 用 `shell: true` + `npx tsx` 拉起，生产路径缺失

- **位置**：`packages/server/../daemon/src/supervisor.ts`（`spawn(cmd, { shell: true })`，cmd=`npx tsx src/index.ts`）。
- **现状/问题**：`shell:true` 引入注入面与平台差异（代码已用 `taskkill /T` 补 Windows 孤儿进程，说明已踩坑）；生产应跑编译产物。
- **Buzz 对照**：Buzz 的 agent 面二进制（buzz-agent/sprig）编译后直接 spawn，无 shell 包装。
- **建议**：区分 dev/prod：dev 保留 `tsx`，prod 直接 `spawn('node', ['dist/index.js'])`（无 shell）；`killTree` 逻辑（写得很扎实）保留。
- **验收**：`pnpm build` 后 prod 模式可启动/停止，无 cmd 包装层；Windows 下无孤儿 node 进程。

### O11【🟡 中】MCP server 的 agent 凭据经环境变量注入子进程

- **位置**：`packages/daemon/src/mcp/slock-mcp-server.ts`（读 `SLOCK_AGENT_TOKEN`，由 daemon spawn 时注入 env）。
- **现状/问题**：token 出现在子进程 env（`/proc`/任务管理器可读、可能进 core dump）。
- **Buzz 对照**：Buzz 愿景 REMOTE_AGENTS（"部署后不留控制通道"）与 buzz-acp 的短时凭据/身份模型。
- **建议**：确认 `agent-runtime-credentials.ts` 的 `sk_agent_` 短时 scoped token 轮换是否已落地；落地后启动完立即清除 env 变量；或改 stdio 握手传递首包凭据。
- **验收**：子进程启动后 `/proc/<pid>/environ` 无明文 token；token 到期自动轮换。

### O12【🟡 中】claude driver 每轮 `execFile` + `--dangerously-skip-permissions`

- **位置**：`packages/daemon/src/drivers/claude.ts`（`query()` 每轮 `execFile`，`--dangerously-skip-permissions`，`timeout: 120000`）。
- **现状/问题**：跳过权限检查的不可审计 + 每轮新进程昂贵；`persistent-claude.ts` 应已做会话复用（`--resume`），需确认是否为主路径。
- **Buzz 对照**：buzz-agent 是"tool-calls-as-output + 可审计"，buzz-dev-mcp 只暴露 shell+文件编辑的最小工具面。
- **建议**：把 skip-permissions 改为最小权限工具集（对照 buzz-dev-mcp）；确认 `persistent-claude` 为主路径并收敛单轮 `claude.ts` 为降级。
- **验收**：agent 权限收敛到白名单工具，无 `--dangerously-skip-permissions` 主路径调用。

### O13【🟢 低】daemon 代码面收敛——PTY 时序补偿应逐步迁到 MCP

- **位置**：`packages/daemon/src/`（`agent-runtime-*` 拆 10+ 文件，`post-start-input-writer`/bracketed paste 等时序补偿）。
- **现状/问题**：大量 PTY 时序 workaround 是"防一手"补丁，MCP server 注释已自认这是 4/12 bug 根源。
- **Buzz 对照**：Buzz 用结构化 ACP/MCP 工具调用绕开 PTY 键盘模拟链路。
- **建议**：继续把高频操作迁到 MCP（方向已正确），PTY 时序补偿只作降级路径；给每个 workaround 补"何时可删"注释。
- **验收**：MCP 工具覆盖高频操作，PTY 键盘模拟路径逐步缩小。

---

## 4. 前端优化点

### O14【🟡 中】Vue3 迁移已基本完成，聚焦 Phase G 收尾 + 双栈并存债务

> ⚠️ 修正：本文早前探查误判 `web-vue` 仍为脚手架；实际 Phase A–F 已全部提交（98 文件，19/19 页面，见 `01-vue3-migration-plan.md` 与 commit `e59b48e`…`c0c2240`）。

- **现状**：`packages/web`（React）与 `packages/web-vue`（Vue3）双栈并存，迁移主体已完成但**旧包未下线**。
- **剩余债务（Phase G）**：
  1. server 静态目录切换（`@fastify/static` 指向 web-vue 的 dist）；
  2. 旧 `packages/web` 下线（确认无引用后删除，避免两套 UI 长期并存）；
  3. `web-vue` 改名 `web`（或保留，但统一文档措辞）；
  4. 竞赛材料措辞更新（`presentation-plan.md`、`gen-pptx.js` 中仍写 "React 19 前端"）。
- **建议**：设硬 deadline 完成 Phase G，避免"迁移 99% 但永远并存"的经典债务；`shared` 包（协议类型唯一来源）优先在删除旧包前固化。
- **验收**：仅保留一个前端包，`pnpm build` 单产出；文档技术栈措辞一致。

### O15【🟡 中】前端离线/同步模型——目前仅 localStorage 缓存，无断线补拉

- **位置**：`packages/web/src/stores/messageStore.ts`（`loadCache`/`saveCache`，`msgs_` 前缀，限 50 条）。
- **现状/问题**：WS 重连后无"断线期间消息补拉"，只有静态缓存；无乐观发送队列（pending 态已有 `PendingRow` 但需确认失败重投）。
- **Buzz 对照**：Buzz desktop 的 `event_sync`/backfill + 乐观更新 + 离线同步。
- **建议**：重连后按 `lastSeenSeq` 增量补拉（`GET /messages?after=seq`）；乐观消息队列 + 失败重投 + 幂等去重（服务端 seq 去重）。
- **验收**：断线 30s 期间的消息重连后自动补齐，无重复无遗漏。

### O16【🟢 低】前端 WS 层收敛——全局 `wsSender` + 多 store 直连

- **位置**：`packages/web/src/stores/wsSender.ts`（模块级 `sender`）+ `AppLayout` 注入 + `useWebSocket`。
- **现状/问题**：可行但分散；重连/ping/pong/watchdog/补拉逻辑散在 hook 与 AppLayout。
- **建议**：收敛为单一 WS 管理模块（对照 Buzz desktop 的 `native_websocket`/event_sync 封装），store 只消费事件；多标签页场景加 BroadcastChannel 或 leader 选举。
- **验收**：WS 生命周期（连接/心跳/重连/补拉）单点管理，可单测。

---

## 5. 工程化 / CI / 部署 / 安全优化点

### O17【🔴 高】CI 只有 1 个 workflow，daemon/web/lint 全没跑

- **位置**：`.github/workflows/ci.yml`（单 job：typecheck → migrate → 起 server → 跑 server tests）。
- **现状/问题**：`packages/daemon` 的 12 个 vitest 文件、`packages/web` 构建、lint 全不在 CI 覆盖内；根 `package.json` 有 `lint` 脚本但**没有任何 package 定义 lint**（`pnpm -r run lint` 会失败）。
- **Buzz 对照**：Buzz 19 个 workflow 分层（单元/集成真环境 E2E/跨平台构建/canary/安全 cargo-deny），lefthook pre-commit 自动格式化 + pre-push clippy/tsc。
- **建议**：
  1. **补 lint**：引入 `eslint`（或 `biome`）+ `prettier` 到各 package，根脚本 `lint` 可真正执行；加 lefthook/husky pre-commit 自动格式化；
  2. CI 分层并行：L1 `pnpm -r typecheck + lint`、L2 `pnpm -r test`（server+daemon 全量）、L3 web build + Playwright smoke、L4 集成（daemon fakes + Valkey service）；
  3. 缓存 pnpm store 加速。
- **验收**：CI 绿覆盖 server/daemon/web 三包 + lint；本地 `pnpm lint` 可执行。

### O18【🔴 高】依赖安全审计缺失

- **位置**：无 `pnpm audit` / lockfile 扫描 / renovate/dependabot 配置。
- **现状/问题**：依赖前沿包（undici 7、@anthropic-ai/sdk、ioredis、node-pty），无漏洞告警机制。
- **Buzz 对照**：Buzz 有 cargo-deny（`deny.toml`）+ security workflow + renovate。
- **建议**：CI 加 `pnpm audit --prod`（失败阈值可配）+ `dependabot`/`renovate` 周更；`deny.toml` 类比为 `pnpm audit` 门槛。
- **验收**：CI 含依赖审计 job，高危漏洞阻断合并。

### O19【🟡 中】生产部署形态缺失——compose 是"开发式"

- **位置**：`docker-compose.yml`（server 服务 `volumes` 挂载源码 + node_modules，无 build 步骤、无 healthcheck、无资源限制）。
- **现状/问题**：无生产 Dockerfile 构建链、无多阶段构建、无非 root、无 healthcheck。
- **Buzz 对照**：Buzz 三态部署（dev/harness/prod compose + Helm chart），relay 有 healthcheck + 多架构镜像。
- **建议**：新增 `packages/server/Dockerfile`（多阶段：build → 精简 runtime，非 root，`HEALTHCHECK`）+ prod compose（读 env 而非挂源码）+ 资源限制；与 O5 联动（prod 缺 env 即失败）。
- **验收**：`docker compose up` 生产形态可拉起，healthcheck 生效，容器非 root。

### O20【🟢 低】仓库卫生

- **位置**：根目录 `cookies.txt`、`msgs.json`、`curl`（物理存在，已在 `.gitignore` 但未删除）；`.slock` 运行残留、`uploads/` 目录。
- **现状/问题**：`.gitignore` 已覆盖但文件未清理；敏感文件（cookies）物理存在是隐患。
- **建议**：删除 `cookies.txt`/`msgs.json`/`curl`；pre-commit 加"禁止敏感文件入库"检查；`sync-agent-notes.sh` 推送前过滤密钥/敏感对话。
- **验收**：工作区无敏感文件；pre-commit 拦截 `cookies.txt`/`.env` 类文件。

---

## 6. 优先级路线图

### Phase 1 · 止血（🔴 高，1 周）
O5 配置硬校验 → O17 CI 分层 + lint 补齐 → O18 依赖审计 → O1 Redis pub/sub 扇出 → O2 事件日志（先做消息发送/编辑/删除三类 verb）。

### Phase 2 · 提质（🟡 中，2–3 周）
O3 多租户边界 → O4 对象存储抽象 → O6 登录锁去内存化 → O7 权限缓存一致性 → O8 WS 认证退役计划 → O19 生产部署 → O14 Vue3 Phase G 收尾 → O15 前端增量补拉。

### Phase 3 · 精进（🟢 低，滚动）
O9 seq 并发测试 → O10/O11/O12/O13 daemon 收敛与安全 → O16 前端 WS 层收敛 → O20 仓库卫生。

---

## 7. 值得保留的现有实践（不要改坏）

- `lib/token-hash.ts` 快路径（sha256 索引 + bcrypt 兼容分流）——优雅，保留。
- WS 终端观察引用计数（无人观看零开销）——比 Buzz 还细，保留。
- `useWebSocket` 指数退避（1s→30s）+ 70s 入站看门狗——扎实，保留。
- 测试资产（server 13 + daemon 12 个 vitest 文件，含 round-end 集成、MCP server、fakes）——同规模项目里超平均水准。
- `docs/2026-07-14/` 自审文档体系（scorecard/roadmap/phase 报告）——"先审后改"纪律，保留。

---

## 8. 落地执行清单

| # | 任务 | 负责人 | 状态 |
|---|---|---|---|
| 1 | O5 配置硬校验 + 退出逻辑 | | ☐ |
| 2 | O17 引入 lint + 分层 CI | | ☐ |
| 3 | O18 依赖审计 job | | ☐ |
| 4 | O1 Redis pub/sub 扇出 | | ☐ |
| 5 | O2 events 表 + 哈希链 + audit API | | ☐ |
| 6 | O3 请求级租户解析 | | ☐ |
| 7 | O4 Storage 接口 + S3 实现 | | ☐ |
| 8 | O6 登录锁迁移 Valkey | | ☐ |
| 9 | O7 权限缓存一致性方案 | | ☐ |
| 10 | O8 bcrypt 兼容分支退役计划 | | ☐ |
| 11 | O19 生产 Dockerfile + compose | | ☐ |
| 12 | O14 Vue3 Phase G 收尾 | | ☐ |
| 13 | O15 断线增量补拉 + 乐观队列 | | ☐ |
| 14 | O9 seq 并发测试 | | ☐ |
| 15 | O10 daemon prod 启动路径 | | ☐ |
| 16 | O11 MCP 凭据安全 | | ☐ |
| 17 | O12 claude 权限收敛 | | ☐ |
| 18 | O13 daemon 代码面收敛 | | ☐ |
| 19 | O16 前端 WS 层收敛 | | ☐ |
| 20 | O20 仓库卫生 | | ☐ |

---

## 附 A · 关键文件定位索引

| 模块 | 文件 |
|---|---|
| WS 广播/认证 | `packages/server/src/ws/handler.ts` |
| 配置 | `packages/server/src/lib/config.ts` |
| 权限缓存 | `packages/server/src/lib/access.ts` |
| 限流 | `packages/server/src/lib/rate-limit.ts` |
| 令牌哈希 | `packages/server/src/lib/token-hash.ts` |
| 默认 server | `packages/server/src/lib/server.ts` |
| 存储 | `packages/server/src/lib/storage.ts` |
| DB schema | `packages/server/src/db/schema.ts` |
| 认证路由 | `packages/server/src/routes/auth.ts` |
| 消息路由 | `packages/server/src/routes/messages.ts` |
| daemon 监督 | `packages/daemon/src/supervisor.ts` |
| agent 运行时 | `packages/daemon/src/agent-runtime.ts` |
| claude 驱动 | `packages/daemon/src/drivers/claude.ts` / `persistent-claude.ts` |
| MCP server | `packages/daemon/src/mcp/slock-mcp-server.ts` |
| 前端消息 store | `packages/web/src/stores/messageStore.ts` |
| 前端 WS hook | `packages/web/src/hooks/useWebSocket.ts` |
| CI | `.github/workflows/ci.yml` |

## 附 B · 与既有自审文档的关系

- 本方案与 `docs/2026-07-14/server-analysis.md`、`server-optimization-roadmap.md`、`server-review-scorecard.md` 互补：后者聚焦"代码质量/安全/测试覆盖"（已大量落地），本文聚焦"架构大梁 + 可扩展性 + 与 Buzz 的差距"。
- 避免重复：CORS 白名单、`as any` 清理、hasMore 修复、错误格式统一、上传白名单、CSRF 轮换、优雅关闭、dev-token 后门等**已落地项不再重复**，仅在上文标注归属。
- 冲突需裁决：若某项在本方案与既有 roadmap 中优先级不一致，以"止血优先"为准（O5/O17/O18 最优先）。

---

## 执行进度（2026-08-16 更新）

> 落地状态跟踪。✅ = 已完成并提交；其余按优先级「止血 → 提质 → 精进」推进。
> 提交哈希与本表对应关系见 `.claude/buzz-optimization-progress.json`。

| # | 优化点 | 优先级 | 状态 | 落地说明 |
|---|---|---|---|---|
| O1 | Redis pub/sub 扇出 | 🔴 高 | ✅ 完成 | `lib/pubsub.ts`（ioredis + 内存回退）；`ws/handler.ts` 广播/sendToUser/sendToDaemon/terminal:frame 改走 pub/sub 信封；`index.ts` 注入 + 优雅关闭 |
| O2 | 事件日志/审计 | 🔴 高 | ✅ 完成 | `events` 表（migration 010，BIGINT IDENTITY + 无外键）+ `lib/audit.ts` 哈希链（稳定序列化防 jsonb 键序重排 + advisory lock 串行链头）；消息 send/edit/delete 事务内追加事件；`GET /api/audit` + `/api/audit/verify`；5 单测 |
| O5 | 配置危险默认值硬校验 | 🔴 高 | ✅ 完成 | `config.ts` 生产命中默认值 `exit(1)`；`ALLOW_INSECURE_DEV_SECRETS=1` 逃生门；`.env.example` + 6 单测 |
| O17 | CI 分层 + lint | 🔴 高 | ✅ 完成 | Biome 全仓 0 error；4 job 分层 CI + lefthook；5 包 lint 脚本 |
| O18 | 依赖安全审计 | 🔴 高 | ✅ 完成 | dependabot（npm+gh-actions weekly）+ audit.yml（高危阻断） |
| O3 | 多租户边界 | 🟡 中 | ⏳ 待办 | 下一项：请求级租户解析替代 `getDefaultServerId` |
| O4 | 对象存储抽象 | 🟡 中 | ⏳ 待办 | |
| O6 | 登录防爆破迁移 Valkey | 🟡 中 | ⏳ 待办 | |
| O7 | 权限缓存一致性 | 🟡 中 | ⏳ 待办 | |
| O8 | WS 认证 bcrypt 分支退役 | 🟡 中 | ⏳ 待办 | |
| O10 | daemon 生产启动路径 | 🟡 中 | ⏳ 待办 | |
| O11 | MCP 凭据传递安全 | 🟡 中 | ⏳ 待办 | |
| O12 | claude driver 权限收敛 | 🟡 中 | ⏳ 待办 | |
| O14 | Vue3 Phase G 收尾 | 🟡 中 | ⏳ 待办 | |
| O15 | 前端离线增量同步 | 🟡 中 | ⏳ 待办 | |
| O19 | 生产部署形态 | 🟡 中 | ⏳ 待办 | |
| O9 | messages.seq 竞态确认 | 🟢 低 | ⏳ 待办 | |
| O13 | daemon 代码面收敛 | 🟢 低 | ⏳ 待办 | |
| O16 | 前端 WS 层收敛 | 🟢 低 | ⏳ 待办 | |
| O20 | 仓库卫生 | 🟢 低 | ⏳ 待办 | |

### O1/O2 遗留增量项（已明确，未阻塞验收）

- **O1**：presence（`daemonClients.has()` 驱动的 `isOnline`）仍为实例本地态；`terminalWatchers` 引用计数仍为实例本地。多实例下「同一 agent 的终端观众跨实例 start/stop」需把登记迁到共享存储，本轮未做（消息广播扇出——即验收主目标——已闭环）。
- **O2**：事件接入当前覆盖 `message.send/edit/delete`；任务流转、频道成员增删、审批动作尚未接入 `appendEvent`（结构已就绪，逐个路由接入即可）；`/api/audit` 可见性校验当前仅支持 `message` 对象，其余 `object_type` fail-closed 返回 403。
