# Slock 复现方案计划书

> 基于 daemon v0.53.2 逆向分析，四维度（协议/后端/daemon/前端）交叉验证
> 分析时间: 2026-05-25

---

## 一、系统架构全景

```
┌──────────────────────────────────────────────────────────────────┐
│                         Slock Server (Node.js)                    │
│                                                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │ Auth Svc │ │Message Svc│ │ Task Svc │ │Reminder  │            │
│  │ JWT/OAuth│ │REST + WS │ │ 状态机   │ │ Scheduler│            │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │Channel   │ │ File Svc │ │Integration│ │ Agent    │            │
│  │Membership│ │ 直传S3   │ │ OAuth代理 │ │ Lifecycle│            │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘            │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │                   WebSocket Gateway                       │    │
│  │  14 种消息类型: agent:start/stop/deliver, reminder.*,     │    │
│  │  machine:*, activity_probe, workspace:*                   │    │
│  └──────────────────────────────────────────────────────────┘    │
└──────────┬──────────────────────────────────────────────┬────────┘
           │ WebSocket (wss://)               │ REST API (/api/*)
           │ Auth: Bearer <token>            │ Auth: Bearer <token>
           │                                 │
┌──────────▼──────────────┐     ┌───────────▼──────────────────────┐
│   Daemon (本地守护进程)   │     │   Web Frontend (React 19 + Vite) │
│   Node.js + TypeScript   │     │                                  │
│                          │     │  ┌──────────┐  ┌──────────────┐ │
│  ┌────────────────────┐  │     │  │ Zustand  │  │ React Router │ │
│  │ AgentProcessManager│  │     │  │ 9 stores │  │ 14 routes    │ │
│  │ - spawn/stop agent  │  │     │  └──────────┘  └──────────────┘ │
│  │ - workspace 管理    │  │     │  ┌──────────┐  ┌──────────────┐ │
│  │ - 8 runtime drivers │  │     │  │TailwindCSS│ │ @dnd-kit     │ │
│  └────────────────────┘  │     │  └──────────┘  └──────────────┘ │
│  ┌────────────────────┐  │     │  ┌────────────────────────────┐ │
│  │ Local Proxy (6381) │  │     │  │ useWebSocket hook          │ │
│  │ 14 条路径重写规则   │  │     │  │ 指数退避重连 + watchdog   │ │
│  └────────────────────┘  │     │  │ HTTP fallback 轮询         │ │
│  ┌────────────────────┐  │     │  └────────────────────────────┘ │
│  │ Chat Bridge (MCP)  │  │     └────────────────────────────────┘
│  │ stdio JSON-RPC 2.0  │  │
│  └────────────────────┘  │
└──────────────────────────┘
```

---

## 二、技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| **后端** | Node.js + TypeScript + Fastify | 与 daemon 统一技术栈，AI 辅助效果最优 |
| **数据库** | PostgreSQL 15 + Redis 7 | PG 持久数据，Redis 消息队列/WS 状态 |
| **文件存储** | MinIO (自建) 或 S3 | 附件/头像，presigned URL 直传 |
| **Daemon** | Node.js CLI (commander + ws + undici) | 复用已验证架构 |
| **AI Runtime** | Claude (Anthropic)，stdio MCP 桥接 | 主要 runtime |
| **前端** | React 19 + Vite + TailwindCSS + Zustand | 生态成熟 |
| **部署** | Docker Compose (MVP) → K8s (规模化) | 渐进式 |

---

## 三、后端设计（@slock-backend）

### 3.1 API 路由结构

```
/api/*                      → 用户/Web 端
/internal/agent/{id}/*      → Agent 端 (daemon 调用)
/internal/machine/*          → 机器认证
/internal/agent-api/*        → 本地代理内部路径
```

### 3.2 完整 API 端点 (28 个，14 条路径重写规则)

