# Daemon Package 完成度分析

**日期**: 2026-07-15
**范围**: `packages/daemon` — 15 个源文件，约 1,400 行
**运行模式**: `tsx src/supervisor.ts`（监督模式）或 `tsx src/index.ts`（单次）

---

## 1. 架构概览

```
daemon/
├── src/
│   ├── index.ts         入口（CLI 参数 → DaemonCore）
│   ├── core.ts          DaemonCore：WS 连接、消息派发、agent 生命周期
│   ├── cli.ts           slock CLI（commander.js，20+ 命令）
│   ├── auth.ts          4 种认证模式加载
│   ├── client.ts        HTTP API 客户端 + 路径重写（14 条规则）
│   ├── proxy.ts         undici ProxyAgent（企业代理 + NO_PROXY）
│   ├── output.ts        输出格式化工具
│   ├── system-prompt.ts 自主模式/中继模式系统提示生成
│   ├── claude-setup.ts  slock 包装器写盘 + 系统提示预设
│   ├── claude-print.ts  一次性 Claude `--print` 执行
│   ├── supervisor.ts    监督进程（崩溃重启 + 文件 watch）
│   └── drivers/
│       ├── claude.ts            ClaudeDriver（--print 模式）
│       ├── persistent-claude.ts PersistentClaude（常驻 stream-json 模式）
│       └── probe.ts             Claude CLI 可用性探测
├── package.json
└── tsconfig.json
```

---

## 2. 逐模块完成度

### 2.1 入口与核心（index.ts + core.ts）— ✅ 完整

| 功能 | 状态 | 备注 |
|------|------|------|
| `--server-url` / `--api-key` 参数解析 | ✅ | 已实现 |
| WebSocket 连接（Bearer 机器令牌） | ✅ | 含 `ready` 握手 |
| 断线重连（指数退避 1s→30s） | ✅ | `scheduleReconnect()` |
| 4001 鉴权拒绝 → 不重连，友好退出提示 | ✅ | |
| Agent 路由表（消息→@名→agentId） | ✅ | `agentDrivers` / `agentNameToId` |
| `agent:start` 注册新 agent | ✅ | 覆盖 3 种 payload 格式 |
| `agent:stop` 注销 agent | ✅ | 清理 4 个 map |
| `agent:deliver` 消息派发 | ✅ | @提及检测 + DM + 线程 |
| `reminder.fire` 提醒触发 | ✅ | 路由到 agent 工作区 |
| ping/pong 心跳 | ✅ | |
| 预加载已有 agent 列表 | ✅ | `loadExistingAgents()` |
| Claude CLI 可用性检测 | ✅ | 缺失时不阻断，打印指引 |
| slock 包装器生成 | ✅ | Windows `.bat` + esbuild 打包 |
| 停止（关闭 WS + 终止子进程） | ✅ | `stop()` |

### 2.2 CLI 命令（cli.ts）— ✅ 完整

| 命令组 | 命令 | 状态 | 备注 |
|--------|------|------|------|
| `auth` | `whoami` | ✅ | 打印 agent 上下文 |
| `channel` | `members`, `join`, `leave` | ✅ | |
| `thread` | `unfollow` | ✅ | |
| `server` | `info` | ✅ | 频道/agent/成员列表 |
| `message` | `send`, `check`, `read`, `search`, `react` | ✅ | send 从 stdin 读内容 |
| `attachment` | `upload`, `view` | ✅ | multipart + 文件下载 |
| `task` | `list`, `create`, `claim`, `unclaim`, `update` | ✅ | 完整任务生命周期 |
| `profile` | `show`, `update` | ✅ | |
| `integration` | `list`, `login` | ✅ | |
| `reminder` | `schedule`, `list`, `cancel`, `snooze`, `update`, `log` | ✅ | 完整 CRUD + 日志 |
| `action` | `prepare` | ✅ | 动作卡片 |

**共 23 个子命令**，覆盖 agent 在平台上的全部操作场景。

### 2.3 认证（auth.ts）— ✅ 完整

