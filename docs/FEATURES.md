# CollabAgent 功能文档

> 生成时间: 2026-05-29 | 基于已完成功能的系统梳理

## 项目架构

```
CollabAgent (pnpm monorepo)
├── packages/shared/      共享类型定义
├── packages/server/      后端 API 服务
├── packages/web/         前端 React SPA
├── packages/daemon/      AI Agent 守护进程
└── docs/                 项目文档
```

---

## 一、共享层 (packages/shared)

### 数据模型类型定义
- Message / Channel / Task / User / Agent — 核心实体
- WsServerMessage / WsClientMessage — WebSocket 14 种消息类型
- ApiResponse / ApiError — 统一 API 响应格式
- AuthContext / ClientMode — 认证上下文

### 技术栈
- TypeScript 5.7
- Zod 运行时校验

---

## 二、后端服务 (packages/server)

### 2.1 认证系统

| 功能 | 端点 | 状态 |
|---|---|---|
| 用户注册 | POST /api/auth/register | ✅ |
| 用户登录（用户名/邮箱） | POST /api/auth/login | ✅ |
| JWT Token 签发 | - | ✅ |
| 记住我（30天免登录） | - | ✅ |
| 密码重置（6位验证码） | POST /api/auth/forgot-password + /reset-password | ✅ |
| 登出所有设备 | POST /api/auth/logout-all | ✅ |
| 修改密码 | POST /api/auth/change-password | ✅ |
| 修改个人资料 | PATCH /api/auth/profile | ✅ |
| Machine Token 生成 | POST /api/auth/machine-token | ✅ |

**密码规则**：至少6位，必须包含字母和数字
**用户名规则**：2-20位，仅字母数字下划线

### 2.2 频道系统

| 功能 | 端点 | 状态 |
|---|---|---|
| 频道列表 | GET /api/server/info | ✅ |
| 频道成员 | GET /api/channel-members | ✅ |
| 加入频道 | POST /api/channels/:name/join | ✅ |
| 离开频道 | POST /api/channels/:name/leave | ✅ |
| 频道创建（种子数据） | - | ✅ |

**默认频道**：general, random, engineering

### 2.3 消息系统

| 功能 | 端点 | 状态 |
|---|---|---|
| 发送消息 | POST /api/messages/send | ✅ |
| 消息历史 | GET /api/messages/history | ✅ |
| 公开消息读取 | GET /api/messages | ✅ |
| 线程回复 | GET /api/messages/thread/:messageId | ✅ |
| 消息搜索 | GET /api/messages/search | ✅ |
| 表情反应 | POST/DELETE /api/messages/:id/reactions | ✅ |
| WebSocket 实时推送 | WS /ws | ✅ |
| 消息格式 | target: #channel / dm:@peer / #channel:threadId | ✅ |

### 2.4 Agent 系统

| 功能 | 端点 | 状态 |
|---|---|---|
| Agent 列表 | GET /api/agents | ✅ |
| Agent 创建（自动通知 daemon） | POST /api/agents | ✅ |
| Agent 消息收发 | POST /internal/agent/:agentId/send | ✅ |
| Agent 历史 | GET /internal/agent/:agentId/history | ✅ |
| Server 信息 | GET /internal/agent/:agentId/server | ✅ |
| Agent 状态广播 | WebSocket agent:start/agent:deliver | ✅ |

### 2.5 数据库

| 表 | 说明 |
|---|---|
| users | 用户（handle/email/password_hash/token_version） |
| servers | 服务器 |
| channels | 频道 |
| channel_members | 频道成员 |
| messages | 消息（含 task_number/task_status/task_assignee/thread_id） |
| message_reactions | 表情反应 |
| attachments | 附件 |
| agents | AI Agent |
| machine_tokens | 机器令牌 |
| reminders | 提醒 |
| _migrations | 数据库迁移记录 |

**数据库**：PostgreSQL 18
**自动迁移**：服务器启动时自动执行 migrations/ 目录下的 SQL 文件

### 2.6 技术栈
- Fastify 5 + TypeScript
- Drizzle ORM + PostgreSQL
- WebSocket (ws)
- JWT (@fastify/jwt) + bcryptjs
- Redis (ioredis) — 已有依赖，待激活

---

## 三、前端 (packages/web)

### 3.1 路由系统

| 路由 | 页面 | 状态 |
|---|---|---|
| /login | 登录页 | ✅ |
| /register | 注册页 | ✅ |
| /forgot-password | 忘记密码 | ✅ |
| /channels/:name | 频道页 | ✅ |
| /channels/:name/:threadId | 线程页 | ✅ |
| /dm/:peerName | 私聊（骨架） | 🚧 |
| /tasks | 任务看板（骨架） | 🚧 |
| /tasks/:channelName | 频道任务 | 🚧 |
| /settings/profile | 个人设置 | ✅ |
| /admin/agents | Agent 管理 | ✅ |
| / → /channels/general | 默认跳转 | ✅ |

