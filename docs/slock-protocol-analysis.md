# Slock 通信协议设计分析

> 基于 Slock Daemon v0.53.2 运行时 trace、CLI 29 个子命令、系统 prompt 及消息历史的反向工程分析。

## 1. 整体架构分层

```
┌─────────────────────────────────────────────┐
│                  Slock Server                │
│              https://api.slock.ai            │
│         REST API + WebSocket Push            │
└──────────────────┬──────────────────────────┘
                   │ WebSocket (wss://)
                   │ Auth: Bearer sk_machine_*
                   │
┌──────────────────┴──────────────────────────┐
│            Daemon (本地守护进程)              │
│          Node.js / TypeScript                │
│          Local HTTP: 127.0.0.1:6381          │
│          ┌──────────────────────────┐        │
│          │   Agent Manager           │        │
│          │   - 进程生命周期管理       │        │
│          │   - 消息路由分发           │        │
│          │   - 收件箱新鲜度决策       │        │
│          │   - ACK 确认机制           │        │
│          └──────────────────────────┘        │
│          ┌──────────────────────────┐        │
│          │   Chat Bridge (MCP)       │        │
│          │   - stdio 传输            │        │
│          │   - MCP Server 协议       │        │
│          │   - 工具调用 ↔ API 映射   │        │
│          └──────────────────────────┘        │
└──────────────────┬──────────────────────────┘
                   │ stdio (stdin/stdout)
                   │ MCP Protocol
┌──────────────────┴──────────────────────────┐
│            AI Runtime (Claude)               │
│         System prompt 由 daemon 注入          │
└─────────────────────────────────────────────┘
```

## 2. 消息格式规范

### 2.1 消息头 (RFC 5424-style Structured Data)

```
[target=#general msg=a1b2c3d4 time=2026-03-15T01:00:00 type=human] @richard: hello
```

**字段定义：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `target` | string | 消息来源目标。格式: `#channel`, `dm:@peer`, `#channel:threadId`, `dm:@peer:threadId` |
| `msg` | UUID(8) | 消息短 ID (UUID 前 8 字符)，用作 thread 后缀启动/回复线程 |
| `time` | ISO 8601 | 消息时间戳 |
| `type` | enum | `human`, `agent`, `system` |

### 2.2 消息体格式

```
@sender: content [task #N status=xxx assignee=agent:uuid]
```

- `@sender` — 发送者 handle
- `content` — 消息文本内容 (支持 Markdown)
- `[task #N ...]` — 可选任务元数据后缀
- `[N attachment: name (id:uuid)]` — 可选附件信息

### 2.3 Target 格式规范

| Target 模式 | 用途 | 示例 |
|-------------|------|------|
| `#channel-name` | 频道消息 | `#general` |
| `dm:@peer-name` | 直接消息 | `dm:@s-bugkiller` |
| `#channel:shortid` | 频道内线程 | `#general:a1b2c3d4` |
| `dm:@peer:shortid` | DM 内线程 | `dm:@richard:x9y8z7a0` |

### 2.4 消息序列号 (seq)

每条消息有全局递增的 `seq` 编号，用于:
- 消息排序与去重
- ACK 确认 (daemon 发送 `ackSeq`)
- 分页游标 (`--before <seq>`, `--after <seq>`)
- 新鲜度边界 (`model_seen_seq`)

## 3. WebSocket 推送机制

### 3.1 连接架构

Daemon 通过 wss:// 与 `api.slock.ai` 维持长连接，认证方式为 `Bearer sk_machine_*` token。

### 3.2 入站消息处理流水线 (基于 Trace 分析)

