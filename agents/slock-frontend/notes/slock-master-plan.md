# Slock 复现方案计划书

> 基于 Slock Daemon v0.53.2 逆向分析，综合四份专项分析文档，形成完整复现方案
> 生成时间: 2026-05-25

---

## 目录

1. [架构全景](#一架构全景)
2. [数据模型](#二数据模型)
3. [通信协议](#三通信协议)
4. [服务端 API 设计](#四服务端-api-设计)
5. [数据库 Schema](#五数据库-schema)
6. [本地 Daemon 设计](#六本地-daemon-设计)
7. [前端 UI 设计](#七前端-ui-设计)
8. [认证体系](#八认证体系)
9. [关键技术决策](#九关键技术决策)
10. [实施路线图](#十实施路线图)

---

## 一、架构全景

```
┌──────────────────────────────────────────────────────────────────┐
│                         Web 前端 (React 19 + Vite + TailwindCSS)  │
│  WebSocket 实时连接 ─── REST API 调用 ─── 文件上传                │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│                    Slock Server (Node.js + TypeScript)            │
│                                                                   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐    │
│  │ 认证服务 │ │ 消息服务 │ │ 任务服务 │ │ 提醒调度器       │    │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐    │
│  │ 频道服务 │ │ 文件服务 │ │ 集成服务 │ │ Agent 管理       │    │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘    │
│                                                                   │
│  数据层: PostgreSQL + Redis + S3/MinIO                           │
└────────────┬──────────────┬──────────────────────────────────────┘
             │ REST API     │ WebSocket (wss://)
             │              │
┌────────────▼──────────────▼──────────────────────────────────────┐
│                    Slock Daemon (Node.js, 本地守护进程)           │
│                                                                   │
│  ┌─────────────────┐  ┌────────────────────────────────────┐    │
│  │ DaemonCore       │  │ AgentProcessManager               │    │
│  │ - start/stop     │  │ - create workspace                │    │
│  │ - message route  │  │ - prepareCliTransport             │    │
│  │ - reminder cache │  │ - spawn runtime driver            │    │
│  │ - trace sink     │  │ - monitor lifecycle               │    │
│  └─────────────────┘  └──────────────┬─────────────────────┘    │
│                                       │                           │
│  ┌────────────────────────────────────▼──────────────────────┐   │
│  │ Runtime Drivers (8种): claude | codex | gemini | kimi ... │   │
│  └───────────────────────────────────────────────────────────┘   │
└────────────────────────────┬─────────────────────────────────────┘
                             │ spawn + env (stdio/stdin)
┌────────────────────────────▼─────────────────────────────────────┐
│                    AI Runtime (Claude / Codex / ...)              │
│                                                                   │
│  ┌──────────────────────┐  ┌─────────────────────────────────┐   │
│  │ slock CLI (29 命令)  │  │ chat-bridge.js (MCP stdio)      │   │
│  └──────────────────────┘  └─────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### 核心交互流程

```
1. 用户在 Web UI 发送消息
   → POST /api/messages → 服务端持久化 + 分配 seq
   → WebSocket 广播给目标频道所有在线 daemon

2. Daemon 收到 agent:deliver
   → 路由到对应 Agent 进程
   → 在线: stdin 投递 (gated delivery)
   → 离线: cold start (spawn agent 进程)

3. Agent 处理完后发送回复
   → slock message send → daemon proxy → 服务端 API
   → 服务端持久化 + WebSocket 广播

4. Web UI 通过 WebSocket 实时收到新消息
   → 更新消息列表 + 发送 ACK
```

---

## 二、数据模型

### 核心实体

| 实体 | 说明 | 关键字段 |
|---|---|---|
| **User** | 人类用户 | id, handle, displayName, email |
| **Agent** | AI 代理 | id, name, displayName, runtimeProfile, status |
| **Server** | 服务器/工作空间 | id, name, createdBy |
| **Channel** | 频道 | id, name, type(public/private), serverId |
| **Message** | 消息 | id, channelId, senderId, senderType, content, seq |
| **Task** | 任务 (消息子类型) | taskNumber, taskStatus, taskAssignee |
| **Thread** | 线程 (消息子集) | parentMessageId, channelId |
| **Reminder** | 提醒 | id, ownerId, title, fireAt, repeatRule, status |
| **Attachment** | 附件 | id, filename, mimeType, sizeBytes, storageKey |
| **Reaction** | 消息反应 | messageId, userId, emoji |
| **ActionCard** | 审批卡片 | actionType, actionData, status(pending/approved/rejected) |

### 消息 Target 格式

| 格式 | 类型 | 示例 |
|---|---|---|
| `#channel-name` | 频道 | `#general` |
| `dm:@peer-name` | 私信 | `dm:@alice` |
| `#channel:shortId` | 频道线程 | `#general:a1b2c3d4` |
| `dm:@peer:shortId` | 私信线程 | `dm:@alice:x9y8z7a0` |

### 消息头格式 (RFC 5424-style)

```
[target=#general msg=a1b2c3d4 time=2026-03-15T01:00:00 type=human] @sender: content
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `target` | string | 消息来源目标 |
| `msg` | UUID(8) | 消息短 ID，用作线程后缀 |
| `time` | ISO 8601 | 时间戳 |
| `type` | enum | `human` / `agent` / `system` |

### 消息 seq 序列号

- 全局递增，用于排序、去重、分页、ACK 确认
- ACK 格式: `agent:deliver:ack { seq, deliveryId?, traceparent? }`
- 分页游标: `?before=<seq>` / `?after=<seq>`

---

## 三、通信协议

### 3.1 WebSocket 连接

```
连接端点: wss://{server}/daemon/connect?key={apiKey}
消息格式: JSON
心跳: ping/pong
重连: 指数退避 1s→2s→4s→...→30s max
Watchdog: 70s 无入站消息 → ws.terminate() → 重连
```

### 3.2 Server → Daemon 消息类型 (14种)

| type | 说明 |
|---|---|
| `agent:start` | 启动 agent (携带 config, wakeMessage, sessionId) |
| `agent:stop` | 停止 agent |
| `agent:deliver` | 投递消息 (携带 seq, message, deliveryId) |
| `agent:reset-workspace` | 重置工作区 |
| `agent:runtime_profile:migration` | Profile 迁移 |
| `agent:runtime_profile:daemon_release_notice` | 版本通知 |
| `agent:workspace:list` | 列出工作区文件 |
| `agent:workspace:read` | 读取工作区文件 |
| `agent:skills:list` | 列出技能 |
| `agent:activity_probe` | 健康检查探针 |
| `machine:workspace:scan` | 扫描工作区目录 |
| `machine:workspace:delete` | 删除工作区目录 |
| `machine:runtime_models:detect` | 检测可用模型 |
| `reminder.upsert / cancel / snapshot` | 提醒同步 (3种子类型) |

### 3.3 Daemon → Server 消息类型 (16种)

| type | 说明 |
|---|---|
| `ready` | 握手 (capabilities, runtimes, hostname, os, daemonVersion) |
| `agent:status` | 状态上报 (online/offline/working/error) |
| `agent:activity` | 活动上报 (activity, detail, entries) |
| `agent:session` | 会话关联 (sessionId) |
| `agent:deliver:ack` | 消息确认 (seq) |
| `agent:runtime_profile` | Profile 上报 |
| `agent:workspace:file_tree / file_content` | 文件树/内容 |
| `agent:skills:list_result` | 技能列表 |
| `machine:workspace:scan_result / delete_result` | 工作区操作结果 |
| `machine:runtime_models:result` | 模型列表 |
| `reminder.fire_attempt` | 提醒触发尝试 |
| `reminder.snapshot.request` | 请求全量同步 |
| `pong` | 心跳回复 |

### 3.4 Agent 消息投递流水线

```
WebSocket IN
  → daemon.connection.inbound_received
  → daemon.agent.delivery (consumer span)
    → daemon.agent.delivery.routed
      → outcome: "stdin_idle_delivery" (在线)
        → daemon.agent.stdin_delivery → written to stdin
      → outcome: "rejected_no_process" (离线)
        → daemon.agent.start.requested → queued → spawned → cold start
  → daemon.agent.deliver:ack sent
```

### 3.5 Turn 生命周期 (Gate Steering)

| Phase | 含义 | 消息投递策略 |
|---|---|---|
| `assistant_continuation` | AI 正在生成响应 | 排队 |
| `tool_wait` | 等待工具执行 | 排队 |
| `tool_boundary` | 工具执行完成 | 排队 |
| `idle` | Turn 结束，等待新消息 | 投递 |

---

## 四、服务端 API 设计

### 4.1 路由分层

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
| `POST` | `/api/messages` | 发送消息 |
| `GET` | `/api/messages` | 读取历史 (Query: channel, before, after, limit) |
| `GET` | `/api/messages/search` | 搜索 (Query: q, channel, sender, sort) |
| `POST` | `/api/messages/{id}/reactions` | 添加反应 |
| `DELETE` | `/api/messages/{id}/reactions` | 移除反应 |

#### 频道

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/server/info` | 服务器信息 |
| `GET` | `/api/channels/{name}/members` | 频道成员 |
| `POST` | `/api/channels/{name}/join` | 加入频道 |
| `POST` | `/api/channels/{name}/leave` | 离开频道 |
| `POST` | `/api/channels` | 创建频道 |
| `POST` | `/api/threads/unfollow` | 取消关注线程 |

#### 任务

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/tasks` | 列出任务 (Query: channel, status) |
| `POST` | `/api/tasks` | 创建任务 |
| `POST` | `/api/tasks/claim` | 认领任务 |
| `POST` | `/api/tasks/unclaim` | 放弃任务 |
| `PATCH` | `/api/tasks/{number}` | 更新状态 |

#### 提醒

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/reminders` | 创建提醒 |
| `GET` | `/api/reminders` | 列出提醒 |
| `PATCH` | `/api/reminders/{id}` | 更新提醒 |
| `POST` | `/api/reminders/{id}/snooze` | 延迟提醒 |
| `DELETE` | `/api/reminders/{id}` | 取消提醒 |
| `GET` | `/api/reminders/{id}/log` | 事件日志 |

#### 附件

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/uploads` | 创建上传会话 (scope attestation) |
| `GET` | `/api/attachments/{id}` | 下载附件 |

#### 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/auth/register` | 用户注册 |
| `POST` | `/api/auth/login` | 用户登录 |
| `POST` | `/api/auth/token/refresh` | 刷新 token |

### 4.3 请求头

```
Authorization: Bearer <token>
X-Agent-Id: <agent-uuid>
X-Slock-Client: cli | web
X-Server-Id: <server-uuid>
X-Agent-Launch-Id: <launch-uuid>
X-Slock-Agent-Active-Capabilities: send,read,mentions,tasks,reactions,server,channels
```

---

## 五、数据库 Schema

### 5.1 核心表

```
users                    — 用户
agents                   — AI 代理
servers                  — 服务器
channels                 — 频道
channel_members          — 频道成员关系
messages                 — 消息 (含 task 元数据)
message_reactions        — 消息反应
attachments              — 附件
message_attachments      — 消息-附件关联
reminders                — 提醒
reminder_events          — 提醒事件日志
integrations             — 第三方集成
agent_logins             — Agent 第三方登录
machine_tokens           — 机器 token
agent_credentials        — Agent 凭证
action_cards             — 审批卡片
```

### 5.2 关键索引

```sql
-- 消息按频道+seq 排序
CREATE INDEX idx_messages_channel_seq ON messages (channel_id, seq DESC);
-- 线程消息
CREATE INDEX idx_messages_thread ON messages (thread_id) WHERE thread_id IS NOT NULL;
-- 全文搜索
CREATE INDEX idx_messages_search ON messages USING GIN (to_tsvector('english', content));
-- 任务状态过滤
CREATE INDEX idx_messages_task_status ON messages (channel_id, task_status) WHERE task_number IS NOT NULL;
-- 提醒定时扫描
CREATE INDEX idx_reminders_status_fire ON reminders (status, fire_at) WHERE status = 'scheduled';
```

---

## 六、本地 Daemon 设计

### 6.1 核心模块

| 模块 | 文件 | 功能 |
|---|---|---|
| DaemonCore | chunk-UIJF67BT.js | 启动/停止/消息路由/提醒缓存/trace sink |
| AgentProcessManager | chunk-UIJF67BT.js | Agent 生命周期管理 (create/spawn/monitor/stop) |
| DaemonConnection | chunk-UIJF67BT.js | WebSocket 连接管理 (重连/watchdog/消息收发) |
| ApiClient | cli/index.js | HTTP 客户端 (路径重写/认证/错误处理) |
| ChatBridge | chat-bridge.js | MCP stdio 桥接 (1个工具) |
| Runtime Drivers | chunk-UIJF67BT.js | 8种 runtime 适配 (claude/codex/gemini/kimi...) |

### 6.2 Agent 双认证路径

| 模式 | 说明 | 适用场景 |
|---|---|---|
| **managed-runner** | daemon 持有真实 API key，agent 通过本地代理 (127.0.0.1:6381) 通信 | 平台管理 agent |
| **self-hosted-runner** | agent 直接持有 credential，直连 server API | 用户自部署 agent |

### 6.3 CLI 命令体系 (11组 29子命令)

| 组 | 子命令数 | 功能范围 |
|---|---|---|
| auth | 1 | 身份自检 |
| channel | 3 | 频道成员/加入/离开 |
| thread | 1 | 取消关注线程 |
| server | 1 | 服务器信息 |
| message | 5 | 发送/检查/读取/搜索/反应 |
| attachment | 2 | 上传/下载 |
| task | 5 | 列表/创建/认领/放弃/更新 |
| profile | 2 | 查看/更新资料 |
| integration | 2 | 列出/登录集成 |
| reminder | 6 | 创建/列表/取消/延迟/更新/日志 |
| action | 1 | 创建审批卡片 |

---

## 七、前端 UI 设计

### 7.1 技术栈

| 层 | 选型 |
|---|---|
| 框架 | React 19 + TypeScript |
| 构建 | Vite |
| 样式 | TailwindCSS |
| 路由 | React Router v7 |
| 状态管理 | Zustand (9 个 Store) |
| 实时通信 | 原生 WebSocket hook |
| Markdown | react-markdown + rehype-highlight |
| 拖拽 | @dnd-kit/core |
| 表单 | React Hook Form + Zod |

### 7.2 组件树

```
<App>
├── <AuthProvider>
├── <WebSocketProvider>
├── <AppLayout>
│   ├── <Sidebar>
│   │   ├── <ChannelList>
│   │   ├── <DmList>
│   │   └── <UserArea>
│   ├── <MainContent> (路由出口)
│   │   ├── <ChannelView>
│   │   │   ├── <MessageHeader>
│   │   │   ├── <MessageList> (虚拟滚动)
│   │   │   ├── <MessageComposer>
│   │   │   └── <ThreadPanel>
│   │   ├── <ThreadView>
│   │   ├── <TaskBoard> (看板 + 拖拽)
│   │   ├── <SettingsLayout>
│   │   └── <LoginPage>
│   └── <RightSidebar>
│       ├── <MemberList>
│       └── <TaskPreview>
```

### 7.3 路由设计 (14条)

```
/channels/:name                    → 频道消息
/channels/:name/:threadId          → 频道线程
/dm/:peer                          → DM 消息
/dm/:peer/:threadId                → DM 线程
/tasks                             → 全局任务看板
/tasks/:channel                    → 频道任务看板
/settings/profile|integrations     → 设置
/admin/channels|agents|members     → 管理后台
/login|/register                   → 认证
```

### 7.4 Zustand Store 架构 (9个)

| Store | 核心职责 |
|---|---|
| `authStore` | 用户/Token/登录状态 |
| `channelStore` | 频道列表/joined状态/未读计数 |
| `messageStore` | messagesByTarget/收发/搜索/reaction |
| `taskStore` | 按频道分组任务/claim/状态流转/乐观更新 |
| `dmStore` | DM 会话列表 |
| `profileStore` | 用户 profile 缓存 |
| `reminderStore` | 提醒 CRUD/snapshot 同步 |
| `integrationStore` | 第三方服务列表 |
| `uiStore` | 侧栏/线程面板/主题 |

### 7.5 WebSocket Hook 设计

```
useWebSocket({ serverUrl, apiKey, onMessage, onConnect, onDisconnect })
  → isConnected / lastMessage / send() / reconnectAttempt
  → 重连: 指数退避 1s→30s max
  → Watchdog: 70s 超时 → 强制重连
  → 离线降级: 5s HTTP 轮询 fallback
  → 消息路由: 14 种 server→client 类型分发
```

### 7.6 任务状态流转 UI

```
todo → in_progress → in_review → done
  ↑       │              │         │
  └───────┴──────────────┴─────────┘ (reopen)

UI 操作:
- Claim → todo→in_progress
- Start → in_progress
- Submit Review → in_review
- Approve (human) → done
- Reopen → 任意状态→todo
```

---

## 八、认证体系

### 8.1 Token 层次

```
Machine Token (sk_machine_*)
  → 用户认证，创建/管理 agent
  │
  ├── Agent Credential (agent 文件)
  │     → Agent 自有凭证，直连 server
  │
  └── Agent Proxy Token
        → daemon 本地代理用，agent 不持有真实 key
```

### 8.2 认证头注入流程

```
Agent CLI → 本地 Proxy (127.0.0.1:6381) → Slock Server
  Bearer <proxy_token>            Bearer <real_api_key>
                                  X-Agent-Id: <id>
                                  X-Slock-Client: cli
                                  X-Slock-Agent-Active-Capabilities: ...
```

### 8.3 错误码体系

| 前缀 | 层级 | HTTP |
|---|---|---|
| `MISSING_*` / `TOKEN_*` | 本地认证引导 | — |
| `*_FAILED` | 服务端 4xx | 400–499 |
| `SERVER_5XX` | 服务端崩溃 | 500–599 |

---

## 九、关键技术决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | 后端 Node.js + TypeScript | 与 daemon 统一栈，AI 生成质量最高 |
| 2 | REST + WebSocket 双通道 | REST 做 CRUD，WS 做实时推送 |
| 3 | 全局递增 seq + ACK | 消息有序、去重、可靠投递 |
| 4 | Agent 独立进程 (spawn) | 隔离性强，支持多 runtime |
| 5 | CLI 作为通用接口 | 所有 runtime 注入相同 `slock` 命令 |
| 6 | Gated Delivery (门控投递) | AI 思考期间不打断，idle 阶段才投递 |
| 7 | Draft + Freshness 机制 | 解耦发送与送达，seenUpToSeq 冲突检测 |
| 8 | 文件两步上传 (attestation → presigned URL) | 安全，daemon API key 不暴露给 worker |
| 9 | MCP 桥接最小化 | 真正的通信工具由 runtime 原生暴露 |
| 10 | 前端 Zustand (非 Redux) | 轻量、TS 友好、按域拆分 store |
| 11 | PostgreSQL 全文搜索 (非 ES) | MVP 足够，10 人团队无性能压力 |
| 12 | 单文件部署 daemon | 无 node_modules，约 1MB |

---

## 十、实施路线图

### Phase 1: MVP 核心 (4–5 周，单人 + AI)

**后端：**
- [ ] 用户注册/登录/Token 认证
- [ ] 频道 CRUD + 成员管理
- [ ] 消息发送/读取/搜索 (频道 + DM + 线程)
- [ ] WebSocket 连接管理 + 实时推送 + ACK
- [ ] 离线消息补拉 (since=lastSeenSeq)
- [ ] 基础任务系统 (状态机 + claim 冲突检测)

**Daemon:**
- [ ] DaemonCore 启动/停止流程
- [ ] WebSocket 连接 + 重连 + watchdog
- [ ] Claude runtime driver
- [ ] HTTP 本地代理 (token 注入)
- [ ] CLI 核心命令 (message send/check/read, task list/claim, server info)

**前端:**
- [ ] 登录/注册页
- [ ] 频道列表 + 频道消息视图 (MessageList + Composer)
- [ ] DM 消息视图
- [ ] 线程视图 (ThreadPanel + ThreadView)
- [ ] WebSocket 实时消息推送
- [ ] Markdown 渲染 + @mention 高亮

### Phase 2: 协作功能 (3–4 周)

**后端：**
- [ ] 文件附件上传/下载
- [ ] @提及通知
- [ ] Action Card 审批流
- [ ] Agent 管理器 (注册/生命周期/在线状态)
- [ ] 消息反应 (reactions)

**Daemon:**
- [ ] 完整 CLI (29 命令)
- [ ] Agent workspace 管理
- [ ] System prompt 动态生成
- [ ] Trace 收集与上传

**前端:**
- [ ] 附件预览 (图片 lightbox + 文件下载)
- [ ] 任务看板 (看板视图 + 拖拽 + 批量操作)
- [ ] Action Card UI
- [ ] 消息搜索
- [ ] 离线重连优化 + 未读计数
- [ ] 代码语法高亮

### Phase 3: 完善与稳定 (2–3 周)

**后端：**
- [ ] 提醒调度器
- [ ] 第三方集成 (OAuth)
- [ ] 数据备份
- [ ] 基础监控/告警
- [ ] 全文搜索优化

**前端：**
- [ ] 设置页面 (Profile/Integrations/Notifications)
- [ ] 管理后台 (Channels/Agents/Members)
- [ ] 提醒管理 UI
- [ ] 移动端适配
- [ ] 暗色主题

### 工时汇总

| 层 | Phase 1 | Phase 2 | Phase 3 | 合计 |
|---|---|---|---|---|
| 后端 | 2–3 周 | 1.5–2 周 | 1–1.5 周 | 4.5–6.5 周 |
| Daemon | 1.5–2 周 | 1–1.5 周 | 0.5 周 | 3–4 周 |
| 前端 | 2–3 周 | 1.5–2 周 | 1–1.5 周 | 4.5–6.5 周 |

**并行总工期 (单人+AI): ~10–13 周 (约 2.5–3 个月)**
**并行总工期 (3人+AI): ~4–6 周**

---

## 附录

### A. 参考文档

| 文档 | 作者 | 路径 |
|---|---|---|
| 通信协议分析 | @slock-protocol | `agents/8d771866.../notes/slock-protocol-analysis.md` |
| 后端设计分析 | @slock-backend | `agents/72a1fa03.../notes/slock-backend-analysis.md` |
| Daemon 架构分析 | @slock-daemon | `agents/b5f59bdf.../notes/slock-daemon-architecture.md` |
| 前端架构方案 | @slock-frontend | `agents/88a522cd.../notes/slock-frontend-architecture.md` |

### B. 关键依赖

| 依赖 | 版本 | 用途 |
|---|---|---|
| commander | ^14 | CLI 命令框架 |
| zod | ^4 | Schema 验证 |
| undici | ^7 | HTTP 代理 |
| ws | ^8 | WebSocket 客户端 |
| @modelcontextprotocol/sdk | ^1 | MCP 协议 |
| react | ^19 | 前端框架 |
| zustand | ^5 | 状态管理 |
| tailwindcss | ^4 | 样式框架 |
| @dnd-kit/core | ^6 | 拖拽 |

### C. 环境变量

| 变量 | 用途 |
|---|---|
| `SLOCK_HOME` | 持久化数据目录 (默认 `~/.slock`) |
| `SLOCK_AGENT_PROXY_URL` | Agent 代理地址 (`http://127.0.0.1:6381`) |
| `SLOCK_AGENT_PROXY_TOKEN_FILE` | 代理 token 文件路径 |
| `SLOCK_AGENT_ACTIVE_CAPABILITIES` | Agent 能力声明 (CSV) |
| `FORCE_COLOR=0` | CI 友好输出 |
| `WSS_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` | 网络代理 |
| `NO_PROXY` | 代理绕过规则 |
