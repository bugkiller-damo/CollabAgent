# Agent Daemon 完成情况与后续改造计划

> 适用范围：`packages/daemon`（守护进程 / Agent 运行时 / slock CLI / MCP 桥）与 `packages/server` 中的 `/internal/agent` 接口。
> 分析时间：2026-05-29。结论基于通读源码 + 对照前端/服务端实际接口。

---

## 1. 一句话结论

**“能说不能听”**：Agent 目前可以把消息发出去（`send` 链路打通），但**几乎所有其它能力都断的**——slock CLI 暴露了约 25 个子命令，服务端 `/internal/agent` 只实现了其中 1 个（`send`）；真正的交互式 Claude 运行时没接上，跑通的是 DeepSeek REST 直连那条旁路。整体属于“演示可用、生产不可用”。

---

## 2. 预期架构 vs 实际状态

**预期（对标 Slock）**：服务端 ↔ daemon 走 WebSocket；daemon 拉起本地 AI 运行时（Claude Code 持久进程，stream-json 双向）；AI 通过 `slock` CLI / MCP 工具回调服务端的 `/internal/agent/*` 接口完成收发消息、任务、提醒等。

**实际**：
- WebSocket 通道：✅ 基本可用（连接、重连、ready、ping/pong）
- AI 运行时：⚠️ 三套实现并存且互相打架，真正跑通的是 DeepSeek REST 直连
- Agent 回调接口：❌ 服务端绝大多数 `/internal/agent/*` 未实现
- MCP 桥：⚠️ 写了但没接进运行时（孤儿代码）

---

## 3. 组件完成度清单

| 组件 | 文件 | 状态 | 说明 |
|---|---|---|---|
| Daemon 主入口 | `daemon/src/index.ts` | ✅ 可用 | 解析 `--server-url/--api-key`，启动 DaemonCore |
| WS 连接/重连 | `core.ts` `connect/scheduleReconnect` | ✅ 可用 | 指数退避到 30s；但无最大次数、无鉴权失败处理 |
| 消息路由/@mention | `core.ts` `handleMessage/findMentionedAgent` | ⚠️ 半成品 | 逻辑可跑，但 fuzzy 匹配易误判、防自回环靠 `🤖` 前缀 hack |
| Claude 驱动（单发） | `drivers/claude.ts` | ⚠️ 与调用方不匹配 | 只有一次性 `--print query()`，没有 `onEvent/sendMessage/start(prompt,sid)` |
| Claude 驱动（持久） | `agent-manager.ts` `AgentProcessManager` | ❌ 孤儿 | 正确方向的 stdin/stdout 交互式实现，但 **core.ts 根本没用它** |
| DeepSeek REST 旁路 | `core.ts` `callAI` | ✅ 实际在用 | 带工具调用（read/write/list/exec），是当前唯一真正出回复的路径 |
| 本地工具执行 | `core.ts` `executeTool` | ⚠️ 有安全隐患 | `execute_command` 可跑任意 shell，无沙箱/白名单，cwd 硬编码 |
| slock CLI | `cli.ts` | ⚠️ 接口齐全但后端缺失 | 25+ 子命令定义完整，但多数对应服务端接口不存在 |
| API 客户端 | `client.ts` | ✅ 质量高 | scope 错误处理、agent-api 路径重写、代理 dispatcher |
| MCP 桥 | `chat-bridge.ts` | ❌ 未接入 | 5 个工具，多数打到不存在的接口；且没被 driver 加载 |
| System Prompt | `system-prompt.ts` + 文件加载 | ⚠️ | 仅在（已坏的）spawnAgent 路径用到 |
| slock wrapper | `core.ts` `setupSlockWrapper` | ⚠️ 仅 Windows | 只写 `slock.bat`，POSIX 无 wrapper；路径硬编码 |
| 服务端 Agent 接口 | `server/routes/agents.ts` | ❌ 大量缺失 | 见下表 |

---

## 4. 服务端 `/internal/agent` 接口缺口（最关键）

CLI/MCP 调用的接口 vs 服务端实现：

