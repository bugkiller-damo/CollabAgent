# Step 6 设计：D1 Context Builder + D2 thread 亲和（prompt 隔离）

> 日期：2026-08-21
> 方案依据：`docs/2026-08-20/01-daemon-evolution-plan.md` §D1/D2
> 执行跟踪：`docs/2026-08-20/02-daemon-evolution-tracker.md` Step 6
> 用户确认（本批）：
> 1. D2 **仅 prompt 隔离**——不按 (agent, thread) 拆 PersistentClaude 进程池；
> 2. D1 **仅线程追问**——deliver 带 `threadId` 才拉线程历史；顶层 @ / DM / 巡检不注入；
> 3. 超窗 **截断**（保近期原文、丢最旧），不另走 LLM 摘要；设计文档后立即实施。

---

## 0. 一句话

被 @ 的线程追问在入 A1 队列前，daemon 经 agent history API 拉该线程消息、按条数/字符预算截断后拼进本回合 prompt；常驻进程仍是每 agent 一个，用隔离声明防止串台；`threadId → sessionId` 落独立 JSON，供 one-shot `--resume` 与崩溃记账，不改 idle 回收粒度。

## 1. 现状断点（代码事实）

| 点 | 现状 |
|---|---|
| 入队内容 | `runAgent` 只把「被 @ + 本条 content」编成 `userMsg`，历史靠 agent 自助 `read_history` |
| history API | `GET /internal/agent/:id/history` **显式 `thread_id IS NULL`**，MCP `read_history` 无 `threadId` 参数——线程对 agent 不可见 |
| 进程 | `persistentSessions: Map<agentName, PersistentClaude>`，跨频道/线程共享一个 Claude 会话 |
| `agent-run-store` | headless 默认路径从不 `insertAgentRun`（PTY spawn 专属）；session 启发式在 `agent-sessions.ts` 且已随 PTY 冻结 |
| 成本 | D3 已按 (agent, channel, UTC day) 记 `result.total_cost_usd`；注入量尚未单列 |

T8 分诊：线程回复不触发分诊（`threadId IS NULL` 才分诊）。本批仍给 `runAgentTriage` 留可选 `threadId`，以免将来路由放宽时组装关系已经通。

## 2. D1 Context Builder

### 2.1 职责边界

**做：**

1. **相关性**：仅当本回合 deliver 带非空 `threadId`（或 `replyTarget` 含 `:shortid` 且传入了 threadId）；
2. **线程化**：`GET .../history?channel=&threadId=` → 父帖 + `thread_id = 父 id` 的回复，按 `seq` 升序；
3. **超窗压缩**：`maxMessages`（默认 40）+ `maxChars`（默认 8000）从**最旧**丢，保留近期原文；不召 LLM；
4. **组装**：把压缩后的块 **前置** 到既有 mention / 派单 / 分诊 prompt 之前，再 `dispatchToAgent`。

**不做：** 顶层频道近期消息、DM、巡检、隐式触发、server 路由改谁该醒、进程管理。

### 2.2 插入点

`agent-runtime-dispatch.ts` 的 `runAgent` / `runAgentTriage`：**prompt 模板编完之后、`dispatchToAgent`（A1 入队 / 成本熔断）之前。**

不放 `daemon-core`：core 只路由；不放 `doDispatch`：重试会重复打 history。失败（网络/403/空）→ warn + 无上下文入队，不阻断唤醒。

`SLOCK_CONTEXT_BUILDER=0` 关闭注入。

### 2.3 与 T8 triage prompt

分诊模板（三选一 + 沉默）保持纯函数 `buildTriagePrompt`。线程上下文是外层信封：

```
【会话隔离】…
【线程上下文】…
<原 buildTriagePrompt / mention prompt>
```

T8 产品上线程不触发分诊，信封在 mention/派单路径是主路径。

### 2.4 Server / MCP

- `GET /:agentId/history` 增加可选 `threadId`：有则返回该线程（短 id 按现有 `id::text LIKE prefix%` 解析父帖）；无则行为不变（顶层 `thread_id IS NULL`）。
- MCP `read_history` 增加可选 `threadId`，转同一 query。认证不变（`requireOwnAgent` + 频道 ACL）。

### 2.5 预算

| 旋钮 | 默认 | env |
|---|---|---|
| 条数 | 40 | `SLOCK_CONTEXT_MAX_MESSAGES` |
| 字符 | 8000 | `SLOCK_CONTEXT_MAX_CHARS` |
| 总开关 | 开 | `SLOCK_CONTEXT_BUILDER=0` 关 |

触发消息若已在 history 里（同 `messageId` 或同正文），打包时去掉，避免 prompt 双份。

## 3. D2 thread 亲和（本批收缩）

规划原文「persistent 按 (agent, thread) 缓存/回收」= 进程池，与「每 agent 一常驻进程规避 O(n²)」相反。**本批不做进程池。**

落地：

1. **Prompt 隔离声明**（线程注入时必带）：本回合只以【线程上下文】+本条为准，禁止把上一回合其它线程细节当成本线程事实。验收「thread A 追问不进 thread B **prompt**」由此保证；Claude 会话记忆仍可能泄漏，记为已知弱隔离。
2. **映射表**（独立 JSON，不挂 `AgentRunRecord`）：`.slock/daemon-thread-sessions.json`，键 `(agentName, threadId)` → `sessionId` + `updatedAt`。
   - 来源：headless `system`/`init` 的 `session_id`（`turnGuards.threadId`）；one-shot `claudePrint` 返回值。
   - 用途：`SLOCK_ONESHOT_CLAUDE=1` 时同 thread `--resume` 同 session；崩溃后可查。Persistent 默认路径 **不** 按 thread 换进程、**不** `--resume`。
   - CLI：`slock session show [--agent name]` 读该文件。
3. **回收**：`idle-reclaimer` 仍 per-agent。映射不因回收删除（session 文件还在用户 `~/.claude`）。

## 4. S6.3 成本

注入本身不另开 LLM。可见性：

- 回合 `result.total_cost_usd` 已含因上下文变长的费用（D3 已记）；
- 另在同一 `(agent, channel, day)` 行累加 `contextChars` / `contextMessages` / `contextDropped` / `contextTurns`，`slock cost show` 的 JSON row 带出。

## 5. 模块与验收

| 文件 | 职责 |
|---|---|
| `packages/daemon/src/agent-context-builder.ts` | fetch + pack 纯函数 |
| `packages/daemon/src/agent-thread-sessions.ts` | thread↔session JSON |
| `agent-runtime-dispatch.ts` | 插入点 + turnGuard.threadId + 队列 item.threadId |
| `agents-messages.ts` + MCP | `threadId` 查询 |
| `agent-cost-tracker.ts` | context 累加字段 |

**验收：**

- 长线程内 @ → prompt 含早前消息，无需 `read_history`；
- 无 `threadId` 的顶层 @ / DM / 巡检 prompt 不含【线程上下文】；
- thread A 与 thread B 的注入块互不包含对方消息；
- history 无 `threadId` 仍只返回顶层；
- `slock cost show` 能看到 `contextChars`（有注入后）；
- daemon typecheck + vitest 绿。

## 6. 明确不做（本批）

- (agent, thread) PersistentClaude 池 / 按 thread idle 回收；
- 顶层频道窗口、LLM 摘要、改 T8 触发规则；
- 把映射写进 `daemon-state.json` 的 runs。