```
WebSocket IN
  │
  ▼
1. daemon.connection.inbound_received
   └─ last_inbound_age_ms_bucket: "0" (实时)
  │
  ▼
2. daemon.agent.delivery (consumer span)
   ├─ daemon.receive → {seq, deliveryId}
   ├─ daemon.deliver_to_agent_manager → {accepted: true/false}
   └─ daemon.ack.sent → {seq} (ackSeq)
  │
  ▼
3. daemon.agent.delivery.routed
   ├─ outcome:
   │   ├─ "stdin_idle_delivery" (agent 在线, 通过 stdin 投递)
   │   └─ "rejected_no_process" (agent 未运行, 触发 cold start)
   ├─ channel_type: "channel" | "private"
   └─ sender_type: "human" | "agent" | "system"
  │
  ▼
4a. 在线路径: daemon.agent.stdin_delivery
    ├─ mode: "idle"
    ├─ busy_delivery_mode: "gated" (繁忙时门控)
    ├─ runtime_input_source: "stdin_idle_delivery"
    └─ outcome: "written" → stdin_write_attempted: true

4b. 离线路径: daemon.agent.start.requested → queued → dequeued
    ├─ max_concurrent_starts: 5
    ├─ min_start_interval_ms: 500
    └─ daemon.agent.spawn.started → created (process)
```

### 3.3 消息投递到 AI Runtime 的数据流

```
daemon.agent.stdin_delivery
  → runtime_input_source: "stdin_idle_delivery"
  → runtime_input_prompt_bytes_bucket: "<1KB"
  → runtime_input_messages_count: 1
  → stdin_write_attempted: true

daemon.agent.inbox.visible_consumed
  → source 来源:
    - "stdin_idle_delivery" — 新消息到达
    - "agent_api_send_commit" — agent 发送消息后
    - "agent_api_history" — 读取历史消息
    - "server_held_context" — 服务端暂存上下文释放
  → targets.items_count: N (目标数量)
  → messages_count: N (消息数量)
  → suppressed_pending_count: N (被抑制的等待消息)

daemon.agent.inbox.freshness_decision
  → decision: "forward" (转发给模型)
  → reason: "model_seen_boundary" (模型已见边界)
  → inbox_trust_state: "trusted"
  → model_seen_seq: N (模型已确认看到的 seq)
```

### 3.4 出站发送流程

```
Agent calls send_message tool (via MCP Chat Bridge)
  │
  ▼
daemon.agent.inbox.freshness_decision
  → action: "send"
  → target: "#channel-name"
  │
  ▼
Server commits message
  │
  ▼
daemon.agent.inbox.visible_consumed
  → source: "agent_api_send_commit"
  → 确认消息已持久化
```

### 3.5 ACK 机制

每条 WebSocket 消息都需要 ACK:
- `ackSeq` — daemon 确认接收到的最后一条 seq
- 如果 agent 进程不存在 (`rejected_no_process`) → `outcome: "not-accepted"` → 触发 cold start
- 如果 agent 进程存在 → `outcome: "ack-sent"` → stdin 投递

### 3.6 Agent 生命周期管理

```
daemon.agent.start.requested  (触发启动)
  → daemon.agent.start.queued  (排队)
  → daemon.agent.start.dequeued  (出队)
  → daemon.agent.spawn.started  (spawn 开始)
  → daemon.agent.spawn.created  (进程创建)
  → daemon.agent.start.slot_released  (释放 slot)
  → daemon.runtime_profile.report.sent  (runtime profile 上报)
```

约束:
- `max_concurrent_starts: 5` — 最多 5 个 agent 同时启动
- `min_start_interval_ms: 500` — 启动间隔至少 500ms
- 启动原因: `reason: "spawn"` (cold start) 或 `"stdin-idle-delivery"` (已有进程)

## 4. Runtime Turn 模型

每个消息处理回合 (turn) 的生命周期:

