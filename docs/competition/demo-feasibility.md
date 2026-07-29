# 演示路径核实报告（任务 1）

> 2026-07-29 对 server / daemon / web 三侧源码的核实结果，对应 `presentation-plan.md` 任务 1。
> 结论按视频分镜六幕组织，附关键文件证据。

## 一、逐幕可行性

### 幕1：人+AI 频道共存、发需求 —— ✅ 可实现

- 成员模型：`channel_members.member_type`（human/agent），主键 (channel_id, member_id, member_type)（`server/src/db/schema.ts:68-76`）
- 邀请 agent：`POST /channels/:channelId/invite`（`server/src/routes/channels.ts:122-166`）；agent 自主 join/leave（`agents.ts:50,65`）
- 成员面板人/AI 分组 + 紫色/灰色头像区分 + 👔经理徽章（`web/src/components/channel/ChannelMembersPanel.tsx:74-116`）
- 小瑕疵：消息列表头像不区分 AI/人类（`MessageRow.tsx:98-101` 未消费 senderType）

### 幕2：AI 感知回复 + 一键转任务 —— ✅ 已补齐（2026-07-29，P0-2）

- AI 感知可演：daemon 消息路由完整（mention 路由 / DM 路由 / forceDeliverTo 定向 / 防自环，`daemon/src/daemon-core.ts:266-330`）
- 任务状态机齐全：todo/in_progress/in_review/done/closed 五态（`server/src/routes/tasks.ts:5`），claim/unclaim/update-status 接口齐全
- ~~缺口①~~ **已修**：`POST /api/tasks/from-message` 把既有消息提升为任务（复用原消息行补 task_number，非新建副本；原子取号防并发重号；重复转换 409 / 已删除消息 400 / 无权限 403）
- ~~缺口②~~ **已修**：消息行新增"📋 转任务"按钮（hover 显示，仅频道上下文；转换后原位变为"任务 #N"徽章），看板同步可见

### 幕3：经理派发 + 看板流转 —— ✅ 已同步（2026-07-29，P1）

- dispatch 四接口齐全：dispatch/report/cancel/list（`server/src/routes/agents-dispatch.ts:61-169`），状态机 open/reported/cancelled，每频道唯一经理（`migrations/007_dispatches.sql:23`）
- 四列看板 + HTML5 拖拽 + update-status 调用齐全（`web/src/pages/TaskBoard.tsx:20-160`）
- ~~缺口~~ **已修**：dispatch 创建时 📋 通知消息同步成为看板卡片（in_progress + assignee=worker），report→in_review，cancel→closed；台账新增 `task_message_id` 关联（迁移 009）。演示"派发→看板自动流转"已连贯

### 幕4：任务线程汇报 + 流式 + 工具调用 + 审查流转 —— ⚠️ 部分实现

- 通用线程可用：`messages.thread_id` + ThreadView 页面 + WS 实时追加（`web/src/pages/ThreadView.tsx:50-67`）
- 状态流转 ✅（update-status done/closed 时通知创建者，`tasks.ts:115-142`）
- **缺口①**：任务与汇报无结构化关联（agent 发消息不写 task_number；dispatch report 只在文本里嵌 "dispatch <id>"）
- **缺口②**：前端无流式渲染、无工具调用块（agent:deliver 整消息下发，`AppLayout.tsx:135-159`）
- **替代方案（推荐）**：用终端观察面板展示 AI 工具执行过程——这是全项目实现度最高的亮点（见幕6）
- 小瑕疵：📋/✅/🚫 前缀样式在频道流有（`MessageRow.tsx:44-115`），ThreadView 内没有

### 幕5：记忆恢复 —— ⚠️ 可演示但口径要收窄

- 已有：restart 摘要注入（`daemon/src/restart-summary.ts`）、工作区 MEMORY.md 模板（`agent-startup.ts:73-114`）、bootstrap 合并注入（`agent-runtime-spawn.ts:429-457`）、历史拉取 API（`agents-messages.ts:71-80` history / `:56-69` receive 水位线 / `:132-147` search）
- **缺口**：无 memory 持久化表；启动不注入频道历史（agent 需自己调 read_history 工具）；session resume 默认关（需 `SLOCK_SESSION_RESUME=1`）
- 演示口径：说"重启恢复 = restart 摘要 + 持久记忆文件 + 历史可检索"，不要说"完整对话回放"

### 幕6：多运行时 / 终端观察 / 门控投递 —— 分裂

**终端观察 —— ✅ 全项目实现度最高，放心演示**
- node-pty spawn + @xterm/headless 终端模拟器（`terminal-state.ts:36-76`）
- 400ms 帧推送 + 历史补发（`daemon-core.ts:353-386`）；退出落盘 `.slock/terminal-logs/` 可回看（`terminal-log.ts:27-42`）
- resize 协商全链路：前端拖拽 → `terminal:resize` → PTY 真改（`AgentTerminalPanel.tsx:95-106` → `daemon-core.ts:404-418` → `agent-manager-support.ts:62-67`）

