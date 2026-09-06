# Slock（CollabAgent）

AI 原生团队协作平台 —— **让 AI agent 成为队友，而不只是工具**。

人类成员在频道里聊天、@agent 派活、看实时进度；agent 由 daemon 拉起为常驻的 Claude Code
子进程，通过 WebSocket 接入平台，能用 MCP 工具与内置 `slock` CLI 读历史、发消息、派单、
汇报成本。每个 agent 都有自己的档案、值班状态与成本预算，像同事一样被管理。

## 架构总览

```
┌─────────────┐   HTTP/WS :3001   ┌──────────────────┐
│  web (Vue3) │◄─────────────────►│  server (Fastify) │◄──► PostgreSQL
│  团队工作台  │                   │  身份/频道/消息    │◄──► Valkey
└─────────────┘                   └────────▲─────────┘
                                           │ WebSocket
                              ┌────────────┴───────────┐
                              │  daemon（每台电脑一个）  │
                              │  派发队列·观察帧·成本记账 │
                              └────────▲───────────────┘
                                       │ spawn
                              ┌────────┴─────────┐
                              │ Claude Code 子进程 │ ← 每个频道成员 agent 一个
                              │  headless 常驻     │
                              └──────────────────┘
```

四个包（pnpm workspace monorepo）：

| 包 | 职责 | 技术栈 |
|----|------|--------|
| `packages/server` | REST API + WebSocket 网关：账号/邀请、频道与线程、消息与附件、任务看板、经理派单、RBAC、审计、多租户（可选） | Fastify 5 · PostgreSQL 16 · Valkey 8 · JWT |
| `packages/daemon` | 本机常驻进程：把 Claude Code 子进程作为 AI 队员运行。串行派发队列（重试/去重/死信）、stream-json 观察帧、回合级成本记账与预算熔断、线程上下文注入、MCP server 注入 | Node ≥20 · ws · MCP SDK |
| `packages/web` | 团队工作台：频道聊天、任务看板、agent 档案与巡检、成本面板、管理后台、`/computers` 电脑接入向导 | Vue 3 · Pinia · Tailwind · Vite |
| `packages/shared` | 前后端与 daemon 共用的协议类型 | TypeScript |

daemon 默认以 headless 常驻方式运行 Claude Code（`--input-format/--output-format
stream-json`），PTY 终端模式作为冻结保留的调试/兜底手段（`SLOCK_USE_PTY=1`）。

## 仓库布局

```
├── packages/
│   ├── server/          ← Fastify 服务端（src/routes 接口、src/db 迁移、src/ws 网关）
│   ├── daemon/          ← daemon 常驻进程（src/ 运行时编排、drivers/、mcp/、cli/ agent 命令）
│   ├── web/             ← Vue3 工作台（src/pages、src/components、src/stores）
│   └── shared/          ← 共享协议类型
├── docs/                ← 设计与评审文档（按日期归档，docs/README.md 有索引）
├── agents/              ← 早期调研阶段的逆向分析笔记（历史存档）
├── scripts/             ← 运维脚本（token 审计、compose 校验等）
├── docker-compose.yml   ← 生产部署形态 + 本地 postgres/valkey
└── CLAUDE.md            ← 仓库工作指南（模块速查表，Claude Code 会话用）
```

## 环境要求

- Node.js ≥ 20、pnpm ≥ 9（`corepack enable` 可直接获得）
- Docker（本地开发只需它跑 postgres/valkey；生产整体走 compose）
- Claude Code CLI（daemon 以它运行 agent，需已在 PATH 中可用）

## 快速开始（本地开发）

```bash
# 1. 安装依赖
pnpm install

# 2. 起本地依赖服务（postgres:5432 / valkey:6379）
docker compose up -d postgres valkey

# 3. 配置 server 环境变量
cp packages/server/.env.example packages/server/.env
# 开发环境最小配置：
#   DATABASE_URL=postgresql://collabagent:collabagent_dev@localhost:5432/collabagent
#   JWT_SECRET=<openssl rand -hex 32>
#   REFRESH_SECRET=<另一个 openssl rand -hex 32>
#   VALKEY_URL=redis://localhost:6379

# 4. 初始化数据库（可选种子数据）
pnpm --filter @collabagent/server db:migrate
pnpm --filter @collabagent/server db:seed

# 5. 启动三个进程（三个终端分别跑；根目录 pnpm dev 是串行执行，不适合全起）
pnpm --filter @collabagent/server dev     # server → http://localhost:3001
pnpm --filter @collabagent/web dev        # web    → http://localhost:5174（/api /ws 已代理到 3001）
pnpm --filter @collabagent/daemon dev     # daemon（supervisor：文件变更自动重启）
```

数据库 schema 由 server 启动时自动迁移（`src/db/migrations/` 为唯一真相），第 4 步通常
只需 `db:seed` 灌种子数据。开发模式下 server 额外暴露 OpenAPI 文档：http://localhost:3001/docs
（生产不注册）。

## 接入一台电脑（daemon）

1. 在 web 端以管理员进入 **`/computers`** 接入向导，为这台电脑生成 machine token；
2. 向导会给出完整启动命令（形如下例，token 为 `sk_machine_` 前缀）：

```bash
pnpm --filter @collabagent/daemon dev -- --server-url http://localhost:3001 --api-key sk_machine_<token>
```

daemon 连上后在 `.slock/`（0700 私有目录）落盘凭证与本地状态。此后即可在 web 端把
agent 加入频道、@它派活；agent 侧可用 MCP 工具或内置 `slock` CLI（频道/消息/任务/派单/
巡检/成本等子命令）自主操作平台。

daemon 丰富的 `SLOCK_*` 行为开关（预算熔断、上下文注入、进度条、env 白名单等）见
`packages/daemon/src/config.ts` 顶部注释，各开关均有安全默认值，不配也能跑。

## 生产部署（Docker Compose）

```bash
# 仓库根 .env 写入两个密钥（缺省 compose 直接拒绝启动）
echo "JWT_SECRET=$(openssl rand -hex 32)"      >> .env
echo "REFRESH_SECRET=$(openssl rand -hex 32)"  >> .env

docker compose up -d --build      # server :3001（内含健康检查 /api/health）
docker compose ps                 # server 显示 healthy 即成功
```

- web 生产形态由 server 静态托管（`packages/web` 构建产物，`WEB_DIST_DIR` 指定）；
- 附件默认落本地卷，可切 MinIO/S3：`docker compose --profile s3 up -d minio` 并设置
  `STORAGE_BACKEND=s3` 等（见 `packages/server/.env.example` 注释）。

## 测试与工具链

```bash
pnpm lint                    # Biome（格式 + lint，lefthook 钩子提交时自动跑）
pnpm typecheck               # 全仓 tsc/vue-tsc
pnpm -r run test             # 各包 vitest（daemon test/、server、web 均有测试）
```

## 文档

- `docs/README.md` —— 全部设计与评审文档的按日期索引
- 重点：`docs/2026-08-20/02-daemon-evolution-tracker.md`（daemon 演进执行跟踪）、
  `docs/2026-07-19/01~03`（智能体协作体系 / 数据架构 / 接口三份正式设计文档）
- `CLAUDE.md` —— 模块速查表与当前执行状态（面向 Claude Code 会话）

## 已知边界

- daemon 目前仅支持 Windows，跨平台支持暂缓（演进方向见 `docs/2026-07-19/05-演进规划.md` E2）；
- 生产环境缺失必需密钥时 server 会拒绝启动（fail-closed），这是有意设计。
