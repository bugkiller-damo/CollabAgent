# ① Slock Daemon 当前状态全景图

> **⚠️ 已归档（2026-08-20）**：本文描述的是 2026-07-15 重构前的 12 文件/447 行单体
> `core.ts` 时代，与现状严重不符。现状核查见 `docs/2026-08-20/01-daemon-evolution-plan.md`
> §1；执行跟踪见 `docs/2026-08-20/02-daemon-evolution-tracker.md`。本文仅作历史参照保留。

> 分析日期：2026-07-15
> 基于代码：`packages/daemon/src/`
> 目的：在重构前完整记录现有代码的模块、函数、依赖和边界

---

## 目录

1. [源文件清单](#1-源文件清单)
2. [DaemonCore 类完整分解](#2-daemoncore-类完整分解)
3. [PersistentClaude 完整分解](#3-persistentclaude-完整分解)
4. [依赖关系图](#4-依赖关系图)
5. [API 调用清单](#5-api-调用清单)
6. [环境变量清单](#6-环境变量清单)
7. [未被覆盖的路径和已知缺陷](#7-未被覆盖的路径和已知缺陷)

---

## 1. 源文件清单

```
packages/daemon/src/
├── index.ts                   # 入口：参数解析 → DaemonCore.start()
├── core.ts                    # ★ 核心主类 (447 行)
├── cli.ts                     # slock CLI (29 个子命令，Commander.js)
├── auth.ts                    # 4 种认证模式的环境变量读取
├── client.ts                  # ApiClient HTTP 客户端 (路径重写)
├── proxy.ts                   # 代理配置 (undici ProxyAgent)
├── output.ts                  # CLI 输出 helper
├── system-prompt.ts           # System prompt 生成 (autonomous + relay)
├── claude-print.ts            # 一次性 Claude --print 封装
├── claude-setup.ts            # 遗留代码 (旧版 system prompt + wrapper)
└── drivers/
    ├── persistent-claude.ts   # 持久化 Claude 子进程 (队列 + pump)
    ├── probe.ts               # Claude CLI 检测
    └── claude.ts              # 遗留: ClaudeDriver (一次性查询)
```

### 文件按功能分组

| 功能域 | 文件 | 行数 | 成熟度 |
|--------|------|------|--------|
| **入口** | `index.ts` | 37 | 稳定 |
| **主控/消息路由** | `core.ts` | 447 | 脆弱（单体文件） |
| **CLI 工具** | `cli.ts` | 大 | 正常 |
| **认证** | `auth.ts` | 140 | 稳定 |
| **HTTP 客户端** | `client.ts` | 159 | 稳定 |
| **代理配置** | `proxy.ts` | 77 | 稳定 |
| **输出帮助** | `output.ts` | 24 | 稳定 |
| **Prompt 生成** | `system-prompt.ts` | - | 正常 |
| **一次性 Claude** | `claude-print.ts` | - | 正常 |
| **持久化 Claude** | `drivers/persistent-claude.ts` | - | 脆弱 |
| **Claude 探测** | `drivers/probe.ts` | - | 正常 |
| **遗留代码** | `claude-setup.ts`, `drivers/claude.ts` | - | 废弃 |

---

## 2. DaemonCore 类完整分解

**位置**：`packages/daemon/src/core.ts`（447 行）
**类名**：`DaemonCore`

### 2.1 属性 (16 个)

| 属性 | 类型 | 用途 | 初始化位置 |
|------|------|------|-----------|
| `ws` | `WebSocket \| null` | 到服务端的 WS 连接 | `connect()` |
| `serverUrl` | `string` | 服务端 URL | 构造函数 |
| `apiKey` | `string` | 机器令牌 | 构造函数 |
| `slockDir` | `string \| null` | `.slock` 目录路径 | `setupSlockWrapper()` |
| `reconnectTimer` | `Timeout \| null` | 重连定时器 | `scheduleReconnect()` |
| `reconnectDelay` | `number` | 当前重连延迟(ms) | 初始 1000，指数退避至 30000 |
| `authFailed` | `boolean` | 鉴权失败标记(不再重连) | `close` 事件 code=4001 |
| `client` | `ApiClient` | HTTP 客户端 | 构造函数 |
| `agentId` | `string` | 硬编码 UUID 000...001 | 属性初始化 |
| `agentDrivers` | `Map<string, boolean>` | 已知 agent 名注册表 | 仅作存在性判断 |
| `agentSessions` | `Map<string, string>` | agent → sessionId 映射 | 仅一次性模式使用 |
| `agentNameToId` | `Map<string, string>` | agent 名 → UUID 映射 | `loadExistingAgents` |
| `agentInfo` | `Map<string, {displayName?, description?}>` | agent 元信息 | `loadExistingAgents` |
| `persistentSessions` | `Map<string, PersistentClaude>` | 持久化 session 缓存 | `dispatchToAgent` |
| `usePersistent` | `boolean` | 是否启用持久化模式 | 环境变量 `SLOCK_PERSISTENT_CLAUDE` |
| `config` | `DaemonConfig` | { serverUrl, apiKey, dataDir? } | 构造函数参数 |

**问题**：硬编码 `agentId` 为 `00000000-0000-0000-0000-000000000001`，不支持多 daemon 实例同时运行。

### 2.2 方法 (18 个)

#### 启动相关

| 方法 | 行号 | 调用者 | 功能 | 问题 |
|------|------|--------|------|------|
| `start()` | 48-54 | index.ts | 启动入口：预检→包装→连接→加载 | 同步调用异步方法(`loadExistingAgents`) |
| `checkClaude()` | 58-78 | start() | 检测 claude CLI | 仅探测，不强制 |
| `setupSlockWrapper()` | 81-130 | start() | 生成 slock.bat + esbuild 打包 CLI | 同步 I/O |
| `loadExistingAgents()` | 133-151 | start() | 从服务端加载 agent 列表 | 异步但不 await，可能未完成就被使用 |

#### 连接管理

| 方法 | 行号 | 调用者 | 功能 | 问题 |
|------|------|--------|------|------|
| `connect()` | 153-196 | start(), scheduleReconnect() | 建立 WS 连接 | 无超时控制 |
| `scheduleReconnect()` | 213-220 | close 事件 | 指数退避重连 | min=1s, max=30s, 乘数 2x |

#### 消息处理

| 方法 | 行号 | 调用者 | 功能 | 问题 |
|------|------|--------|------|------|
| `handleMessage()` | 338-438 | ws.on("message") | 消息分发（6 种类型） | **单体 switch，447 行文件** |

**支持的 6 种消息类型**：

| 类型 | 动作 | 风险 |
|------|------|------|
| `agent:start` | 注册 agent，重置 persistent session | 启动时未 await，注册时序不确定 |
| `agent:deliver` | 解析内容 → @匹配 → 派发给 agent | catch 吞错误 |
| `agent:stop` | 从路由表注销，stop persistent session | name→id 双向遍历，非一致性好 |
| `reminder.fire` | 唤醒 agent 做跟进 | 同上 |
| `ping` | 回复 pong | 正常 |

#### 派发相关

| 方法 | 行号 | 调用者 | 功能 | 问题 |
|------|------|--------|------|------|
| `dispatchToAgent()` | 279-307 | runAgent(), runAgentDm(), runAgentReminder() | 核心派发 | catch 吞全部错误 |
| `runAgent()` | 310-314 | handleMessage(agent:deliver) | @回复 | - |
| `runAgentDm()` | 318-320 | handleMessage(dm) | 私信回复 | - |
| `runAgentReminder()` | 324-331 | handleMessage(reminder.fire) | 提醒触发 | - |

#### 工具方法

| 方法 | 行号 | 调用者 | 功能 | 问题 |
|------|------|--------|------|------|
| `mentionedAgentNames()` | 199-207 | findMentionedAgent() | @名匹配 | 字符串 contains 匹配，可能误匹配 |
| `findMentionedAgent()` | 209-210 | handleMessage | 首个 @agent 查找 | - |
| `resolveAgentId()` | 223-227 | dispatchToAgent | 名字→UUID | - |
| `agentWorkspace()` | 231-259 | dispatchToAgent | 创建 agent 工作区目录 | 每次调用都重新创建，含 await import |
| `writeAgentPrompt()` | 262-275 | dispatchToAgent | 写 system prompt 文件 | 包含 `await import` 动态 import |
| `logStatus()` | 333-335 | (未在其他方法中调用) | 状态日志 | **死代码，无调用者** |
| `stop()` | 440-446 | index.ts, close(code=4001) | 清理所有资源 | 不等待 persistent session 停止完成 |

---

## 3. PersistentClaude 完整分解

**位置**：`packages/daemon/src/drivers/persistent-claude.ts`

### 构造函数参数

| 参数 | 类型 | 用途 |
|------|------|------|
| `cwd` | `string` | 工作目录 |
| `systemPromptFile` | `string` | system prompt 文件路径 |
| `env` | `Record<string, string>` | 环境变量 |
| `label` | `string` | 日志标签 |

### 内部状态

| 状态 | 类型 | 说明 |
|------|------|------|
| `process` | `ChildProcess \| null` | Claude 子进程 |
| `queue` | `string[]` | 消息队列 (FIFO) |
| `pumping` | `boolean` | 是否正在处理队列 |
| `started` | `boolean` | 是否已启动 |
| `turnTimer` | `Timer \| null` | 超时定时器 |
| `buffer` | `string` | 输出缓冲区 |

### 方法

| 方法 | 功能 | 已知问题 |
|------|------|----------|
| `send(text)` | 入队消息 → 调用 `pump()` | 无返回 Promise，调用方无法知道完成 |
| `pump()` | 处理队列：spawn → write stdin → 读 stdout | **关键脆弱方法** |
| `stop()` | kill 进程 | 无优雅关闭，直接 SIGTERM |
| `restart()` | stop() → spawn() | 可能导致"前一进程未清理"竞态 |
| `writeStdin(text)` | 写入 claude stdin | 不考虑进程就绪状态 |

### spawn 参数

```
child_process.spawn(claudeCommand, [], {
  cwd,
  shell: true,
  env: { ...process.env, ...env, CLAUDE_SYSTEM_PROMPT: systemPromptFile },
  stdio: ['pipe', 'pipe', 'pipe']
})
```

**问题**：
- 无 `node-pty`，子进程没有真实终端，可能丢失 ANSI/颜色输出
- `shell: true` 在 Windows 下使用 cmd.exe（路径含空格风险）
- 无超时控制 spawn 本身（不是 turn timeout，是进程启动超时）
- 无 readiness check（不知道 claude 是否就绪就开始写 stdin）
- turn timeout 默认 180s → 不可接受

### 消息流

```
send("hello") → queue.push("hello") → pump()
  → if (!process) spawn()
  → if (pumping) return (另一个 pump 正在处理)
  → shift queue → process.stdin.write(text)
  → wait for stdout (无超时) → process.stdout.on("data")
  → 读取到特定标记 → 完成
  → pump() next
```

**问题**：pump 的"等待完成"逻辑判断条件不清晰，使用输出中的特定文本标记而非结构化协议。

---

## 4. 依赖关系图

```
index.ts
  └─→ core.ts (DaemonCore)
         ├─→ ws (WebSocket)
         ├─→ client.ts (ApiClient)
         │     └─→ proxy.ts (ProxyAgent from undici)
         ├─→ auth.ts (loadAgentContext)
         ├─→ claude-print.ts
         │     └─→ system-prompt.ts
         ├─→ PersistentClaude
         │     └─→ child_process.spawn
         ├─→ probe.ts
         └─→ system-prompt.ts
```

### 外部 npm 依赖

| 包 | 用途 | 备注 |
|----|------|------|
| `ws` | WebSocket 客户端 | 核心依赖 |
| `commander` | CLI 框架 | 仅 `cli.ts` 使用 |
| `undici` | HTTP 代理 (ProxyAgent) | ProxyAgent 类 |
| `esbuild` | CLI 打包 (dev 时) | 仅在 `setupSlockWrapper()` |
| `@anthropic-ai/sdk` | (声明但可能未在 daemon 中使用) | 核实 |
| `@modelcontextprotocol/sdk` | MCP 支持 | 核实 |
| `zod` | 校验 | 核实是否在 daemon 中使用 |
| `tsx` | 开发运行 | devDependencies |

**已声明但不确定是否在 daemon 中使用的依赖**（需核实 `import` 语句）：
- `@anthropic-ai/sdk` — 可能在 PersistentClaude 中用
- `@modelcontextprotocol/sdk` — 可能在 cli.ts 中用
- `zod` — 可能在 client.ts 中用

---

## 5. API 调用清单

所有 API 调用都通过 `ApiClient` 或直接 `fetch`：

| 端点 | 方法 | 调用位置 | 用途 |
|------|------|----------|------|
| `/api/agents` | GET | `loadExistingAgents()` in core.ts | 加载已注册 agent |
| `/api/channels/:id/members` | (通过 CLI) | cli.ts | 频道成员 |
| `/api/messages` | POST | (通过 CLI) | 发送消息 |
| ... 27+ 个其他端点 | - | cli.ts (29 子命令) | 由 slock CLI 子命令覆盖 |

`ApiClient` (`client.ts`) 做了 **14 条路径重写规则**（`managed-runner`/`self-hosted-runner` 模式）：

| 原始路径 | 重写后 |
|----------|--------|
| `/internal/agent/:id/server` | `/internal/agent-api/server` |
| `/internal/agent/:id/send` | `/internal/agent-api/send` |
| `/internal/agent/:id/history` | `/internal/agent-api/history` |
| `/internal/agent/:id/search` | `/internal/agent-api/search` |
| `/internal/agent/:id/channel-members` | `/internal/agent-api/channel-members` |
| `/internal/agent/:id/profile` | `/internal/agent-api/profile` |
| `/internal/agent/:id/integrations` | `/internal/agent-api/integrations` |
| `/internal/agent/:id/upload` | `/internal/agent-api/upload` |
| `/internal/agent/:id/resolve-channel` | `/internal/agent-api/resolve-channel` |
| `/internal/agent/:id/threads/unfollow` | `/internal/agent-api/threads/unfollow` |
| `/internal/agent/:id/prepare-action` | `/internal/agent-api/prepare-action` |
| `/internal/agent/:id/tasks` | `/internal/agent-api/tasks` |
| `/internal/agent/:id/reminders` | `/internal/agent-api/reminders` |
| `/internal/agent/:id/receive` | `/internal/agent-api/events` |
| `/internal/agent/:id/messages/:msgId/reactions` | `/internal/agent-api/messages/:msgId/reactions` |
| `/internal/agent/:id/channels/:name/join\|leave` | `/internal/agent-api/channels/:name/join\|leave` |

---

## 6. 环境变量清单

| 变量 | 使用位置 | 默认值 | 说明 |
|------|----------|--------|------|
| `SLOCK_AGENT_ID` | `auth.ts` | (必填) | Agent UUID |
| `SLOCK_SERVER_URL` | `auth.ts` | (必填) | 服务端 URL |
| `SLOCK_SERVER_ID` | `auth.ts` | null | 服务端 ID |
| `SLOCK_AGENT_PROXY_URL` | `auth.ts` | - | 代理 URL |
| `SLOCK_AGENT_PROXY_TOKEN` | `auth.ts` | - | 代理 token |
| `SLOCK_AGENT_PROXY_TOKEN_FILE` | `auth.ts` | - | 代理 token 文件 |
| `SLOCK_AGENT_CREDENTIAL_KEY_FILE` | `auth.ts` | - | 凭证文件 |
| `SLOCK_AGENT_TOKEN_FILE` | `auth.ts` | - | 遗留 token 文件 |
| `SLOCK_AGENT_TOKEN` | `auth.ts` | - | 遗留 token (直接传值) |
| `SLOCK_AGENT_ACTIVE_CAPABILITIES` | `auth.ts` | `send,read,...` | 能力集(逗号分隔) |
| `SLOCK_PERSISTENT_CLAUDE` | `core.ts` | "1" (启用) | 持久化模式开关 |
| `SLOCK_HOME` | (构建产物) | `~/.slock` | 数据目录 |
| `COMPUTERNAME` | `core.ts` | "unknown" | 主机名 (用于 WS ready 消息) |

---

## 7. 未被覆盖的路径和已知缺陷

### 7.1 功能缺失清单（与 Hive 对比）

| 功能 | Hive 源文件 | Slock 状态 |
|------|-------------|-----------|
| 命令路径解析 | `agent-command-resolver.ts` (PATH搜索 + 跨平台) | ❌ 裸 `shell: true` spawn |
| 启动流水线 | `agent-run-starter.ts` (7 步顺序执行) | ❌ `dispatchToAgent()` 内联 3 行 |
| Token 生命周期 | `agent-tokens.ts` (签发/验证/吊销) | ❌ 纯读取环境变量 |
| 活跃运行注册 | `live-run-registry.ts` (Map + exit promise) | ❌ 无 |
| 退出处理链 | `agent-run-exit-handler.ts` (6 步清理) | ❌ 无 |
| 智能 stdin 写入 | `post-start-input-writer.ts` (等待提示符) | ❌ 直接 `process.stdin.write()` |
| 重启恢复 | `restart-policy.ts` (恢复摘要注入) | ❌ 无 |
| 消息格式化 | `agent-stdin-dispatcher.ts` (结构化消息) | ❌ 透传纯文本 |
| 并发启动保护 | `agent-runtime.ts` (startPromises dedup) | ❌ 无 |
| 跨平台命令 | `agent-command-resolver.ts` (PATHEXT/.cmd/.bat) | ❌ `child_process.spawn` (shell:true) |
| 启动指令注入 | `agent-startup-instructions.ts` (身份+规则) | ❌ 仅 system prompt 文件 |
| 会话恢复 | `session-capture-*.ts` (6 种 CLI 会话) | ❌ 仅一次性模式有 sessionId |
| 运行持久化 | `agent-run-store.ts` (SQLite) | ❌ 全内存 |

### 7.2 代码缺陷清单

| 严重度 | 缺陷 | 位置 | 行号 | 后果 |
|--------|------|------|------|------|
| 🔴 严重 | catch 块吞噬错误 | `handleMessage`, `dispatchToAgent` | ~305, ~406 | 静默失败，用户不知出问题 |
| 🔴 严重 | `loadExistingAgents` 异步但未 `await` | `start()` | 53 | agent 列表在 WS 连接前可能未就绪 |
| 🟡 中 | `logStatus()` 定义但无调用 | core.ts | 333-335 | **死代码** |
| 🟡 中 | 硬编码 agentId = 000...0001 | core.ts | 24 | 不支持多实例 |
| 🟡 中 | `agentWorkspace` 使用 `await import` | core.ts | 232-233 | 每次调用重复 import fs/path |
| 🟡 中 | @名匹配用 `includes("@"+name)` | core.ts | 204 | 短名是长名前缀时误匹配 |
| 🟡 中 | turn timeout = 180s 不可配置 | persistent-claude.ts | - | 进程挂了等 3 分钟才发现 |
| 🟢 低 | `restart()` 无时序保护 | persistent-claude.ts | - | stop→spawn 可能竞态 |
| 🟢 低 | Windows `.bat` 对百分号不转义 | core.ts | 114-121 | 路径含 `%` 时 break |

### 7.3 代码索引

```
文件:packages/daemon/src/core.ts
  start()               :48-54    缺陷: 未 await loadExistingAgents
  checkClaude()         :58-78    正常
  setupSlockWrapper()   :81-130   Windows .bat 转义
  loadExistingAgents()  :133-151  缺陷: 无 await
  connect()             :153-196  正常
  scheduleReconnect()   :213-220  正常
  mentionedAgentNames() :199-207  缺陷: 字符串 includes 匹配
  findMentionedAgent()  :209-210  正常
  resolveAgentId()      :223-227  正常
  agentWorkspace()      :231-259  缺陷: await import
  writeAgentPrompt()    :262-275  缺陷: await import
  dispatchToAgent()     :279-307  缺陷: catch 吞错误
  runAgent()            :310-314  正常
  runAgentDm()          :318-320  正常
  runAgentReminder()    :324-331  正常
  logStatus()           :333-335  死代码: 无调用者
  handleMessage()       :338-438  脆弱: 447 行单体文件中的 switch
  stop()                :440-446  缺陷: 不 await 持久 session 停止

文件:packages/daemon/src/drivers/persistent-claude.ts
  constructor           :         -    正常
  send(text)            :         -    缺陷: 无返回 Promise
  pump()                :         -    脆弱: 文本标记判断完成
  stop()                :         -    缺陷: 非优雅关闭
  restart()             :         -    缺陷: 时序竞态
  writeStdin(text)      :         -    缺陷: 不考虑就绪状态

文件:packages/daemon/src/auth.ts
  loadAgentContext()    :44-140   正常 (4 种认证模式)
  readTokenFromFile()   :27-41    正常

文件:packages/daemon/src/client.ts
  ApiClient class       :         -    正常 (14 条路径重写)
```

### 7.4 核心类对比

| 维度 | Hive `src/server/` | Slock `daemon/src/` |
|------|-------------------|---------------------|
| 源文件数 | ~125 | 12 (含 2 个遗留) |
| 核心类行数 | 分散在多个文件 | `core.ts` 447 行单体 |
| agent 管理文件 | ~20 个 | 3 个 (core + persistent-claude + probe) |
| 启动流水线 | 完整 7 步 | `dispatchToAgent` 内联 3 行 |
| 错误处理 | 每步骤可回滚 | catch block 全部吞掉 |
| 跨平台 | 完整 PATH/pathext 处理 | 裸 `shell: true` |