**消息 (7)**:
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/internal/agent/{id}/send` | 发送消息 (content, target, draftReholdCount) |
| GET | `/internal/agent/{id}/receive` | 接收消息 (block, timeout 长轮询) |
| POST | `/internal/agent/{id}/receive-ack` | ACK 确认 (seqs[]) |
| GET | `/internal/agent/{id}/history` | 历史消息 (channel, before/after/around/limit) |
| GET | `/internal/agent/{id}/search` | 搜索 (q, channel, sender, sort) |
| POST | `/internal/agent/{id}/messages/{mid}/reactions` | 添加反应 |
| DELETE | `/internal/agent/{id}/messages/{mid}/reactions` | 移除反应 |

**频道 (6)**:
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/internal/agent/{id}/server` | 服务器信息 (channels, agents, humans) |
| GET | `/internal/agent/{id}/channel-members` | 成员列表 |
| POST | `/internal/agent/{id}/channels/{ch}/join` | 加入频道 |
| POST | `/internal/agent/{id}/channels/{ch}/leave` | 离开频道 |
| POST | `/internal/agent/{id}/threads/unfollow` | 取消关注线程 |
| GET | `/internal/agent/{id}/resolve-channel` | 解析频道引用 |

**任务 (5)**:
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/internal/agent/{id}/tasks` | 列表 (channel, status) |
| POST | `/internal/agent/{id}/tasks` | 创建 (channel, tasks[{title}]) |
| POST | `/internal/agent/{id}/tasks/claim` | 认领 (task_numbers, message_ids) |
| POST | `/internal/agent/{id}/tasks/unclaim` | 放弃 |
| POST | `/internal/agent/{id}/tasks/update-status` | 更新状态 |

**提醒 (7)**:
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/internal/agent/{id}/reminders` | 创建 (title, delaySeconds/fireAt, repeat) |
| GET | `/internal/agent/{id}/reminders` | 列表 (status) |
| GET | `/internal/agent/{id}/reminders/{rid}` | 查看 |
| PATCH | `/internal/agent/{id}/reminders/{rid}` | 更新 |
| POST | `/internal/agent/{id}/reminders/{rid}/snooze` | 延迟 |
| DELETE | `/internal/agent/{id}/reminders/{rid}` | 取消 |
| GET | `/internal/agent/{id}/reminders/{rid}/log` | 事件日志 |

**其他 (3)**:
| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/internal/agent/{id}/profile` | 查看/更新资料 |
| GET/POST | `/internal/agent/{id}/integrations` | 集成管理 |
| POST | `/internal/agent/{id}/prepare-action` | Action Card |

### 3.3 数据库 Schema (12 张核心表)

```
users                — 用户 (handle, display_name, avatar_url)
agents               — AI 代理 (user_id, server_id, runtime_profile, status)
servers              — 服务器
channels             — 频道 (server_id, name, type: public/private, archived)
channel_members      — 频道成员 (channel_id, member_id, member_type, role)
messages             — 消息 (channel_id, sender_id, content, seq, thread_id, task_*)
message_reactions    — 消息反应 (message_id, user_id, emoji)
attachments          — 附件 (storage_key, mime_type, size_bytes)
message_attachments  — 消息-附件关联
reminders            — 提醒 (owner_id, fire_at, repeat_rule, status)
reminder_events      — 提醒事件日志
machine_tokens       — 机器凭证 (token_hash, scope)
agent_credentials    — Agent 凭证 (agent_id, token_hash)
integrations         — 第三方服务
agent_logins         — Agent 集成登录
action_cards         — 操作审批卡片
```

### 3.4 认证体系

```
Token 三种类型:
  sk_machine_*      → 机器级 (用户身份，管理 agent/daemon)
  Agent Credential  → Agent 级 (API 调用，受限范围)
  Agent Proxy Token → 本地代理 (daemon ↔ agent 通信)

三种 clientMode:
  managed-runner     → daemon 本地代理注入 token
  self-hosted-runner → agent 自有凭证文件
  legacy-machine     → 传统 token 文件/环境变量

请求头:
  Authorization: Bearer <token>
  X-Agent-Id: <uuid>
  X-Slock-Client: cli
  X-Slock-Agent-Active-Capabilities: send,read,mentions,tasks,reactions,server,channels
```

### 3.5 消息系统

```
三种消息模型:
  #channel               → 频道群聊
  dm:@peer               → 私聊
  #channel:shortid       → 频道内线程

