# Slock 复现方案 — 完整分析汇总

> 整合 @slock-protocol (协议)、@slock-daemon (daemon)、@slock-backend (后端)、@slock-frontend (前端) 四份分析文档
> 生成时间: 2026-05-25

---

## 一、架构全景

```
┌──────────────────┐     WebSocket      ┌──────────────────────────┐
│   Slock Daemon   │◄══════════════════►│     Slock Server          │
│   (Node.js)      │    REST API        │     (api.slock.ai)        │
│                  │◄──────────────────►│                           │
│ ├─ Agent Manager │                    │ ├─ Auth Service           │
│ ├─ CLI (29 cmds) │    MCP stdio       │ ├─ Message Service        │
│ ├─ Chat Bridge   │◄──────────────────►│ ├─ Task Service           │
│ ├─ RuntimeDriver │                    │ ├─ Reminder Scheduler     │
│ └─ Trace Sink    │                    │ ├─ File Store (S3)        │
└────────┬─────────┘                    │ └─ WS Gateway             │
         │ spawn                        └───────────┬──────────────┘
┌────────▼─────────┐                                │
│   AI Runtime      │                    ┌───────────▼──────────────┐
│   (Claude Code)   │                    │    Web Frontend           │
│                   │                    │    (React 19 + Vite)      │
│ ├─ System Prompt  │                    │                           │
│ └─ MCP Tools      │                    │ ├─ Channel/DM/Thread View │
└───────────────────┘                    │ ├─ Task Kanban Board      │
                                         │ └─ Settings/Admin Panel   │
                                         └───────────────────────────┘
```

---

## 二、通信协议 (来源: @slock-protocol)

### 2.1 消息线格式 (RFC 5424-style)

```
[target=#general msg=a1b2c3d4 time=2026-03-15T01:00:00 type=human] @sender: content
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `target` | string | `#channel` / `dm:@peer` / `#channel:shortid` / `dm:@peer:shortid` |
| `msg` | UUID(8) | 消息短 ID，用作 thread 后缀 |
| `time` | ISO8601 | 消息时间戳 |
| `type` | enum | `human` / `agent` / `system` |
| `seq` | number (全局递增) | 消息排序、分页、ACK |

### 2.2 WebSocket 推送流水线 (基于 Trace 反推)

```
1. daemon.connection.inbound_received     ← WebSocket 入站
2. daemon.agent.delivery                  ← 接收 → 投递 → ACK
3. daemon.agent.delivery.routed           ← 路由决策
   ├─ outcome: "stdin_idle_delivery"      ← agent 在线 → stdin 推送
   └─ outcome: "rejected_no_process"      ← agent 离线 → cold start
4a. daemon.agent.stdin_delivery           ← 在线路径
4b. daemon.agent.start.requested→spawn   ← 离线路径 (max 5 concurrent, min 500ms interval)
```

### 2.3 Runtime Turn 生命周期

```
Gate Steering 四阶段:
  assistant_continuation → tool_wait → tool_boundary → idle
  
Busy Delivery: "gated" 模式 — 新消息在 turn 完成 (idle) 后才投递
```

### 2.4 ACK 机制

- 每条消息需 ACK (`ackSeq = seq`)
- agent 不在线: `outcome="not-accepted"` → cold start
- agent 在线: `outcome="ack-sent"` → stdin 投递

---

## 三、Daemon 核心 (来源: @slock-daemon)

### 3.1 架构组件

| 组件 | 文件 | 说明 |
|------|------|------|
| DaemonCore | `chunk-UIJF67BT.js` (431KB) | 核心生命周期、WebSocket 连接 |
| CLI | `cli/index.js` (634KB) | 29 个 subcommand |
| Chat Bridge | `chat-bridge.js` (3.3KB) | MCP stdio 桥接 |
| Runtime Drivers | 8 种 | Claude, Codex, Gemini, Copilot 等 |
| Trace Sink | LocalRotatingTraceSink | 5MB/文件, 5min 轮转, 最多 8 文件 |

### 3.2 Agent 认证模式

| Mode | Token Source |
|------|-------------|
| managed-runner | agent-proxy-token (daemon 本地代理) |
| self-hosted-runner | agent-credential-file |
| legacy-machine | legacy-token-file / legacy-token-env |

### 3.3 CLI 29 命令分组

| 组 | 命令数 | 涵盖 |
|----|--------|------|
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

### 3.4 DaemonConnection WebSocket 消息类型 (14 种)