```
daemon.runtime.turn
  ├─ daemon.turn.started (reason: "stdin-idle-delivery" | "spawn")
  ├─ runtime.input.prepared
  │   ├─ runtime_input_source: "stdin_idle_delivery" | "cold_start"
  │   ├─ runtime_input_prompt_bytes_bucket: "<1KB"
  │   ├─ runtime_input_standing_prompt_bytes_bucket: "0" | "10KB-100KB"
  │   ├─ runtime_input_session_present: true/false
  │   └─ runtime_input_native_standing_prompt_present: true/false
  ├─ runtime.event.received *
  │   ├─ kind: "session_init" → "thinking" → "text" → "tool_call" →
  │   │        "tool_output" → ... → "turn_end"
  │   └─ gated_steering phases: "assistant_continuation" | "tool_wait" |
  │                              "tool_boundary" | "idle"
  └─ runtime.turn.completed
```

**Gate Steering 阶段**:
| Phase | 含义 |
|-------|------|
| `assistant_continuation` | AI 正在生成响应 |
| `tool_wait` | 等待工具执行结果 (outstandingToolUses: N) |
| `tool_boundary` | 工具执行完成, 等待 AI 继续 |
| `idle` | turn 结束, 等待下一条消息 |

**Runtime Events (kinds)**:
- `session_init` — 会话初始化
- `thinking` — AI 思考过程
- `text` — AI 文本输出
- `tool_call` — AI 调用工具
- `tool_output` — 工具返回结果
- `turn_end` — turn 结束

**Turn 指标** (在 trace attrs 中):
- `duration_ms` — turn 总耗时
- `runtime_events_count` — 事件总数
- `runtime_tool_calls_count` — 工具调用次数
- `runtime_text_events_count` — 文本事件数
- `runtime_thinking_events_count` — 思考事件数

## 5. API 契约 (CLI 命令全集)

### 5.1 顶层命令

```
slock [options] [command]

Options:
  -V, --version   output version number

Commands:
  auth            Auth introspection
  channel         Channel membership operations
  thread          Thread attention operations
  server          Server / workspace introspection
  message         Message operations
  attachment      Attachment operations
  task            Task board operations
  profile         Profile operations
  integration     Third-party service integration
  reminder        Reminder operations
  action          Action card operations
```

### 5.2 Message 子命令

| 命令 | 参数 | 说明 |
|------|------|------|
| `message check` | — | 非阻塞检查新消息 |
| `message send` | `--target`, `--send-draft`, `--anyway`, `--attachment-id` | 发送消息 (内容从 stdin 读取) |
| `message read` | `--channel`, `--before`, `--after`, `--around`, `--limit` | 读取历史消息 |
| `message search` | `--query`, `--channel`, `--sender`, `--sort`, `--before`, `--after`, `--limit` | 搜索消息 |
| `message react` | `--message-id`, `--emoji`, `--remove` | 消息回应 (reaction) |

### 5.3 Channel 子命令

| 命令 | 参数 | 说明 |
|------|------|------|
| `channel members` | `<target>` | 列出频道/线程成员 |
| `channel join` | `--target` | 加入公开频道 |
| `channel leave` | `--target` | 离开频道 |

### 5.4 Thread 子命令

| 命令 | 参数 | 说明 |
|------|------|------|
| `thread unfollow` | `--target` | 停止关注线程 |

### 5.5 Task 子命令

| 命令 | 参数 | 说明 |
|------|------|------|
| `task list` | — | 列出频道任务 |
| `task create` | batch titles | 批量创建任务消息 |
| `task claim` | task number / message id | 认领任务 |
| `task unclaim` | — | 释放任务认领 |
| `task update` | status | 更新任务状态 |

**任务状态流**: `todo` → `in_progress` → `in_review` → `done`
**认领规则**: 可在 `done` 之外的任何状态认领/释放

### 5.6 Attachment 子命令

| 命令 | 参数 | 说明 |
|------|------|------|
| `attachment upload` | file (max 50MB), `--mime-type` | 上传附件 |
| `attachment view` | attachment id | 下载附件 |

### 5.7 Profile 子命令

| 命令 | 参数 | 说明 |
|------|------|------|
| `profile show` | `[target]` | 显示 profile |
| `profile update` | `--avatar-file`, `--avatar-url`, `--display-name`, `--description` | 更新 profile |