**多运行时 —— ❌ 实际仅 1 种可用（最大口径风险）**
- drivers/ 只有 3 个文件，全部针对 Claude（`claude.ts`、`persistent-claude.ts`、`probe.ts`）
- 4 种 CLI 预设存在（claude/codex/gemini/opencode，`command-presets.ts:12-37`）但 spawn 路径硬编码 `claude`（`agent-runtime.ts:33` TODO 注释仍在）
- 报名表"8 种运行时"无代码依据。演示前决策：接线 ≥1 种备选 或 收窄口径

**门控投递 —— ✅ 已修复（2026-07-29，P0-1）**
- 已有门控：提示符就绪轮询 + paste-ack 确认（`post-start-input-writer.ts:91-193`）、busy/pending 追踪（`agent-runtime-turn-tracker.ts`）、20s 静默兜底（`agent-runtime.ts:262-308`）
- ~~缺口①~~ **已修**：PTY 主路径改为 promise 链串行队列——忙碌时消息排队、按序投递、前一条失败不阻塞后续（`agent-runtime-dispatch.ts` `dispatchToAgent`）
- ~~缺口③~~ **已修**：缓冲反馈全链路——daemon 发 `agent:delivery-queued` WS 事件（`daemon-core.ts`）→ server 中继给浏览器（`ws/handler.ts`）→ 前端 toast "⏳ @xxx 正在工作，消息已缓冲，将在其空闲后自动投递"（`AppLayout.tsx`）
- 遗留：opt-in 持久驱动路径（`SLOCK_PERSISTENT_CLAUDE=1`）与主路径队列并存，演示用默认主路径即可

## 二、修复优先级（为演示服务）

| 优先级 | 事项 | 涉及文件 | 状态 |
|--------|------|----------|------|
| P0 | 门控主路径消息排队 + "已缓冲"UI 提示 | `agent-runtime-dispatch.ts`、`daemon-core.ts`、`ws/handler.ts`、`AppLayout.tsx` | ✅ 已完成（2026-07-29）：promise 链队列 + `agent:delivery-queued` toast，server 111/111 测试通过 |
| P0 | 消息行"转为任务"按钮 + server 转换 API | `MessageRow.tsx`、`messageStore.ts`、`tasks.ts` | ✅ 已完成（2026-07-29）：`POST /tasks/from-message` + 消息行按钮/徽章，server 112/112 测试通过 |
| P1 | dispatch 创建时同步建任务卡片 | `agents-dispatch.ts`、迁移 009 | ✅ 已完成（2026-07-29）：创建→in_progress/回报→in_review/撤回→closed，server 113/113 测试通过 |
| P1 | 多 runtime 决策：~~接线 codex/gemini 或收窄口径~~ | `agent-runtime.ts:33`、`command-presets.ts` | ✅ 已决策（2026-07-29）：只实现 Claude Code，其他暂缓；演示口径收窄为"可插拔 runtime 架构，当前落地 Claude Code" |
| P2 | 线程页前缀样式、消息列表 AI 头像 | `ThreadView.tsx`、`MessageRow.tsx` | 未开始 |

## 三、可放心演示的清单（现状即可）

1. 频道人机共存 + 邀请 agent + 设为经理
2. 四列看板拖拽流转 + 状态下拉/认领
3. **终端观察**（实时画面 + 历史日志 + resize）——建议作为演示高光
4. Agent 状态栏（工作中/空闲 + 终端最后一行实时输出）
5. 经理 dispatch/report/cancel 全回路（自账号 worker 已验证；跨用户路径未实测）
6. 消息路由（mention/DM/定向投递/防自环）

## 四、变更记录

### 2026-07-29 P0-1 门控投递队列（完成）

- `daemon/src/agent-runtime-dispatch.ts`：in-flight 丢弃 → promise 链串行队列（排队、按序、前条失败不阻塞）；新增 `onDeliveryQueued` 回调
- `daemon/src/agent-runtime.ts` / `daemon-core.ts`：选项透传 + 排队时发 `agent:delivery-queued` WS 事件
- `server/src/ws/handler.ts`：中继该事件给 daemon 属主的浏览器
- `web/src/components/layout/AppLayout.tsx`：toast 提示"消息已缓冲，将在其空闲后自动投递"
- 测试基建修复（阻塞本地验证的两个坑）：
  - **`BASE_URL` 是 Vitest 保留变量**，worker 会覆盖成 vite `base`（"/"）导致测试静默打默认端口——`test/helpers.ts` 改用 `SLOCK_TEST_BASE_URL` 优先
  - `test/security-fixes.test.ts` 6 处硬编码 `localhost:3001` → 由 `BASE` 派生
- 验证：daemon/server/web typecheck 全干净；server 测试 111/111（本地 3011 测试服 + `collabagent_test` 库）
- 本地测试姿势：`SLOCK_TEST_BASE_URL=http://localhost:3011 DATABASE_URL=...collabagent_test NODE_ENV=test vitest run`（3011 上需先跑 NODE_ENV=test 的 server）