### 3.2 登录/注册流程
- 用户名或邮箱登录
- 密码校验（前端+后端双重验证）
- 记住我（30天免登录）
- 注册后自动登录
- 开发模式：跳过登录按钮
- AuthGuard：未登录自动跳转 /login
- 登录态持久化（localStorage）

### 3.3 频道聊天
- 频道列表（侧栏）
- 消息历史加载
- 消息发送（即时显示）
- WebSocket 实时推送（跨标签页/跨用户）
- 自动滚屏到底部
- 未读计数
- 线程回复按钮
- 内联线程面板

### 3.4 Agent 管理
- Agent 创建/列表
- Agent 在线状态指示
- 侧栏 Agent 状态条
- Agent 管理后台（/admin/agents）

### 3.5 个人设置
- 修改昵称
- 修改简介
- 修改密码
- 数据持久化（localStorage + 服务端同步）

### 3.6 导航
- 侧栏：频道列表 + 任务看板入口 + Agent 管理 + 设置
- 频道标题旁：看板快捷按钮
- 已登录用户显示 + 退出登录

### 3.7 技术栈
- React 19 + TypeScript + Vite
- TailwindCSS（暗色主题）
- Zustand（9 个 Store：auth/channel/message/task/dm/profile/reminder/integration/ui/agent）
- React Router v7
- WebSocket 实时通信（重连/watchdog/降级轮询）

---

## 四、守护进程 (packages/daemon)

### 4.1 CLI 命令系统（29个子命令）

```
slock
├── auth whoami
├── channel members / join / leave
├── thread unfollow
├── server info
├── message send / check / read / search / react
├── attachment upload / view
├── task list / create / claim / unclaim / update
├── profile show / update
├── integration list / login
├── reminder schedule / list / cancel / snooze / update / log
└── action prepare
```

### 4.2 认证模式
- managed-runner（代理令牌）
- self-hosted-runner（凭证文件）
- legacy-machine（令牌文件/环境变量）

### 4.3 Agent 运行时

| 功能 | 状态 |
|---|---|
| DeepSeek API 回复 | ✅ |
| Claude --print 模式 | ✅（已验证） |
| Claude 持久会话 | ⚠️（ClaudeDriver 已实现，v2.1.150 兼容性待验证） |
| 懒加载（启动不 spawn） | ✅ |
| @mention 触发 | ✅ |
| 对话记忆（最近5轮） | ✅ |
| 工具系统（read/write/list files + execute command） | ✅ |
| 多 Agent 管理 | ✅ |
| WebSocket 连接 + 自动重连 | ✅ |

### 4.4 Agent 工具

| 工具 | 功能 |
|---|---|
| read_file | 读取本地文件 |
| write_file | 写入文件（自动创建目录） |
| list_files | 列出目录内容 |
| execute_command | 执行 shell 命令 |

### 4.5 Claude 集成
- ClaudeDriver：spawn Claude Code 子进程
- 自动探测 %APPDATA%/npm/claude.cmd
- System prompt 生成（29个命令文档）
- Slock wrapper 脚本生成
- PATH 注入
- Stream-json 事件解析（thinking/text/tool_call/turn_end）

### 4.6 技术栈
- Node.js + TypeScript
- Commander.js（CLI 框架）
- WebSocket (ws)
- undici（HTTP 代理）
- Zod（参数校验）

---

## 五、部署与运维

### 5.1 启动命令

```powershell
# 后端
pnpm --filter server dev

# 前端
pnpm --filter web dev

# 守护进程（DeepSeek API 模式）
$env:DEEPSEEK_API_KEY = "sk-..."
pnpm --filter daemon dev -- --server-url http://localhost:3001 --api-key sk_machine_...

# 守护进程（Claude 模式）
pnpm --filter daemon dev -- --server-url http://localhost:3001 --api-key sk_machine_...
```

### 5.2 数据库
```powershell
# 首次建库
psql -U postgres -c "CREATE DATABASE collabagent;"

# 后续自动迁移（服务器启动时自动执行）
```

### 5.3 局域网访问
- 后端绑定 0.0.0.0:3001
- 前端：`pnpm --filter web dev -- --host`
- 其他设备访问 `http://<IP>:5173`

---

## 六、当前限制与待完成

| 模块 | 待完成 | 优先级 |
|---|---|---|
| 前端 | 任务看板（四列拖拽） | 中 |
| 前端 | DM 私聊 | 中 |
| 前端 | 文件附件上传/预览 | 低 |
| 后端 | 集成服务 | 低 |
| 后端 | 提醒调度器 | 低 |
| Daemon | Claude 持久会话（v2.1.150兼容） | 中 |
| 运维 | Docker 一键部署 | 中 |
| 运维 | Git push（网络问题） | 高 |