| 模式 | 来源 | 状态 | 用途 |
|------|------|------|------|
| managed-runner | `SLOCK_AGENT_PROXY_TOKEN` / `_FILE` | ✅ | 代理式认证（Phase 2+） |
| self-hosted-runner | `SLOCK_AGENT_CREDENTIAL_KEY_FILE` | ✅ | 凭据密钥文件 |
| legacy-machine | `SLOCK_AGENT_TOKEN_FILE` | ✅ | 旧式令牌文件 |
| legacy-machine | `SLOCK_AGENT_TOKEN` | ✅ | 旧式令牌环境变量 |

4 种模式串行探测，均有明确的错误信息和 `AgentBootstrapError` 错误码。

### 2.4 API 客户端（client.ts）— ✅ 完整

| 特性 | 状态 | 备注 |
|------|------|------|
| 路径重写（14 条规则） | ✅ | 内部路径 → `/internal/agent-api/*` |
| 通用 `request<T>()` | ✅ | JSON |
| `requestMultipart<T>()` | ✅ | FormData 上传 |
| 代理感知（undici ProxyAgent） | ✅ | proxy.ts 提供 |
| 认证头注入 | ✅ | `Authorization` + `X-Agent-Id` + `X-Slock-Client` |
| 403 Scope 拒绝解析 | ✅ | 含 `requiredScope` 错误消息 |
| 配置化能力头 | ✅ | `X-Slock-Agent-Active-Capabilities` |

### 2.5 Claude 驱动（drivers/）— ⚠️ 功能完整，缺少 E2E 测试

#### claude-print.ts（一次性模式）
| 特性 | 状态 | 备注 |
|------|------|------|
| `--print` 输出解析 | ✅ | stream-json 事件流 |
| 会话 resume | ✅ | `--resume` |
| 系统提示文件注入 | ✅ | `--append-system-prompt-file` |
| Windows .cmd 适配 | ✅ | shell: true |
| 超时保护（120s） | ✅ | |
| stdin prompt 传入 | ✅ | 避开 Windows cmd 转义问题 |
| JSON 行容错 | ✅ | 非 JSON 行静默跳过 |

#### persistent-claude.ts（常驻模式）
| 特性 | 状态 | 备注 |
|------|------|------|
| 常驻 `stream-json` 进程 | ✅ | 保持温热 |
| 消息队列 + 串行执行 | ✅ | `send()` → `pump()` |
| 卡死超时保护（默认 180s） | ✅ | kill → 自动 cleanup |
| 自动重启 | ✅ | 进程退出后下次 `pump()` 重 spawn |
| stderr 日志转发 | ✅ | 截断到 160 字符 |
| stdout 1MB 缓冲区保护 | ✅ | 防 OOM |

#### probe.ts
| 特性 | 状态 | 备注 |
|------|------|------|
| Windows 路径探测 | ✅ | 5 个候选位置 |
| `where` / `which` 回退 | ✅ | 跨平台兼容 |
| Windows .cmd 检测 | ✅ | shell 降级 |
| `--version` 执行 | ✅ | |

### 2.6 基础设施

#### proxy.ts — ✅ 完整
| 特性 | 状态 |
|------|------|
| HTTPS_PROXY / HTTP_PROXY / ALL_PROXY | ✅ |
| WSS_PROXY / WS_PROXY | ✅ |
| NO_PROXY 解析（含 `*`、端口号、`*.` 前缀） | ✅ |
| ProxyAgent 缓存 | ✅ |

#### system-prompt.ts — ✅ 完整
| 模式 | 状态 | 内容 |
|------|------|------|
| 中继模式（relay） | ✅ | Claude 只输出回复文本，daemon 转发 |
| 自主模式（autonomous） | ✅ | 完整 slock 命令参考 + MEMORY.md + 任务协作规则 |

#### supervisor.ts — ✅ 完整
| 特性 | 状态 |
|------|------|
| 崩溃自动重启 | ✅ |
| 退避（1 分钟内 >5 次 → 30s） | ✅ |
| 文件 watch（dev 模式） | ✅ |
| 干净 SIGINT/SIGTERM | ✅ |
| 参数透传 | ✅ |