消息格式: [target=#general msg=a1b2c3d4 time=ISO8601 type=human] @sender: content

seq 机制: 全局递增序列号 → 排序、去重、ACK、分页游标
发送流程: draft → freshness check (draftReholdCount 乐观锁) → held/sent
接收流程: 长轮询 (block/timeout) + WebSocket 实时推送 + ACK 确认
```

---

## 四、通信协议（@slock-protocol）

### 4.1 WebSocket 入站流水线

```
inbound_received → agent.delivery → delivery.routed
  ├─ online:  stdin_idle_delivery → outcome: "written"
  └─ offline: rejected_no_process → cold start trigger

Gate Steering 四阶段:
  assistant_continuation → tool_wait → tool_boundary → idle
  仅 idle 阶段安全投递新消息，其他阶段走 gated delivery
```

### 4.2 DaemonConnection 消息类型 (14 种)

| 类型 | 方向 | 说明 |
|---|---|---|
| `agent:start` | server→daemon | 启动 agent |
| `agent:stop` | server→daemon | 停止 agent |
| `agent:deliver` | server→daemon | 投递消息到 agent |
| `agent:reset-workspace` | server→daemon | 重置工作区 |
| `agent:runtime_profile:migration` | server→daemon | Profile 迁移 |
| `agent:workspace:list` | server→daemon | 列出工作区文件 |
| `agent:workspace:read` | server→daemon | 读取工作区文件 |
| `agent:skills:list` | server→daemon | 列出 skills |
| `agent:activity_probe` | server→daemon | 健康检查 |
| `machine:workspace:delete` | server→daemon | 删除工作区 |
| `machine:runtime_models:detect` | server→daemon | 检测可用模型 |
| `reminder.upsert` | server→daemon | 提醒同步 |
| `reminder.cancel` | server→daemon | 取消提醒 |
| `reminder.snapshot` | server→daemon | 全量提醒同步 |

### 4.3 Turn 生命周期

```
turn.started → input.prepared → event.received (×N) → turn.completed
  Events: session_init → thinking → text → tool_call → tool_output → turn_end
  指标: duration_ms, events_count, tool_calls_count
```

### 4.4 Presence (三层信号)

```
Layer 1: WebSocket 连接状态              → 即时 (秒级)
Layer 2: receive 长轮询                  → 中间信号
Layer 3: runtime_profile.report.sent     → 兜底 (分钟级超时)
         携带: model_present, session_ref_present, workspace_ref_present
```

---

## 五、Daemon 架构（@slock-daemon）

### 5.1 核心组件

```
DaemonCore
├── AgentProcessManager    — 创建 workspace + spawn agent 进程
├── DaemonConnection       — WebSocket 连接服务器 (14 种消息类型)
├── Runtime Drivers (8)    — claude/codex/antigravity/kimi/copilot/cursor/gemini/opencode
├── Local Proxy (:6381)    — 14 条路径重写规则，agent 请求转发
├── Chat Bridge (MCP)      — stdio JSON-RPC 2.0，agent ↔ runtime 通信
├── Trace Sink             — LocalRotatingTraceSink (5MB/5min/8files)
└── Reminder Cache         — 内存缓存，fire 回调
```

### 5.2 CLI — 29 个子命令，11 个分组

```
auth (1)     — whoami
channel (3)  — members, join, leave
thread (1)   — unfollow
server (1)   — info
message (5)  — send, check, read, search, react
attachment (2) — upload, view
task (5)     — list, create, claim, unclaim, update
profile (2)  — show, update
integration (2) — list, login
reminder (6) — schedule, list, cancel, snooze, update, log
action (1)   — prepare
```

### 5.3 Agent 进程管理

```
启动流程: start.requested → queued → dequeued → spawn.started → spawn.created → slot_released
约束: max 5 concurrent starts, min 500ms interval
Transport: 生成 shell wrapper → 注入 auth env vars → spawn runtime
```

---

## 六、前端架构（@slock-frontend）

### 6.1 组件树

```
<App>
├── <AuthProvider> → <WebSocketProvider> → <AppLayout>
│   ├── <Sidebar>          // ChannelList + DmList + UserArea
│   ├── <MainContent>      // 路由出口
│   │   ├── <ChannelView>  // MessageList + MessageComposer
│   │   ├── <DmView>
│   │   ├── <ThreadView>   // ParentMessageCard + ReplyList
│   │   ├── <TaskBoard>    // 四列看板 (todo/in_progress/in_review/done)
│   │   └── <SettingsLayout>
│   └── <RightSidebar>     // 成员列表 + 任务预览
```

### 6.2 路由 (14 条)

```
/channels, /channels/:name, /channels/:name/:threadId
/dm/:peer, /dm/:peer/:threadId
/tasks, /tasks/:channel
/settings/profile|integrations|notifications
/admin/channels|agents|members
/login, /register
```

### 6.3 状态管理 (Zustand, 9 stores)

```
authStore, channelStore, messageStore, taskStore, dmStore,
profileStore, reminderStore, integrationStore, uiStore
```

### 6.4 WebSocket 实时通信

```
连接: ws://{host}/daemon/connect?key={apiKey}
重连: 指数退避 1s→2s→4s→...→30s max
Watchdog: 70s 无入站 → 强制重连
离线降级: 重连后 GET /events?since={lastSeenSeq} 补拉
HTTP fallback: WS 不可用时 5s 轮询
数据流: WS → MessageRouter → Zustand Stores → React Components
```

---

## 七、实施路线图

### Phase 1: MVP 核心 (4–5 周，单人 + AI)

```
后端:
  ✓ 用户注册/登录 (JWT + bcrypt)
  ✓ Machine Token 认证体系
  ✓ 频道 CRUD + 成员管理 (public/private)
  ✓ 消息发送/接收/历史/搜索 (三层模型: 频道/DM/线程)
  ✓ WebSocket 实时推送 + ACK 机制 + 离线补拉
  ✓ 文件附件上传 (scope attestation → presigned URL)
  ✓ Agent 端点 (/internal/agent/{id}/*)

Daemon:
  ✓ CLI 核心命令 (server info, message send/read, channel join/leave)
  ✓ 本地代理 (HTTP proxy :6381 + 路径重写)
  ✓ Claude runtime 适配 (stdio MCP 桥接)
  ✓ Agent workspace 管理 + spawn 流程

前端:
  ✓ 登录/注册页
  ✓ 频道视图 (消息列表 + 输入框)
  ✓ DM 视图
  ✓ 线程视图
  ✓ WebSocket hook + 重连策略
```

### Phase 2: 协作功能 (3–4 周)

```
后端:
  ✓ 任务系统 (状态机 + 原子 claim + 批量操作)
  ✓ @提及通知
  ✓ Action Card (B-mode 审批)
  ✓ Agent 生命周期管理 (presence 三层信号)
  ✓ 提醒系统 (绝对/相对/循环 + 事件日志)

Daemon:
  ✓ 完整 29 命令
  ✓ Draft 系统 (TTL + seenUpToSeq 乐观锁)
  ✓ 多 runtime driver 基础支持

前端:
  ✓ 任务看板 (四列拖拽 + 乐观更新)
  ✓ 附件上传/预览
  ✓ @提及高亮 + 内联链接
  ✓ Action Card UI
  ✓ 设置页 (profile + notifications)
```

### Phase 3: 完善与稳定 (2–3 周)

```
后端:
  ✓ 全文搜索 (PostgreSQL tsvector)
  ✓ 数据定时备份
  ✓ 基础监控 + 错误告警
  ✓ 集成服务 (OAuth 代理)

Daemon:
  ✓ Trace 上传 + 可观测性
  ✓ 断线重连优化

前端:
  ✓ 离线消息补拉完善
  ✓ 移动端基础适配
  ✓ 代码高亮 + Markdown 完整渲染
```

---

## 八、总工时估算

| 方案 | Phase 1 | Phase 2 | Phase 3 | 总计 |
|---|---|---|---|---|
| **单人 + AI** | 4–5 周 | 3–4 周 | 2–3 周 | **9–12 周** |
| **2 人 + AI** | 3–4 周 | 2–3 周 | 1–2 周 | **6–9 周** |
| **3 人 + AI** | 2–3 周 | 1.5–2 周 | 1 周 | **4.5–6 周** |

---

## 九、交叉引用索引

| 文档 | 路径 | 专注领域 |
|---|---|---|
| 协议分析 | @slock-protocol `notes/slock-protocol-analysis.md` | 消息格式、WS 流水线、Turn 模型、ACK、Trace |
| 后端分析 | @slock-backend `notes/slock-backend-analysis.md` | API 路由、DB Schema、认证、消息/任务/提醒 |
| Daemon 分析 | @slock-daemon `notes/slock-daemon-architecture.md` | CLI 实现、Runtime Driver、代理、进程管理 |
| 前端分析 | @slock-frontend `notes/slock-frontend-architecture.md` | 组件树、路由、Zustand Store、WS Hook |
| **汇总文档** | @slock-backend `notes/slock-replication-plan.md` (本文件) | 完整复现方案 |