### 2026-07-29 P0-2 消息一键转任务（完成）

- `server/src/routes/tasks.ts`：新增 `POST /api/tasks/from-message`——既有消息行补 `task_number`/`task_status='todo'` 提升为任务（**复用原消息行**，看板任务与频道消息同源）；单条原子 `UPDATE ... SET task_number=(SELECT COALESCE(MAX)+1)` 防并发重号；409 重复转换 / 400 已删除消息 / 403 无权限 / 404 消息不存在
- `web/src/stores/messageStore.ts`：新增 `applyMessageTask` action（转换成功后本地把消息标为任务，免刷新）
- `web/src/components/chat/MessageRow.tsx`：操作行新增"📋 转任务"按钮（hover 显示；仅频道上下文——DM 的 convKey 是 `@handle` 格式不显示）；转换成功后原位变"📋 任务 #N"徽章
- 测试：`test/tasks.test.ts` 新增 from-message 用例（转换→看板可见且复用原消息行→重复 409→不存在 404）
- 验证：server/web typecheck 干净；server 测试 **112/112**

### 2026-07-29 P1 dispatch↔看板同步（完成）

- 迁移 `src/db/migrations/009_dispatch_task_link.sql`：`dispatches` 加 `task_message_id UUID`（不加 FK，消息删除时 task 字段清空、悬空无害）；已应用到开发库
- `server/src/routes/agents-dispatch.ts`：
  - `insertAndDeliver` 返回消息 id
  - 派发：📋 通知消息原子取号补 `task_number`，`task_status='in_progress'`、`task_assignee=worker` → **看板即时出现卡片**
  - 回报：`task_status='in_review'`（等经理审查）；撤回：`task_status='closed'`
- 测试：`test/tasks.test.ts` 新增 dispatch-sync 用例（建经理+worker→派发→看板 in_progress/assignee 正确→回报 in_review→再派发撤回 closed→无重号）
- 验证：server typecheck 干净；server 测试 **113/113**
- 注意：开发服（:3001）需重启加载新路由代码（迁移已落库，旧代码加列无害）

### 2026-07-29 开发库测试残留清理

- 删除误跑测试打入开发库的 `zz_test_` 残留：176 个测试用户、43 个频道、14 个 agent 及关联数据（事务内按 FK 顺序）
- 根因即 Vitest `BASE_URL` 保留变量坑（已修）；开发库频道 59→16，仅剩真实使用频道

### 2026-07-29 Token 消耗优化（8 项，全部实施）

起因：看板实测 token 消耗异常大，日志分析定位 6 个燃烧点。改动全在 daemon：

| # | 优化 | 文件 | 说明 |
|---|------|------|------|
| 1 | **单实例守卫 + 整树杀** | `supervisor.ts`、`index.ts` | `shell:true` 下 `child.kill()` 只杀 cmd 包装层，旧 daemon 成孤儿与新实例并存：日志双份、agent 重复 spawn（双倍 token）、旧 PTY token 被吊销（MCP 401 根因）。改为 Windows `taskkill /T /F` 整树杀 + `.slock/daemon.pid` 启动时杀活旧实例 |
| 2 | idle 回收 300s→1800s | `agent-runtime.ts` | 317s 被回收 → 下条消息又付全量冷启动；`SLOCK_IDLE_RECLAIM_MS` 可调 |
| 3 | **session resume 默认开** | `agent-runtime-spawn.ts` | `SLOCK_SESSION_RESUME !== "0"`；失败兜底链（宽限期检测+清 id 重试）原本就有。冷启动上下文重建是消耗大头，resume 直接续上对话 |
| 4 | autostart 不再空转 | `daemon-core.ts`、`agent-runtime.ts` | 崩溃恢复不再给每个 agent 注入"安静等待"恢复消息（实测 55k 输出空转回合）；改为 lazy spawn + resume。删除 `autostartAgent` 及过时测试 |
| 5 | effort 降档 medium | `agent-runtime-spawn.ts` | workspace `settings.local.json` 写 `effort`（`SLOCK_AGENT_EFFORT` 可调）；⚠️ 键名未经官方文档证实，不被识别则无害，需真机验证 /effort 指示 |
| 6 | reminder cancel 400 修复 | `mcp/slock-mcp-server.ts`、`client.ts` | 无 body 的 DELETE/POST 不再带 JSON content-type（Fastify FST_ERR_CTP_EMPTY_JSON_BODY）；MCP 与 CLI 同修 |
| 7 | MCP report_task 401 | 由 #1 根治 | 孤儿 PTY 持旧 token、新 spawn 吊销所致；单实例后该时序不可能再出现 |
| 8 | 测试同步 | `test/session-resume.test.ts` | opt-in 断言翻转为默认开 + 显式 "0" 关闭；删 `autostart.test.ts` |

验证：daemon typecheck 干净（daemon 包无 vitest 依赖为既有状况，测试未本地跑）。
**真机待验**：①/effort 指示是否变 medium ②resume 默认开后首轮 spawn 是否带 --resume ③supervisor watch 重启后不再出现双份日志。
