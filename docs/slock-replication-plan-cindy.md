# Slock 复现方案计划书

> 基于 Slock Daemon v0.53.2 完整逆向分析
> 分析时间: 2026-05-25
> 四份专项分析文档交叉验证完成

---

## 一、项目概述

Slock 是一个 human-AI 协作平台，让人类与 AI Agent 在频道和私信中像团队成员一样协同工作。核心特性包括：频道/DM/线程三层消息模型、任务状态机、实时 WebSocket 推送、本地 Agent Daemon、提醒调度、文件附件、第三方集成。

### 源材料

| 文档 | 作者 | 覆盖范围 |
|---|---|---|
| `notes/slock-protocol-analysis.md` | @slock-protocol | 消息格式、WebSocket 协议、数据模型、API 契约、认证流程、Turn 生命周期 |
| `notes/slock-daemon-architecture.md` | @slock-daemon | DaemonCore 结构、CLI 29 命令、8种 Runtime Driver、HTTP 代理、MCP 桥接、Prompt 生成 |
| `notes/slock-backend-analysis.md` | @slock-backend | API 路由(14 条重写规则)、DB Schema(16 张表)、认证三層 Token、Presence 机制 |
| `notes/slock-frontend-architecture.md` | @slock-frontend | React 组件树、14 条路由、9 个 Zustand Store、WebSocket Hook、任务看板 UI |

---

## 二、架构全景

```
┌──────────────┐    WebSocket     ┌──────────────────┐
│  Daemon      │◄═══════════════►│  Slock Server     │
│  (本地守护)   │   REST API      │  (api.slock.ai)   │
│              │◄───────────────►│                   │
│  ├─ CLI      │                 │  ├─ Auth Service  │
│  ├─ Proxy    │    MCP stdio    │  ├─ Message Svc   │
│  ├─ Runtime  │                 │  ├─ Task Svc      │
│  └─ Trace    │                 │  ├─ Reminder Svc  │
└──────┬───────┘                 │  ├─ File Store    │
       │ spawn                   │  └─ WS Gateway    │
┌──────▼───────┐                 └────────┬─────────┘
│  AI Runtime  │                          │
│  (Claude)    │                 ┌────────▼─────────┐
│              │                 │  Web Frontend     │
│  ├─ MCP      │                 │  (React 19+Vite)  │
│  └─ Tools    │                 └──────────────────┘
└──────────────┘
```

---

## 三、核心技术方案

### 3.1 技术栈

| 层 | 技术 | 原因 |
|---|---|---|
| 后端 | Node.js/TypeScript + Fastify | 与 daemon 统一语言，AI 辅 助效果最好 |
| 数据库 | PostgreSQL 15+ + Redis 7+ | PG 持久数据，Redis 做 WS 状态/消息队列 |
| 前端 | React 19 + Vite + TailwindCSS + Zustand | 生态成熟，AI 生成质量高 |
| 通信 | REST + WebSocket (ws) | 与现有协议对齐 |
| 文件存储 | MinIO / S3 | 附件/头像存储 |
| 部署 | Docker Compose | MVP 快速部署 |

### 3.2 核心协议

**消息格式 (RFC 5424-style):**
```
[target=#general msg=a1b2c3d4 time=2026-03-15T01:00:00 type=human] @sender: content
```

**Target 语法:**
- `#channel` → 频道消息
- `dm:@peer` → 直接消息
- `#channel:shortid` → 频道线程
- `dm:@peer:shortid` → DM 线程

**任务状态机:** `todo → in_progress → in_review → done`

### 3.3 数据库设计

核心 16 张表: users, agents, servers, channels, channel_members, messages, message_reactions, attachments, message_attachments, reminders, reminder_events, integrations, agent_logins, machine_tokens, agent_credentials, action_cards

### 3.4 前端路由

14 条路由: `/channels`, `/channels/:name`, `/channels/:name/:threadId`, `/dm/:peer`, `/dm/:peer/:threadId`, `/tasks`, `/tasks/:channel`, `/settings/*`, `/admin/*`

### 3.5 前端状态管理

9 个 Zustand Store: auth, channel, message, task, dm, profile, reminder, integration, ui

---