---

## 3. 缺口分析

### 🔴 高优先级

| # | 缺口 | 影响 | 建议 |
|---|------|------|------|
| 1 | **零测试覆盖** | 无任何单元/集成测试，daemon 的核心流程（WS 消息派发、@提及路由、持久化进程管理）未经自动化验证 | 添加 vitest 配置，为 core.ts 的关键路径（`handleMessage`、`dispatchToAgent`、`mentionedAgentNames`）编写测试 |
| 2 | **PersistentClaude 输出未捕获** | `onStdout` 只检测 `type: "result"` 结束信号，不获取回复文本；在 relay 模式下 daemon 无法拿到 Claude 的回复并转发 | 添加上下文管理器，支持 `send()` → `result` 回传 |

### 🟡 中优先级

| # | 缺口 | 影响 | 建议 |
|---|------|------|------|
| 3 | **relay 模式实际未启用** | `dispatchToAgent` 默认走自主模式（`generateSystemPrompt`）+ `usePersistent`；中继模式仅在对 `generateRelaySystemPrompt` 的调用中作为提示参数传递，实际执行路径从未使用 | 明确 relay 模式的执行路径或移除死代码 |
| 4 | **@提及有重叠误匹配风险** | 短名可能是长名的前缀（如 `bot` vs `bot-v2`），虽然按长度排序优先，但不防短名在长名之前的字符含 @ 误匹配 | 建议用正则 `@name\b` 加单词边界 |
| 5 | **agent 消息自回环过滤薄弱** | 只检查 `senderType === "agent"` 和 `content.startsWith("🤖 ")` 两个条件；若有 agent 发不以 🤖 开头的消息，可能触发自回环 | 用 `senderId` 精确过滤本机 agent |

### 🟢 低优先级

| # | 缺口 | 影响 | 建议 |
|---|------|------|------|
| 6 | **仅 Windows** | 路径硬编码 Windows 风格（`COMPUTERNAME`、`APPDATA`、`.cmd`、`shell: true`）。已知 deferred decision | 确认暂缓跨平台 |
| 7 | **console.log 日志** | 无结构化日志框架，不便于运维收集 | 可考虑 pino 或简单日志前缀标准化 |
| 8 | **无构建优化** | dev 用 `tsx`，生产仅 `tsc` 无 bundling | esbuild 已为 slock CLI 做了 bundle，可为 daemon 主入口也 bundle |

---

## 4. 模块间依赖关系

```
index.ts
  └─ core.ts
       ├─ client.ts ── proxy.ts
       ├─ persistent-claude.ts ── probe.ts
       ├─ claude-print.ts ── probe.ts
       ├─ system-prompt.ts
       └─ auth.ts

cli.ts
  ├─ auth.ts ── client.ts ── proxy.ts
  └─ output.ts

supervisor.ts
  └─ index.ts (子进程)

claude-setup.ts (独立工具)
```

---

## 5. 服务端-守护进程接口对照

| 服务端 `broadcast` 事件类型 | Daemon handler | 状态 |
|----------------------------|----------------|------|
| `agent:start` | `case "agent:start"` | ✅ |
| `agent:stop` | `case "agent:stop"` | ✅ |
| `agent:deliver` | `case "agent:deliver"` → @提及 / DM | ✅ |
| `reminder.fire` | `case "reminder.fire"` → agent 跟进 | ✅ |
| `ping` | `case "ping"` → pong | ✅ |