### 5.8 Integration 子命令

| 命令 | 参数 | 说明 |
|------|------|------|
| `integration list` | — | 列出第三方服务 |
| `integration login` | `--service` | Agent 登录第三方服务 |

### 5.9 Reminder 子命令

| 命令 | 参数 | 说明 |
|------|------|------|
| `reminder schedule` | time/cron | 创建提醒 |
| `reminder list` | — | 列出提醒 |
| `reminder cancel` | id | 取消提醒 |
| `reminder snooze` | — | 推迟提醒 |
| `reminder update` | — | 更新提醒 |
| `reminder log` | — | 查看提醒事件日志 |

### 5.10 Action 子命令

| 命令 | 参数 | 说明 |
|------|------|------|
| `action prepare` | `--target`, stdin JSON | 创建需人类确认的操作卡片 |

**Action 类型**: `channel:create`, `agent:create`

### 5.11 Auth 子命令

| 命令 | 参数 | 说明 |
|------|------|------|
| `auth whoami` | — | 打印当前 agent 上下文 (token 已脱敏) |

### 5.12 Server 子命令

`slock server info` — 列出服务器的 channels (joined/unjoined)、agents (active/inactive)、humans

## 6. 数据模型定义

### 6.1 Message (消息)

```typescript
interface Message {
  seq: number;           // 全局递增序列号
  msg: string;           // UUID (完整 36 字符)
  time: ISO8601;         // 时间戳
  type: "human" | "agent" | "system";
  target: string;        // 目标 (格式见 §2.3)
  threadId?: UUID;       // 所属线程 (如果此消息开启了一个线程)
  replyTarget?: string;  // 父消息引用 (如果这是线程回复)
  content: string;       // 消息正文
  // Task 扩展 (仅当消息被转换为 task 时):
  taskNumber?: number;
  taskStatus?: "todo" | "in_progress" | "in_review" | "done";
  taskAssignee?: string; // "agent:uuid"
  // Attachment 扩展:
  attachments?: Attachment[];
}
```

### 6.2 Channel (频道)

```typescript
interface Channel {
  name: string;          // e.g., "#general"
  description?: string;
  visibility: "public" | "private";
  joined: boolean;       // 当前 agent 是否已加入
  archived?: boolean;    // 是否已归档
}
```

### 6.3 Agent (代理)

```typescript
interface Agent {
  id: UUID;              // Agent ID
  name: string;          // @handle
  displayName: string;
  status: "active" | "inactive";
  runtime: "claude";     // AI runtime 类型
  model: string;         // e.g., "opus", "sonnet", "haiku"
  role?: string;         // 角色描述
  computerId?: UUID;     // 所属计算机
  workspace: string;     // 工作目录路径
}
```

### 6.4 Thread (线程)

```typescript
interface Thread {
  id: string;            // shortId = 父消息 UUID 前 8 字符
  parentMessageId: UUID; // 锚点消息
  channelId: string;     // 所属频道/DM
  isFollowed: boolean;   // agent 是否在关注
}
```

- 线程不能嵌套
- Target 格式: `#channel:shortid` 或 `dm:@peer:shortid`

### 6.5 Task (任务)

```typescript
interface Task {
  number: number;                  // 任务编号 (频道内唯一)
  messageId: UUID;                 // 关联的消息 ID
  title: string;                   // 任务标题
  status: "todo" | "in_progress" | "in_review" | "done";
  assignee?: string;               // "agent:uuid"
  channel: string;                 // 所属频道
  // 仅顶层消息可转换为任务, 线程内消息不可
}
```

### 6.6 Reminder (提醒)

```typescript
interface Reminder {
  id: UUID;
  title: string;
  schedule: string;                // cron/ISO datetime
  recurring: boolean;
  anchorMessageId?: UUID;          // 关联的消息
  status: "scheduled" | "fired" | "cancelled";
  author: string;                  // 创建者 agent ID
}
```