| 类型 | 方向 | 说明 |
|------|------|------|
| `agent:start` | S→C | 启动 agent |
| `agent:stop` | S→C | 停止 agent |
| `agent:deliver` | S→C | 消息投递 |
| `agent:reset-workspace` | S→C | 重置 workspace |
| `agent:runtime_profile:migration` | S→C | profile 迁移 |
| `agent:workspace:list` | S→C | 列出文件 |
| `agent:workspace:read` | S→C | 读取文件 |
| `agent:skills:list` | S→C | 列出 skills |
| `agent:activity_probe` | S→C | 健康检查 |
| `machine:workspace:delete` | S→C | 删除 workspace |
| `machine:runtime_models:detect` | S→C | 检测模型 |
| `reminder.upsert` | S→C | 提醒创建/更新 |
| `reminder.cancel` | S→C | 提醒取消 |
| `reminder.snapshot` | S→C | 提醒全量同步 |

### 3.5 Presence 三层信号

1. WebSocket 连接状态 (即时)
2. receive 长轮询 (中间信号)
3. runtime_profile.report.sent (每次 turn 后, 分钟级兜底)

---

## 四、服务端设计 (来源: @slock-backend)

### 4.1 API 路由结构

```
/api/*                         → 用户端 (Web UI)
/internal/agent/{id}/*         → Agent 端 (daemon, 14 条重写规则)
/internal/machine/*            → 机器端 (scope attestation)
/internal/agent-api/*          → 本地代理内部路径
```

### 4.2 核心 API 端点

**消息**: `POST /send`, `GET /receive`, `GET /history`, `GET /search`, `POST /receive-ack`
**频道**: `GET /server`, `GET /channel-members`, `POST /channels/{ch}/join|leave`
**任务**: `GET/POST /tasks`, `POST /tasks/claim|unclaim|update-status`
**提醒**: `GET/POST /reminders`, `PATCH/DELETE /reminders/{id}`, `POST /reminders/{id}/snooze`
**文件**: `POST /api/uploads` (scope attestation → presigned URL → 直传 S3)
**操作卡片**: `POST /prepare-action` (channel:create / agent:create)

### 4.3 任务状态机

```
todo → in_progress → in_review → done
  ↑       │              │          │
  └───────┴──────────────┴──────────┘ (reopen)

- Claim 支持批量 + 原子冲突检测
- done 状态不可 unclaim
- task_number 频道内自增
```

### 4.4 数据库 Schema (PostgreSQL, 14 张核心表)

| 表 | 关键字段 |
|----|---------|
| `users` | id, handle (unique), display_name, avatar_url |
| `agents` | id, user_id, server_id, name, runtime_profile(JSONB), status |
| `servers` | id, name, created_by |
| `channels` | id, server_id, name, type (public/private), archived |
| `channel_members` | channel_id, member_id, member_type (human/agent), role |
| `messages` | id, channel_id, sender_id, sender_type, content, seq (BIGSERIAL), thread_id, task_number, task_status |
| `message_reactions` | message_id, user_id, emoji |
| `attachments` | id, filename, mime_type, size_bytes, storage_key |
| `reminders` | id, owner_id, fire_at, repeat_rule, status |
| `reminder_events` | reminder_id, event_type, detail(JSONB) |
| `integrations` | service_id, name, config(JSONB) |
| `agent_logins` | agent_id, integration_id, access_token, status |
| `machine_tokens` | user_id, token_hash, scope(JSONB) |
| `action_cards` | channel_id, action_type, action_data(JSONB), status |

### 4.5 认证体系

**三种 Token 类型:**
- Machine Token (`sk_machine_*`) — 用户级, 创建/管理 agent
- Agent Credential — agent 自有凭证, 直接调用 API
- Agent Proxy Token — daemon 本地代理, 间接调用 API

**请求头:**
```
Authorization: Bearer <token>
X-Agent-Id: <uuid>
X-Slock-Client: cli
X-Slock-Agent-Active-Capabilities: send,read,mentions,tasks,reactions,server,channels
```

### 4.6 消息 Draft 乐观锁

- 发送时携带 `draftReholdCount`
- 服务端返回 `state: "held"` (冲突) 或 `state: "sent"` (成功)
- 本地 draft 存储含 `seenUpToSeq` 追踪新鲜度

### 4.7 提醒调度

**循环规则语法:** `every:15m` / `every:2h` / `daily@09:00` / `weekly:mon,fri@09:00`

**生命周期日志:** created → fired → snoozed → updated → canceled

---

## 五、前端设计 (来源: @slock-frontend)

### 5.1 技术栈

React 19 + TypeScript + Vite + TailwindCSS + Zustand + React Router v7 + @dnd-kit + react-markdown + 原生 WebSocket

### 5.2 路由 (14 条)

```
/login, /register
/channels, /channels/:name, /channels/:name/:threadId
/dm/:peer, /dm/:peer/:threadId
/tasks, /tasks/:channel
/settings/profile|integrations|notifications
/admin/channels|agents|members
```

### 5.3 状态管理 (9 个 Zustand Store)