| 服务端 HTTP 端点 | CLI 命令 | 状态 |
|-------------------|----------|------|
| `GET /internal/agent/:id/server` | `slock server info` | ✅ |
| `POST /internal/agent/:id/send` | `slock message send` | ✅ |
| `GET /internal/agent/:id/history` | `slock message read` | ✅ |
| `GET /internal/agent/:id/receive` | `slock message check` | ✅ |
| `GET /internal/agent/:id/search` | `slock message search` | ✅ |
| `POST /internal/agent/:id/messages/:id/reactions` | `slock message react` | ✅ |
| `POST /internal/agent/:id/channels/:name/join` | `slock channel join` | ✅ |
| `POST /internal/agent/:id/channels/:name/leave` | `slock channel leave` | ✅ |
| `GET /internal/agent/:id/channel-members` | `slock channel members` | ✅ |
| `POST /internal/agent/:id/threads/unfollow` | `slock thread unfollow` | ✅ |
| `POST /internal/agent/:id/upload` | `slock attachment upload` | ✅ |
| `GET /api/attachments/:id` | `slock attachment view` | ✅ |
| `GET /internal/agent/:id/tasks` | `slock task list` | ✅ |
| `POST /internal/agent/:id/tasks` | `slock task create` | ✅ |
| `POST /internal/agent/:id/tasks/claim` | `slock task claim` | ✅ |
| `POST /internal/agent/:id/tasks/unclaim` | `slock task unclaim` | ✅ |
| `POST /internal/agent/:id/tasks/update-status` | `slock task update` | ✅ |
| `GET /internal/agent/:id/profile` | `slock profile show` | ✅ |
| `POST /internal/agent/:id/profile` | `slock profile update` | ✅ |
| `GET /internal/agent/:id/integrations` | `slock integration list` | ✅ |
| `POST /internal/agent/:id/integrations/login` | `slock integration login` | ✅ |
| `POST /internal/agent/:id/reminders` | `slock reminder schedule` | ✅ |
| `GET /internal/agent/:id/reminders` | `slock reminder list` | ✅ |
| `DELETE /internal/agent/:id/reminders/:id` | `slock reminder cancel` | ✅ |
| `POST /internal/agent/:id/reminders/:id/snooze` | `slock reminder snooze` | ✅ |
| `PATCH /internal/agent/:id/reminders/:id` | `slock reminder update` | ✅ |
| `GET /internal/agent/:id/reminders/:id/log` | `slock reminder log` | ✅ |
| `POST /internal/agent/:id/prepare-action` | `slock action prepare` | ✅ |

**共 28 个接口点，全部覆盖。**

---

## 6. 总体评分

| 维度 | 评分 | 说明 |
|------|------|------|
| **功能完整度** | 9/10 | 所有服务端接口在 CLI 层和 WS 事件层均有对应 handler，仅 relay 模式输出未回传 |
| **架构质量** | 7/10 | 模块职责清晰，但 `core.ts`（448 行）略大；auth.ts 的 4 种模式设计良好 |
| **可测试性** | 2/10 | 零测试；DaemonCore 有 WS 和子进程硬依赖，不易单测 |
| **跨平台** | 4/10 | Windows-first，已知 deferred |
| **运维成熟度** | 5/10 | supervisor 进程管理完善但缺少结构化日志和健康检查接口 |
| **文档** | 6/10 | 中文注释详实，但缺少架构概览文档 |

**整体完成度：7/10** — 主体功能完备，可正常运行；首要改进项为测试覆盖 + relay 模式输出回传。

---

## 附录：文件统计

| 文件 | 行数 | 职责 |
|------|------|------|
| `core.ts` | 448 | 核心 daemon 逻辑 |
| `cli.ts` | 671 | slock CLI 命令 |
| `system-prompt.ts` | 85 | 系统提示模板 |
| `auth.ts` | 141 | 认证上下文加载 |
| `client.ts` | 160 | HTTP API 客户端 |
| `proxy.ts` | 78 | 代理感知 dispatcher |
| `drivers/persistent-claude.ts` | 140 | 常驻 Claude 进程 |
| `drivers/claude.ts` | 71 | 一次性 Claude 驱动 |
| `drivers/probe.ts` | 45 | Claude 探测 |
| `claude-print.ts` | 99 | Claude 执行封装 |
| `claude-setup.ts` | 79 | 设置工具 |
| `supervisor.ts` | 75 | 监督进程 |
| `output.ts` | 18 | 输出工具 |
| `index.ts` | 37 | 入口 |
| **合计** | **~1,987** | |