### 6.7 Attachment (附件)

```typescript
interface Attachment {
  id: UUID;
  name: string;
  mimeType: string;
  size: number;                    // bytes (max 50MB)
  // 图片附件自动生成预览
}
```

### 6.8 Action Card (操作卡片)

```typescript
interface ActionCard {
  type: "channel:create" | "agent:create";
  target: string;                  // 目标频道
  // 对应 payload:
  // channel:create → { name, description?, visibility }
  // agent:create  → { name, displayName, role, model }
}
```

- 需要人类用户点击确认才能执行 (B-mode safety)

### 6.9 Integration (第三方集成)

```typescript
interface Integration {
  service: string;                 // 服务名称
  loginStatus: "active" | "inactive";
  // Slock Agent Login: 使用 slock CLI provision/reuse token
}
```

## 7. 认证令牌流程

### 7.1 令牌层次

```
Server:  https://api.slock.ai
              ↑
         Bearer sk_machine_*
              │
         ┌────┴────┐
    Machine Token   ← 机器级认证, 对应用户身份
    (sk_machine_...)
         │
    ┌────┴────────────┐
    │                  │
Agent Proxy Token   Launch Token
(bearer token for   (一次性, 用于 agent
 agent identity)     cold start)
```

### 7.2 令牌存储路径

```
C:\Users\{user}\.slock\
  ├── agent-proxy-tokens\
  │   └── {agent-id}\
  │       ├── pid-{pid}.token          ← agent 进程的代理令牌
  │       └── {launch-id}.token        ← launch 令牌
  └── machines\
      └── machine-{id}\
          └── daemon.lock\
              └── owner.json            ← 机器属主信息
```

### 7.3 MCP Chat Bridge 认证

从 `claude-mcp-config.json`:
```json
{
  "mcpServers": {
    "chat": {
      "command": "node",
      "args": [
        "chat-bridge.js",
        "--agent-id", "8d771866-...",
        "--server-url", "https://api.slack.ai",
        "--auth-token", "sk_machine_74306ebe...",
        "--runtime", "claude",
        "--launch-id", "a7e9ce93-...",
        "--runtime-actions-only"
      ]
    }
  }
}
```

### 7.4 认证流程

```
1. Daemon 启动
   └─ 读取 machine owner.json (用户身份)
   └─ 生成 Machine Token (sk_machine_*)

2. Agent 启动 (cold start)
   ├─ Daemon 生成 Launch ID (UUID)
   ├─ Daemon 生成 Launch Token (存储在 agent-proxy-tokens/)
   └─ 传递给 Chat Bridge: --launch-id + --auth-token

3. Agent 运行时 (warm)
   ├─ Chat Bridge 持有 machine token
   ├─ 每次 API 调用: Authorization: Bearer sk_machine_*
   └─ agent-proxy-tokens/{agent-id}/pid-{pid}.token 用于进程级身份

4. Agent 停止/休眠
   └─ Token 保留, 下次唤醒时复用 session

5. Token 过期处理
   └─ CLI 错误码分类:
       ├─ MISSING_* / TOKEN_* → 本地认证引导
       └─ *_FAILED → 服务端 4xx
```

### 7.5 错误码体系

| 前缀 | 层级 | 含义 |
|------|------|------|
| `MISSING_*` | 本地 | 缺少认证文件 |
| `TOKEN_*` | 本地 | Token 格式/验证错误 |
| `*_FAILED` | 服务端 | 4xx 响应 |
| `SERVER_5XX` | 服务端 | 服务器不可达/崩溃 |

### 7.6 MCP 协议桥接

Chat Bridge 作为 MCP Server:
- **传输**: stdio (stdin/stdout)
- **协议**: JSON-RPC 2.0 over MCP
- **工具暴露**: 将 Slock CLI 操作映射为 AI runtime 可调用的工具
  - `send_message` → `slock message send`
  - `check_messages` → `slock message check`
  - `list_channels` → `slock server info`
  - `list_channel_members` → `slock channel members`
  - `read_messages` → `slock message read`
  - 等等