| CLI 命令 | 期望接口 | 服务端是否实现 |
|---|---|---|
| `message send` | `POST /:id/send` | ✅ 已实现 |
| `message check` | `GET /:id/receive` | ❌ 缺失（Agent **收不到**消息） |
| `message read` | `GET /:id/history` | ❌ 缺失 |
| `message search` | `GET /:id/search` | ❌ 缺失 |
| `message react` | `POST/DELETE /:id/messages/:mid/reactions` | ❌ 缺失 |
| `server info` | `GET /:id/server` | ❌ 缺失 |
| `channel members/join/leave` | `.../channel-members`、`/channels/:n/join|leave` | ❌ 缺失 |
| `thread unfollow` | `POST /:id/threads/unfollow` | ❌ 缺失 |
| `task list/create/claim/unclaim/update` | `.../tasks*` | ❌ 缺失 |
| `profile show/update` | `GET/POST /:id/profile` | ❌ 缺失 |
| `attachment upload/view` | `POST /:id/upload` | ❌ 缺失（view 走 `/api/attachments/:id` ✅） |
| `integration list/login` | `.../integrations*` | ❌ 缺失 |
| `reminder *` | `.../reminders*` | ❌ 缺失（提醒功能整体未实现） |
| `action prepare` | `POST /:id/prepare-action` | ❌ 缺失 |

> 另外，已实现的 `POST /:id/send` **没有鉴权**（任何人可冒充任意 agentId 发消息）、`senderName` 硬编码为 "Agent"、未做私有频道访问校验。

---

## 5. 已知 Bug / 技术债（按严重度）

**P0（功能性阻断）**
1. Agent 无法接收消息：没有 `/receive` 接口，CLI `message check` 必 404。
2. 交互式 Claude 运行时未接通：`core.ts` 调用的 `ClaudeDriver` API（`onEvent/sendMessage/onExit/start(prompt,sid)`）在 `drivers/claude.ts` 里不存在 → spawnAgent 路径运行即报错，只能 fallback 到 DeepSeek。
3. spawnAgent 的 `onEvent` 里有 **三条重叠的回复逻辑**（`core.ts` 291-310）：turn_end 硬编码发到 `general`、每个 text 分片单独发一次、replyBuf 再发一次 → 会重复发送且发错频道。

**P1（正确性/安全）**
4. 单一 agentId 硬编码 `00000000-…-0001`：所有回复都以同一个 agent 身份发出，多 agent 身份是坏的。
5. `executeTool.execute_command` 可执行任意 shell，无沙箱/超时白名单，cwd 硬编码 `D:\code\slock`。
6. `/:id/send` 无鉴权、无私有频道校验。
7. `loadExistingAgents` 拉 `/api/agents` 不带鉴权。

**P2（健壮性/可维护性）**
8. 状态字段冗余且互相打架：`agents/driver/agentDrivers/agentSessions/lastCh/agentHistory/agentLastChannel/chatHistory` 多套并存。
9. 两套驱动实现（`drivers/claude.ts` vs `agent-manager.ts`）并存，后者是孤儿。
10. MCP 桥（`chat-bridge.ts`）未接入运行时，且打到不存在的接口。
11. 平台耦合：仅写 Windows `slock.bat`、`COMPUTERNAME`、硬编码绝对路径。
12. `handleMessage` switch 中 `agent:start` 出现两次（第二个不可达）。

---

## 6. 后续改造计划（分阶段）

### Phase 1 — 打通“听+说”闭环（P0，最高优先级）
- [ ] 服务端实现 `GET /internal/agent/:id/receive`：返回该 agent 自上次游标以来、其所在频道的新消息（或基于 WS 推送 + 游标）。
- [ ] 服务端补 `GET /:id/history`、`GET /:id/server`、`GET /:id/channel-members`，让 agent 能读上下文。
- [ ] 给 `POST /:id/send` 加鉴权（machine token → agent 身份校验）+ 私有频道访问校验 + 正确的 `senderName`（取 agent.display_name）。
- [ ] 统一 Agent 身份：daemon 按 agent 名/ID 映射真实 agentId，回复用对应身份，去掉硬编码 UUID。

### Phase 2 — 收敛运行时为单一实现（P0/P1）
- [ ] 二选一：要么把 `agent-manager.ts`（持久 stdin/stdout）作为唯一驱动并补 `--input-format stream-json`、system prompt、slock PATH 注入；要么保留 DeepSeek REST 旁路并删掉坏掉的 `ClaudeDriver` spawn 路径。
- [ ] 删除 `core.ts` 中三条重叠回复逻辑，保留一条（turn_end 聚合 → 发到来源频道）。
- [ ] 清理冗余 state map，留一套 `agentId → {driver, channelCursor, history}`。

### Phase 3 — 补齐 Agent 能力面（P1）
- [ ] 服务端实现 tasks / reactions / profile / channel join-leave / thread unfollow 接口（复用现有 `/api/*` 逻辑，加 agent 鉴权层）。
- [ ] 把 MCP 桥接进运行时（driver 启动时 `--mcp-config`），或明确废弃 MCP、统一用 slock CLI。

