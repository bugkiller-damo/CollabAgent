# Slock 复现方案 — 综合分析文档

> 基于 daemon v0.53.2 逆向工程，由 4 个专业 agent 并行分析并交叉验证。
> 生成时间: 2026-05-25

---

## 目录

1. [架构全景](#1-架构全景)
2. [Daemon 本地运行时](#2-daemon-本地运行时)
3. [通信协议与数据模型](#3-通信协议与数据模型)
4. [服务端 API 与数据库设计](#4-服务端-api-与数据库设计)
5. [前端 UI 架构](#5-前端-ui-架构)
6. [技术栈汇总](#6-技术栈汇总)
7. [实施路线图](#7-实施路线图)
8. [交叉验证记录](#8-交叉验证记录)

---

## 1. 架构全景

```
┌─────────────────────────────────────────────────────────────┐
│                    Slock Server (api.slock.ai)               │
│                                                             │
│  ┌──────────┐ ┌──────────┐ ┌────────┐ ┌──────────────┐    │
│  │ 认证服务 │ │ 消息服务 │ │任务服务│ │ 提醒调度器   │    │
│  └──────────┘ └──────────┘ └────────┘ └──────────────┘    │
│  ┌──────────┐ ┌──────────┐ ┌────────┐ ┌──────────────┐    │
│  │ 频道服务 │ │ 文件服务 │ │集成服务│ │ Agent管理    │    │
│  └──────────┘ └──────────┘ └────────┘ └──────────────┘    │
│                                                             │
│  数据层: PostgreSQL + Redis + S3/对象存储                    │
└──────────────┬──────────────────────────────────────────────┘
               │ WebSocket (wss://) + REST API
               │ Auth: Bearer sk_machine_*
               │
┌──────────────▼──────────────────────────────────────────────┐
│            Slock Daemon (Node.js, 本地守护进程)              │
│                                                             │
│  ┌──────────────────┐  ┌──────────────────────────────┐    │
│  │   DaemonCore      │  │   AgentProcessManager        │    │
│  │   - WebSocket 连接 │  │   - 8 种 runtime driver     │    │
│  │   - 消息路由       │  │   - 进程生命周期管理         │    │
│  │   - 提醒缓存       │  │   - CLI wrapper 注入         │    │
│  │   - Trace 收集     │  │   - Proxy token 管理         │    │
│  └──────────────────┘  └──────────────────────────────┘    │
│                                                             │
│  本地 HTTP 代理: 127.0.0.1:6381 (managed-runner 模式)       │
└──────────────┬──────────────────────────────────────────────┘
               │ spawn + env
               │
┌──────────────▼──────────────────────────────────────────────┐
│            AI Runtime (Claude Code / Codex / ...)            │
│                                                             │
│  ┌─────────────────────┐  ┌──────────────────────────────┐  │
│  │ .slock/slock wrapper │  │ .slock/claude-mcp-config.json│  │
│  │ (注入 auth 环境变量) │  │ (指向 chat-bridge.js)       │  │
│  └─────────┬───────────┘  └──────────────┬───────────────┘  │
│            │                             │                   │
│  ┌─────────▼───────────┐  ┌──────────────▼───────────────┐  │
│  │ slock CLI (29 命令) │  │ chat-bridge.js (MCP stdio)   │  │
│  └─────────────────────┘  └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│            Web Frontend (React 19 + Vite + TailwindCSS)      │
│                                                             │
│  ┌─────────────────────┐  ┌──────────────────────────────┐  │
│  │ Zustand Stores (9)   │  │ WebSocket Hook               │  │
│  │ auth/channel/msg/    │  │ 重连/离线/watchdog/降级轮询  │  │
│  │ task/dm/profile/     │  │                              │  │
│  │ reminder/integ/ui    │  │ MessageRouter (14 种消息类型) │  │
│  └─────────────────────┘  └──────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Daemon 本地运行时

> 详细分析: `notes/slock-daemon-architecture.md`

### 2.1 Bundle 结构

| 文件 | 大小 | 用途 |
|---|---|---|
| `dist/index.js` | 661B | 主入口: CLI 参数解析, DaemonCore 创建, 信号处理 |
| `dist/core.js` | 597B | 公共 API 导出 |
| `dist/cli/index.js` | 634KB | CLI 工具 — 29 个子命令实现 |
| `dist/chat-bridge.js` | 3.3KB (98行) | MCP stdio 桥接 (1 个弃用工具) |
| `dist/chunk-KNMCE6WB.js` | 7.2KB | 共享工具: logger, fetch proxy, timeout |
| `dist/chunk-UIJF67BT.js` | 431KB (10,569行) | DaemonCore, AgentProcessManager, 8 个 runtime driver |

### 2.2 DaemonCore 生命周期

```
parseDaemonCliArgs([--server-url, --api-key])
  → new DaemonCore({ serverUrl, apiKey })
    → daemon.start()
      → 解析 SLOCK_HOME (~/.slock)
      → runtime 探测 (扫描 PATH 中 8 种 runtime)
      → 安装 LocalRotatingTraceSink (5MB/5min/8 files)
      → 打开 WebSocket 连接到服务器
      → daemon.stop() on SIGTERM/SIGINT
```

### 2.3 Agent 认证模式 (4 种)

| 模式 | 环境变量 | Secret Source |
|---|---|---|
| **managed-runner** | `SLOCK_AGENT_PROXY_URL` + `SLOCK_AGENT_PROXY_TOKEN[_FILE]` | agent-proxy-token |
| **self-hosted-runner** | `SLOCK_AGENT_CREDENTIAL_KEY_FILE` | agent-credential-file |
| **legacy-machine** | `SLOCK_AGENT_TOKEN_FILE` | legacy-token-file |
| **legacy-machine** | `SLOCK_AGENT_TOKEN` | legacy-token-env |

Active capabilities: `send,read,mentions,tasks,reactions,server,channels`

### 2.4 29 个 CLI 子命令 (11 组)

| 组 | 数量 | 命令 |
|---|---|---|
| auth | 1 | whoami |
| channel | 3 | members, join, leave |
| thread | 1 | unfollow |
| server | 1 | info |
| message | 5 | send, check, read, search, react |
| attachment | 2 | upload, view |
| task | 5 | list, create, claim, unclaim, update |
| profile | 2 | show, update |
| integration | 2 | list, login |
| reminder | 6 | schedule, list, cancel, snooze, update, log |
| action | 1 | prepare |

统一实现模式: `loadAgentContext() → new ApiClient(ctx) → client.request() → emit/fail()`

### 2.5 8 个 Runtime Driver

| Runtime | Binary | 关键特性 |
|---|---|---|
| **Claude Code** | `claude` | stream-json I/O, --resume, --model, gated stdin, MCP config |
| Codex CLI | `codex` | OpenAI Codex |
| Antigravity | `agy` | |
| Kimi CLI | `kimi` | Moonshot |
| Copilot CLI | `copilot` | GitHub |
| Cursor CLI | `cursor-agent` | |
| Gemini CLI | `gemini` | Google |
| OpenCode | `opencode` | |

每个 driver 接口: `id, lifecycle, communication, session, model, probe(), spawn(), parseLine()`

### 2.6 ClaudeDriver 关键参数

```bash
claude \
  --dangerously-skip-permissions \
  --verbose \
  --output-format stream-json \
  --input-format stream-json \
  --model <model> \
  --disallowed-tools <blocklist> \
  --append-system-prompt-file <system-prompt.md> \
  --resume <sessionId> \
  --mcp-config <claude-mcp-config.json> \
  --strict-mcp-config
```

### 2.7 Agent Workspace 结构

```
~/.slock/
├── agents/{agentId}/         ← Agent workspace
│   ├── MEMORY.md
│   ├── notes/
│   └── .slock/               ← 运行时文件
│       ├── slock / slock.cmd / slock.ps1  ← CLI wrapper
│       ├── agent-token
│       ├── claude-system-prompt.md
│       └── claude-mcp-config.json
├── agent-proxy-tokens/{agentId}/{launchId}.token
└── machines/{machineId}/
    ├── daemon.lock/
    └── trace-uploads/
```

### 2.8 ApiClient 路径重写 (14 条规则)

```
/internal/agent/{id}/send           → /internal/agent-api/send
/internal/agent/{id}/history        → /internal/agent-api/history
/internal/agent/{id}/receive        → /internal/agent-api/events?since=latest
/internal/agent/{id}/server         → /internal/agent-api/server
/internal/agent/{id}/channel-members → /internal/agent-api/channel-members
/internal/agent/{id}/profile        → /internal/agent-api/profile
/internal/agent/{id}/integrations   → /internal/agent-api/integrations
/internal/agent/{id}/upload         → /internal/agent-api/upload
/internal/agent/{id}/resolve-channel → /internal/agent-api/resolve-channel
/internal/agent/{id}/threads/unfollow → /internal/agent-api/threads/unfollow
/internal/agent/{id}/prepare-action → /internal/agent-api/prepare-action
/internal/agent/{id}/tasks          → /internal/agent-api/tasks
/internal/agent/{id}/reminders      → /internal/agent-api/reminders
/internal/agent/{id}/messages/{mid}/reactions → /internal/agent-api/messages/{mid}/reactions
/internal/agent/{id}/channels/{ch}/(join|leave) → /internal/agent-api/channels/{ch}/(join|leave)
/internal/agent/{id}/attachments/{aid} → 直通 server
```

---

## 3. 通信协议与数据模型

> 详细分析: `notes/slock-protocol-analysis.md`

### 3.1 消息格式

```
[target=#general msg=a1b2c3d4 time=2026-03-15T01:00:00 type=human] @richard: hello
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `target` | string | `#channel` / `dm:@peer` / `#channel:threadId` / `dm:@peer:threadId` |
| `msg` | UUID(8) | 消息短 ID, 用作 thread 后缀 |
| `time` | ISO 8601 | 时间戳 |
| `type` | enum | `human` / `agent` / `system` |

### 3.2 WebSocket 入站流水线

```
WebSocket IN
  → daemon.connection.inbound_received
    → daemon.agent.delivery (consumer span)
      → daemon.receive → {seq, deliveryId}
      → daemon.deliver_to_agent_manager → {accepted: true/false}
      → daemon.ack.sent → {seq} (ackSeq)
    → daemon.agent.delivery.routed
      → outcome:
        - "stdin_idle_delivery" (agent 在线, stdin 投递)
        - "rejected_no_process" (agent 未运行, 触发 cold start)
    → 在线路径: daemon.agent.stdin_delivery
      → gated delivery (busy_delivery_mode: "gated")
    → 离线路径: daemon.agent.start.requested → queued → spawn
```

### 3.3 Turn 生命周期 (Gate Steering)

| Phase | 含义 |
|---|---|
| `assistant_continuation` | AI 正在生成响应 |
| `tool_wait` | 等待工具执行结果 |
| `tool_boundary` | 工具执行完成, 等待 AI 继续 |
| `idle` | turn 结束, 等待下一条消息 |

**关键设计**: 仅在 `idle` 阶段投递新消息, `tool_wait/tool_boundary` 期间排队。

### 3.4 数据模型定义

```typescript
// 消息
interface Message {
  seq: number;           // 全局递增序列号
  msg: string;           // UUID (完整 36 字符)
  time: ISO8601;         // 时间戳
  type: "human" | "agent" | "system";
  target: string;        // #channel / dm:@peer / #channel:threadId
  content: string;
  taskNumber?: number;   // 任务编号 (频道内自增)
  taskStatus?: "todo" | "in_progress" | "in_review" | "done";
  attachments?: Attachment[];
}

// 频道
interface Channel {
  name: string;
  description?: string;
  visibility: "public" | "private";
  joined: boolean;
  archived?: boolean;
}

// 任务 — 消息的子类型
interface Task {
  number: number;
  messageId: UUID;
  title: string;
  status: "todo" | "in_progress" | "in_review" | "done";
  assignee?: string;  // "agent:uuid"
  channel: string;
}

// 提醒
interface Reminder {
  id: UUID;
  title: string;
  schedule: string;           // every:15m | daily@09:00 | weekly:mon,fri@09:00
  recurring: boolean;
  anchorMessageId?: UUID;
  status: "scheduled" | "fired" | "cancelled";
  author: string;
}

// 附件
interface Attachment {
  id: UUID;
  name: string;
  mimeType: string;
  size: number;  // max 50MB
}

// Action Card
interface ActionCard {
  type: "channel:create" | "agent:create";
  target: string;
  // payload: channel → { name, description, visibility }
  //          agent   → { name, displayName, role, model }
}
```

### 3.5 WebSocket 消息类型 (14 种)

| 类型 | 方向 | 说明 |
|---|---|---|
| `agent:start` | S→C | 启动 agent |
| `agent:stop` | S→C | 停止 agent |
| `agent:deliver` | S→C | 消息投递 |
| `agent:reset-workspace` | S→C | 重置 workspace |
| `agent:runtime_profile:migration` | S→C | Profile 迁移 |
| `agent:workspace:list` | S→C | 列出 workspace 文件 |
| `agent:workspace:read` | S→C | 读取文件 |
| `agent:skills:list` | S→C | 列出 skills |
| `agent:activity_probe` | S→C | 健康检查 |
| `machine:workspace:delete` | S→C | 删除 workspace |
| `machine:runtime_models:detect` | S→C | 模型检测 |
| `reminder.upsert` | S→C | 提醒创建/更新 |
| `reminder.cancel` | S→C | 提醒取消 |
| `reminder.snapshot` | S→C | 提醒全量同步 |

### 3.6 ACK 与 Presence 机制

- **seq**: 全局递增消息序列号, 用于排序/去重/分页/ack
- **ACK**: 每条 WebSocket 消息需 ack; `rejected_no_process` → cold start
- **Presence 三层信号**:
  1. WebSocket 连接状态 (即时)
  2. `GET /receive?block=true&timeout=N` 长轮询 (隐式)
  3. `runtime_profile.report.sent` 每次 turn 后触发 (宽限期兜底)

### 3.7 并发控制

- Agent 启动: max 5 concurrent starts, 500ms min interval
- 消息投递: gated delivery + stdin notification
- Cold start: `rejected_no_process` → queued → spawn

---

## 4. 服务端 API 与数据库设计

> 详细分析: `notes/slock-backend-analysis.md`

### 4.1 API 路由分层

```
/api/*                    → 用户端 API (Web UI)
/internal/agent/{id}/*    → Agent 端 API (daemon 调用)
/internal/machine/*       → 机器端 API (daemon 认证)
/internal/agent-api/*     → 本地代理内部路径
```

### 4.2 核心 API 端点

#### 消息
| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/internal/agent/{id}/send` | 发送消息 |
| `GET` | `/internal/agent/{id}/receive` | 接收消息 (支持长轮询) |
| `POST` | `/internal/agent/{id}/receive-ack` | 确认收悉 |
| `GET` | `/internal/agent/{id}/history` | 历史消息 (before/after/around/limit) |
| `GET` | `/internal/agent/{id}/search` | 搜索消息 |
| `POST/DELETE` | `/internal/agent/{id}/messages/{mid}/reactions` | 表情反应 |

#### 频道
| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/internal/agent/{id}/server` | 服务器信息 (channels/agents/humans) |
| `GET` | `/internal/agent/{id}/channel-members` | 频道成员 |
| `POST` | `/internal/agent/{id}/channels/{ch}/join` | 加入频道 |
| `POST` | `/internal/agent/{id}/channels/{ch}/leave` | 离开频道 |
| `POST` | `/internal/agent/{id}/threads/unfollow` | 取消关注线程 |

#### 任务
| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/internal/agent/{id}/tasks` | 列出任务 |
| `POST` | `/internal/agent/{id}/tasks` | 创建任务 |
| `POST` | `/internal/agent/{id}/tasks/claim` | 认领任务 (支持批量) |
| `POST` | `/internal/agent/{id}/tasks/unclaim` | 放弃任务 |
| `POST` | `/internal/agent/{id}/tasks/update-status` | 更新状态 |

任务状态机: `todo → in_progress → in_review → done`

#### 提醒
- 支持: 绝对时间 (`fireAt`), 相对时间 (`delaySeconds`), 循环 (`every:15m | daily@09:00 | weekly:mon,fri@09:00`)
- 完整生命周期日志 (created/fired/snoozed/updated/canceled)

#### 文件上传
1. `POST /internal/machine/scope-attestation` → 获取 attestation
2. `POST /api/uploads` (带 attestation) → 获取 presigned URL
3. `PUT <presigned-url>` → 直传文件
4. attachment ID 随消息发送

### 4.3 数据库 Schema (PostgreSQL)

核心表: `users, agents, servers, channels, channel_members, messages, message_reactions, attachments, message_attachments, reminders, reminder_events, integrations, agent_logins, machine_tokens, agent_credentials, action_cards`

**消息表关键设计**:
- `seq BIGSERIAL` — 全局递增序列号
- `thread_id UUID REFERENCES messages(id)` — NULL = top-level
- `task_number INTEGER, task_status VARCHAR(20), task_assignee UUID` — 任务元数据嵌入消息
- GIN 索引支持全文搜索

### 4.4 认证体系

三种 Token 类型:
1. **Machine Token** (`sk_machine_*`) — 机器级认证, 对应用户身份
2. **Agent Credential** — Agent 自有凭证, 直接调用 API
3. **Agent Proxy Token** — 本地代理用, daemon 持有真实 key

三种 clientMode: `managed-runner`, `self-hosted-runner`, `legacy-machine`

### 4.5 消息发送流程

```
Agent CLI → POST /internal/agent/{id}/send
  → Server: 验证 token → 检查 freshness (draft rehold 冲突检测)
  → 生成 seq (原子递增) → 持久化消息 → WebSocket 广播
  → 返回 {state: "sent"/"held", messageId, messageSeq}
```

Draft/Freshness 机制:
- `draftReholdCount` — 乐观锁, 防止基于过时上下文的操作
- `state: "held"` — 消息未发送 (有新消息到达), 需用户确认重试
- `state: "sent"` — 成功发送

---

## 5. 前端 UI 架构

> 详细分析: `notes/slock-frontend-architecture.md`

### 5.1 技术栈

| 层 | 选型 |
|---|---|
| 框架 | React 19 + TypeScript |
| 构建 | Vite |
| 样式 | TailwindCSS |
| 路由 | React Router v7 |
| 状态管理 | Zustand (9 个 store) |
| 实时通信 | 原生 WebSocket + 自定义 hook |
| Markdown | react-markdown + rehype-highlight |
| 拖拽 | @dnd-kit/core |
| 表单 | React Hook Form + Zod |

### 5.2 路由设计 (14 条)

```
/login, /register
/channels, /channels/:name, /channels/:name/:threadId
/dm/:peer, /dm/:peer/:threadId
/tasks, /tasks/:channel
/settings, /settings/profile, /settings/integrations, /settings/notifications
/admin, /admin/channels, /admin/agents, /admin/members
```

### 5.3 组件树 (顶层)

```
<App>
├── <AuthProvider> → <WebSocketProvider> → <StoreProvider>
├── <AppLayout>
│   ├── <Sidebar>           // 频道列表 + DM 列表 + 用户区
│   ├── <MainContent>       // 路由出口
│   │   ├── <ChannelView>   // 消息头 + 消息列表 + 输入框
│   │   ├── <DmView>
│   │   ├── <ThreadView>    // 父消息卡片 + 回复列表
│   │   ├── <TaskBoard>     // 四列看板 (可拖拽)
│   │   ├── <SettingsLayout>
│   │   └── <LoginPage> / <RegisterPage>
│   └── <RightSidebar>      // 频道成员 + 任务预览
```

### 5.4 9 个 Zustand Store

| Store | 职责 |
|---|---|
| `authStore` | 用户/token/登录状态 |
| `channelStore` | 频道列表、joined 状态、未读计数 |
| `messageStore` | messagesByTarget、发送/接收/搜索、reaction |
| `taskStore` | 按频道分组任务、claim/status 流转、乐观更新 |
| `dmStore` | DM 会话列表 |
| `profileStore` | 用户 profile 缓存 (@handle 索引) |
| `reminderStore` | 提醒 CRUD、snapshot 同步 |
| `integrationStore` | 第三方服务列表/登录状态 |
| `uiStore` | 侧栏折叠、线程面板、主题 |

### 5.5 WebSocket 实时通信

- **连接**: `ws://{server}/daemon/connect?key={apiKey}`
- **重连**: 指数退避 1s→2s→4s→...→30s max
- **Watchdog**: 70s 无入站消息 → 强制重连
- **离线降级**: 重连后 `GET /events?since={lastSeenSeq}` 补拉
- **HTTP fallback**: WebSocket 不可用时 5s 轮询

数据流: `WebSocket → MessageRouter (14 种类型) → Zustand Stores → React Components`

### 5.6 关键交互

- **消息发送**: 发送 → freshness check → "held"(草稿) 或 "sent"(确认)
- **消息接收**: 按 target 追加 + 判断当前视图 → 渲染或未读计数
- **消息组**: 同发送者 5 分钟内连续消息合并显示
- **任务看板**: 四列 (todo/in_progress/in_review/done), @dnd-kit 拖拽流转
- **Action Card**: Agent 发出的审批卡片, human 点击 Approve/Reject

### 5.7 实施优先级

| Phase | 内容 | 工时 |
|---|---|---|
| P0 核心 | 登录/频道/DM/消息/WebSocket/线程 | 3-4 周 |
| P1 完善 | 附件/@提及/搜索/离线重连/未读/代码高亮 | 1-2 周 |
| P2 增强 | 任务看板拖拽/Action Card/集成/设置/管理/提醒 UI | 2-3 周 |

**前端总计**: 单人 + AI 辅助约 **6-9 周**

---

## 6. 技术栈汇总

| 层 | 推荐技术 | 原因 |
|---|---|---|
| **后端运行时** | Node.js 20+ (TypeScript) | 与 daemon 统一, AI 辅助效果最佳 |
| **HTTP 框架** | Fastify / Hono | 高性能, TypeScript 原生支持 |
| **数据库** | PostgreSQL 15+ | 成熟可靠, 支持 JSONB/GIN/全文搜索 |
| **缓存/队列** | Redis 7+ | WebSocket 状态/消息队列/会话管理 |
| **对象存储** | MinIO (自建) / S3 (云) | 附件/头像存储 |
| **WebSocket** | ws / uWebSockets.js | 轻量高性能 |
| **ORM** | Drizzle ORM / Prisma | TypeScript 友好, 迁移管理 |
| **API 校验** | Zod | 与 daemon 对齐, 前后端复用 schema |
| **调度器** | node-cron + BullMQ | 提醒调度 + 任务队列 |
| **前端框架** | React 19 + Vite + TailwindCSS | 生态成熟, AI 生成质量高 |
| **前端状态** | Zustand | 轻量, TS 友好 |
| **部署** | Docker Compose (MVP) → Kubernetes | 渐进式扩展 |
| **Daemon** | 复用现有架构 (Node.js CLI bundle) | 已验证的设计 |

---

## 7. 实施路线图

### Phase 1: MVP 核心 (4-5 周, 单人 + AI)

- [ ] 用户注册/登录/Token 认证
- [ ] 频道 CRUD + 成员管理
- [ ] 消息发送/接收/搜索 (频道 + DM + 线程)
- [ ] WebSocket 实时推送 + ACK + 离线补拉
- [ ] 前端聊天界面 (频道/DM/线程三视图)
- [ ] 本地 Daemon (CLI + proxy + Claude runtime 适配)

### Phase 2: 协作功能 (3-4 周)

- [ ] 任务系统 (状态机 + claim + 看板 UI)
- [ ] 文件附件 (上传/预览/下载)
- [ ] @提及 + 通知
- [ ] Action Card (B-mode 审批)
- [ ] Agent 管理 (注册/生命周期/在线状态)

### Phase 3: 完善与稳定 (2-3 周)

- [ ] 断线重连优化
- [ ] 全文搜索
- [ ] 数据备份
- [ ] 基础监控与告警
- [ ] 移动端适配

**总工期: 单人 + AI 辅助约 9-12 周 (2.5-3 个月)**

---

## 8. 交叉验证记录

以下关键接口点在四个 agent 的分析中完全对齐:

| 接口点 | Daemon | Protocol | Backend | Frontend |
|---|---|---|---|---|
| **14 种 WS 消息类型** | DaemonConnection 枚举 | Trace span 分析 | 服务端 push 通道 | MessageRouter 覆盖 |
| **14 条路径重写规则** | ApiClient.rewriteAgentCredentialPath | — | API 路由设计 | HTTP client 基准 |
| **三层 Presence** | WebSocket + receive + profile report | ACK + cold start 路径 | Heartbeat + profile fallback | agent:status UI |
| **Gated Delivery** | busyDeliveryMode: "gated" | Gate Steering 四阶段 | 消息缓冲策略 | Pending 队列 UI |
| **Draft 双态** | held/sent + reholdCount | Freshness check | 乐观锁并发控制 | 发送流程 |
| **Task 状态机** | todo→in_progress→in_review→done | CLI 命令约束 | DB schema + API | 看板四列 + 拖拽 |
| **Reminder 循环语法** | every:15m/daily@09:00/weekly:mon,fri@09:00 | Cron 概念 | 调度器实现 | Reminder UI |
| **Trace 轮转参数** | 5MB/5min/8 files | Bundle 大小与间隔 | Trace 收集 API | — |
| **Target 语法** | #channel/dm:@peer/:threadId | 消息格式规范 | 路由参数解析 | URL 参数复用 |
| **Token 三层体系** | managed/self-hosted/legacy | 存储路径 + MCP config | DB schema + 权限 | AuthStore |

---

## 附录: 源文档索引

| 文档 | Agent | 路径 |
|---|---|---|
| Daemon 架构分析 | @slock-daemon | `notes/slock-daemon-architecture.md` |
| 通信协议分析 | @slock-protocol | `notes/slock-protocol-analysis.md` |
| 后端 API 设计 | @slock-backend | `notes/slock-backend-analysis.md` |
| 前端 UI 架构 | @slock-frontend | `notes/slock-frontend-architecture.md` |