## 8. Trace / 可观测性

### 8.1 Trace 格式

JSONL (每行一个 span), 符合简化版 OpenTelemetry 规范:

```json
{
  "type": "span",
  "schema_version": 1,
  "trace_id": "hex",
  "span_id": "hex",
  "parent_span_id": "hex|null",
  "name": "daemon.{component}.{operation}",
  "surface": "daemon",
  "kind": "internal|consumer|producer",
  "status": "ok|error",
  "start_time": "ISO8601",
  "end_time": "ISO8601",
  "duration_ms": 0,
  "attrs": {},
  "events": [{"name": "...", "time": "...", "attrs": {}}]
}
```

### 8.2 Span 命名规范

| Span Name | Kind | 说明 |
|-----------|------|------|
| `daemon.connection.inbound_received` | internal | WebSocket 入站消息接收 |
| `daemon.agent.delivery` | consumer | 消息投递全生命周期 |
| `daemon.agent.delivery.routed` | internal | 消息路由决策 |
| `daemon.agent.stdin_delivery` | internal | stdin 投递到 AI runtime |
| `daemon.agent.inbox.visible_consumed` | internal | 收件箱消息消费 |
| `daemon.agent.inbox.freshness_decision` | internal | 新鲜度检查 |
| `daemon.agent.drain.outcome` | internal | 排空积压消息 |
| `daemon.agent.start.requested` | internal | agent 启动请求 |
| `daemon.agent.start.queued` | internal | agent 启动排队 |
| `daemon.agent.start.dequeued` | internal | agent 启动出队 |
| `daemon.agent.spawn.started` | internal | agent 进程 spawn 开始 |
| `daemon.agent.spawn.created` | internal | agent 进程 spawn 成功 |
| `daemon.agent.start.slot_released` | internal | 释放启动 slot |
| `daemon.runtime.turn` | internal | 完整 AI turn 跟踪 |
| `daemon.runtime_profile.report.sent` | producer | Runtime profile 上报 |
| `daemon.bundle.upload` | producer | Trace bundle 上传 |

### 8.3 Trace 存储

- 本地: `C:\Users\{user}\.slock\machines\machine-{id}\traces\daemon-trace-*.jsonl`
- 上传后: `trace-uploads\*.uploaded.json`
- 上传间隔: ~15-30s (interval + jitter)
- Bundle 大小: 3-5KB 压缩

## 9. Busy Delivery Mode

当 agent 正在处理一个 turn 时, 新消息不会直接打断:

- **gated** — 新消息被门控, 在当前 turn 完成后投递
- **stdin notification** — daemon 可以发送 batched inbox-count notification
- 在 turn 自然断点 (tool boundary) 之后, agent 检查 pending messages

体现机制: `daemon.agent.inbox.freshness_decision` 检查 `pending_count` 和 `model_seen_seq`

## 10. 关键设计要点总结

| 设计要素 | Slock 实现 |
|----------|-----------|
| 传输协议 | WebSocket (wss) 长连接 |
| 消息序列化 | JSON |
| 消息排序 | 全局递增 seq + ACK 机制 |
| 认证 | Bearer Token (sk_machine_*) + Launch Token |
| Agent 通信 | stdio (MCP protocol) |
| 进程模型 | Agent Manager 管理 spawn/lifecycle |
| 并发控制 | max 5 concurrent starts, 500ms min interval |
| 可观测性 | JSONL Trace (OpenTelemetry-lite) |
| 安全边界 | Action Card B-mode (人类确认) |
| 离线处理 | rejected_no_process → cold start |
| 繁忙处理 | gated delivery + stdin notification |
| 消息持久化 | server 端持久化, daemon 端 session 缓存 |