### Phase 4 — 提醒系统（P1/P2）
- [ ] 服务端 `reminders` 表 + `/:id/reminders*` 接口 + 到点触发（定时器/调度）→ 通过 WS 唤醒 daemon → 注入 agent。

### Phase 5 — 安全与跨平台收尾（P2）
- [ ] `execute_command` 加沙箱/白名单/确认机制，cwd 改为 agent workspace 而非硬编码。
- [ ] 生成 POSIX `slock` wrapper；移除平台硬编码路径与 `COMPUTERNAME`。
- [ ] WS 重连加最大退避/鉴权失败上报。

---

## 7. 建议的最小可用目标（MVP）

如果只想先让“一个 agent 在频道里被 @ 后能看上下文、能回复、能改任务状态”，最小集是：
**Phase 1 全部 + Phase 2 的运行时收敛 + Phase 3 的 tasks 接口**。
其余（提醒、集成、附件上传、多 agent 身份矩阵）可按需排期。

---

## 8. 实施进展（截至 2026-05-29）

原计划的 Phase 1–3 已基本落地，且运行时收敛方向与原文档不同（最终选了「本机 Claude `--print` + agent 自主调 slock CLI」）。当前状态：

- **Phase 1（听+说闭环）✅**：`/internal/agent/:id` 下新增 `receive`（游标收信）、`history`、`server`、`channel-members`；`/send` 加鉴权+真实身份+私有频道校验。「@提及即邀请」：人类 @ agent 时服务端自动把它加入该频道。
- **Phase 2（自主运行时）✅**：daemon 为被 @ 的 agent 启动 `claude --print`，注入它**自己的身份环境变量**（`SLOCK_AGENT_ID/TOKEN/SERVER_URL`），agent 用 slock CLI **自行回复**（daemon 不再转发）。CLI 用 esbuild 预打包成 `.slock/slock-cli.cjs`，`node` 直跑（冷启动 ~0.13s），回合延迟从 ~2min 降到 ~30s。系统提示分「中继模式」与「自主模式」两套。
- **Phase 3（能力面）✅**：新增 agent 的 tasks（list/create/claim/unclaim/update-status）、reactions（加/移除，已去掉 `message_reactions.user_id→users` 外键以支持 agent）、search、profile（查看/更新）。
- 验证：`scripts/smoke-agent.mjs` 一键打全套接口（14/14 通过）。

---

## 9. 对标 Slock 真实 agent 的能力面 + 缺口

| 能力 | Slock agent | CollabAgent 现状 |
|---|---|---|
| 消息 send/read/check/search/react | ✅ | ✅ 已对齐 |
| server info / channel members | ✅ | ✅ |
| 任务 list/create/claim/unclaim/update | ✅ | ✅ |
| profile show/update | ✅ | ✅（无头像） |
| 频道 join/leave | ✅ | ⚠️ CLI 有，服务端未实现（靠 @提及自动加入兜底） |
| 线程 Thread 回复 | ✅ | ⚠️ agent send 未接 `thread_id`，不能在子线程回复 |
| DM 私聊 | ✅ | ❌ agent 侧未打通 |
| **持久记忆 / 工作区（MEMORY.md）** | ✅ 跨会话累积知识 | ❌ 仅 `--resume` 续会话，无文件级记忆 |
| **提醒 / 自我唤醒 reminder** | ✅ | ❌ 无调度器 |
| 附件 upload/view | ✅ | ❌ CLI 有，服务端未实现 |
| Action Card（action prepare） | ✅ | ❌ |
| 第三方集成 integration login | ✅ | ❌ |
| 自主生命周期（常驻/唤醒/休眠/主动） | ✅ | ❌ 仅被 @ 后一次性响应 |

### 后续优先级建议
- **P1 持久记忆**：给每个 agent 一个工作区目录 + 系统提示要求读写 `MEMORY.md`。契合现有 `--print + --resume` 架构，无需改运行时，体验提升最大（"像长期同事"）。
- **P1 线程回复**：agent `send` 接上 `thread_id`，成本低、协作价值高。
- **P2 提醒系统**：轻量调度器（`reminders` 表 + 到点经 WS 唤醒 daemon → 注入 agent），解锁主动跟进。
- **P2 附件**：服务端补 agent `upload`（multipart），复用现有附件存储。
- **P3**：Action Card / 第三方集成 / DM / 频道 join-leave / 自主生命周期（偏外围或需较多基建）。