## 四、实施路线图

### Phase 1: MVP 核心 (4–5 周，单人+AI)

| 模块 | 内容 | 工时 |
|---|---|---|
| 认证系统 | 注册/登录、Machine Token、Agent Token | 3–5 天 |
| 频道系统 | CRUD、成员管理、public/private | 3–5 天 |
| 消息系统 | 发送/接收/搜索/ACK、频道+DM+线程 | 1.5–2 周 |
| WebSocket | 实时推送、ACK、离线补拉、心跳 | 3–5 天 |
| 前端聊天 UI | 频道/DM/线程三视图、Markdown 渲染、消息输入 | 1.5–2 周 |
| 本地 Daemon | CLI 框架、HTTP 代理、Claude Runtime 适配 | 1–1.5 周 |
| 基础设施 | DB Schema、Docker、CI/CD | 1.5–2 周 |

### Phase 2: 协作功能 (3–4 周)

| 模块 | 内容 | 工时 |
|---|---|---|
| 任务系统 | 状态机、Claim、看板 UI、拖拽 | 1–1.5 周 |
| 文件附件 | 上传/存储/预览/下载 | 2–3 天 |
| @提及 + 通知 | 内联解析、未读计数、通知推送 | 3–5 天 |
| Action Card | B-mode 审批卡片 | 2–3 天 |
| Agent 管理 | 注册/生命周期/在线状态/Presence | 3–5 天 |
| 设置页面 | 资料/集成管理 | 3–5 天 |

### Phase 3: 完善与稳定 (2–3 周)

| 模块 | 内容 | 工时 |
|---|---|---|
| 搜索优化 | 全文搜索 (pg_trgm + tsvector) | 2–3 天 |
| 稳定性 | 断线重连优化、离线消息补拉、错误恢复 | 3–5 天 |
| 监控告警 | 基础监控、日志、错误告警 | 2–3 天 |
| 数据备份 | 自动备份策略、恢复流程 | 1–2 天 |
| 移动端适配 | 响应式布局基础适配 | 1–2 天 |

**总工期: 单人 + AI 辅助约 9–12 周 (2.5–3 个月)**

---

## 五、关键设计决策

1. **后端 Node.js 起步** — 与 daemon 统一技术栈，AI 生成质量最高
2. **前端直接 REST API** — 不经过 daemon proxy，daemon proxy 是 agent CLI 专用
3. **WebSocket + HTTP 双通道** — WS 做实时推送，HTTP 做 CRUD 操作
4. **seq 全局递增** — 消息排序、ACK、分页的统一机制
5. **Draft + freshness 乐观锁** — 发送消息时的并发冲突检测
6. **Heartbeat + Profile Report 双保险** — Agent presence 检测
7. **单文件部署** — Daemon CLI 打包为单文件 bundle，无 node_modules 依赖

---

## 六、需要进一步明确的内容

- 前端 API 路径: daemon 使用 `/internal/agent-api/*`，前端需确认是否复用或使用独立 `/api/*` 路径
- 数据库具体部署方案: PostgreSQL 版本、连接池配置、读写分离需求
- 文件存储: 本地 MinIO vs 云 S3 的选择
- 是否需要 Elasticsearch: 如果消息量较大，pg_trgm 搜索可能不够

---

## 七、各专项分析文档索引

| 文档路径 | 作者 Agent | 关键内容 |
|---|---|---|
| `slock-protocol-analysis.md` | @slock-protocol | 消息格式、数据模型、API 契约(29命令)、认证令牌、WS 协议、Turn 模型、Trace 可观测性 |
| `slock-daemon-architecture.md` | @slock-daemon | DaemonCore 生命周期、ClaudeDriver、8 种 Runtime、HTTP 代理、MCP 桥接、System Prompt 生成 |
| `slock-backend-analysis.md` | @slock-backend | 完整 API 列表(28+端点)、16 张表 DB Schema、3 种认证模式、上传流程、路径映射表、错误码体系 |
| `slock-frontend-architecture.md` | @slock-frontend | 组件树(全层级)、14 条路由、9 个 Store(TypeScript 接口)、WebSocket Hook、项目目录结构、TypeScript 类型定义 |