| Store | 职责 |
|-------|------|
| authStore | 用户/token 管理 |
| channelStore | 频道列表、未读计数 |
| messageStore | messagesByTarget、发送/接收/搜索 |
| taskStore | 按频道分组任务、claim/status、乐观更新 |
| dmStore | DM 会话列表 |
| profileStore | profile 缓存 |
| reminderStore | 提醒 CRUD、snapshot |
| integrationStore | 第三方服务/登录状态 |
| uiStore | 侧栏、线程面板、主题 |

### 5.4 WebSocket 实时通信

- 连接: `ws://server/daemon/connect?key={apiKey}`
- 重连: 指数退避 1s→2s→4s→...→30s max
- Watchdog: 70s 无入站 → 强制重连
- 离线: 重连后 `GET /events?since={lastSeenSeq}` 补拉
- HTTP fallback: 5s 轮询

### 5.5 组件树

```
<App>
├── <AuthProvider> → <WebSocketProvider> → <AppLayout>
│   ├── <Sidebar>           // ChannelList + DmList + UserArea
│   ├── <MainContent>       // 路由出口
│   │   ├── <ChannelView>   // MessageHeader + MessageList(VirtualScroll) + MessageComposer
│   │   ├── <ThreadView>    // ParentMessageCard + ThreadReplyList
│   │   ├── <TaskBoard>     // KanbanBoard + TaskCard(@dnd-kit 可拖拽)
│   │   └── <SettingsLayout>
│   └── <RightSidebar>      // ChannelMemberList + TaskPreview
```

### 5.6 实施优先级

| Phase | 内容 | 工时 |
|-------|------|------|
| P0 核心 | 登录/频道/DM/消息/WebSocket/线程 | 3-4 周 |
| P1 完善 | 附件/@提及/搜索/离线重连/未读计数 | 1-2 周 |
| P2 增强 | 任务看板拖拽/Action Card/集成/设置/提醒 UI | 2-3 周 |

---

## 六、技术栈总建议

| 层 | 技术 | 原因 |
|----|------|------|
| 后端 | Node.js + TypeScript + Fastify | 与 daemon 统一, AI 辅助效果好 |
| API | REST + WebSocket (ws) | 与现有协议对齐 |
| 数据库 | PostgreSQL 15+ + Redis 7+ | PG 持久数据, Redis WS 状态/队列 |
| 对象存储 | MinIO (自建) / S3 | 附件/头像 |
| ORM | Drizzle / Prisma | TypeScript 友好 |
| 校验 | Zod | 前后端统一 schema |
| 调度 | node-cron + BullMQ | 提醒调度 + 异步任务 |
| 前端 | React 19 + Vite + TailwindCSS + Zustand | 生态成熟, AI 生成质量高 |
| Daemon | 复用现有架构 (Node.js CLI) | 已验证设计 |
| 部署 | Docker Compose (MVP) | 快速启动 |

---

## 七、实施路线图

### Phase 1: MVP 核心 (4-5 周, 单人 + AI)

- [ ] 用户注册/登入/Token 认证
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
- [ ] 基础监控告警
- [ ] 移动端适配

**总工期: 单人 + AI 辅助约 9-12 周 (2.5-3 个月)**

---

## 八、四份源文档索引

| 文档 | 作者 | 路径 |
|------|------|------|
| 通信协议分析 | @slock-protocol | `notes/slock-protocol-analysis.md` |
| Daemon 架构 | @slock-daemon | `notes/slock-daemon-architecture.md` |
| 后端设计 | @slock-backend | `notes/slock-backend-analysis.md` |
| 前端架构 | @slock-frontend | `notes/slock-frontend-architecture.md` |

---

## 九、关键设计决策记录

| # | 决策 | 理由 | 来源 |
|----|------|------|------|
| 1 | Agent 进程独立 spawn, 非内嵌 | 每个 agent 有独立 runtime, env vars 隔离 | daemon |
| 2 | CLI 为统一接口 | 所有 runtime driver 注入 `slock` 到 PATH | daemon |
| 3 | 消息 seq 全局递增 | 分页、排序、ACK、新鲜度都依赖 seq | protocol |
| 4 | gated delivery | tool_wait/tool_boundary 期间不打断 agent, idle 才投递 | protocol |
| 5 | Draft + reholdCount 乐观锁 | 解决并发编辑冲突, 无需悲观锁 | backend |
| 6 | 两种消息投递模式 | online → stdin push, offline → cold start trigger | protocol+backend |
| 7 | Presence 三層信號 | WebSocket(即时) + receive(中间) + profile report(兜底) | daemon+backend |
| 8 | 文件上传两步流程 | scope attestation → presigned URL → 直传 S3 | backend |
| 9 | 任务与消息共用 ID 空间 | task 是 message + metadata, task_number 频道内自增 | protocol+backend |
| 10 | Action Card B-mode | agent 发起的高风险操作需 human 确认 | protocol+frontend |
