# Slock Daemon 改造方案——对齐 Buzz 分析结论的四项施工计划

> 日期：2026-08-18
> 输入：`docs/2026-08-18/02-buzz-vs-slock-daemon-analysis.md`（结论 §2「Slock 该拿」+ backlog B1/B2/B3）
> 衔接：`docs/2026-08-18/01-pty-keyboard-vs-structured-channels.md`（O13，headless 化路线与删除条件）
> 范围：`packages/daemon`，全量四项（派发队列 / env 白名单 / headless 遥测转正 / 工具调用审计），Steer 为远期锚点

## 0. 前提与定位约束

**不动产品形态**：slock 的「人类围观 agent 终端画面」是产品功能，headless 化必须
先用结构化观察帧**重建等价围观能力**，再切换默认路径——不是砍掉围观换 headless。
这是与 buzz 全面 headless 化的本质差异，也是 Phase B 的排序依据。

**四项的依赖关系**：

```
A1 派发队列 ──┐（独立，可先落地）
A2 env 白名单 ┘
B1 headless 观察遥测 → B2 默认路径切换 → C2 PTY workaround 清理（链式依赖）
C1 工具调用审计（依赖 stream-json 事件流，B1 之后顺手做；PTY 路径无法做）
```

## 1. Phase A：与 headless 无关的独立加固

### A1 EventQueue 式派发队列（backlog B1）

**问题**：现状是「即派即忘 + 忙碌时单缓冲」——`agent-runtime-dispatch.ts` 里
`dispatchPromises` 只做串行化门控，`agent:delivery-queued` 只上报一次 toast；
无重试、无过期、无死信。消息写 PTY 失败后即丢失（只有 console.error）。

**目标模块**：新建 `packages/daemon/src/agent-dispatch-queue.ts`

```
AgentDispatchQueue
├── enqueue(agentName, item: DispatchItem)     // item = { kind: message/reminder/dispatch, payload, enqueuedAt, attempts }
├── 状态：pending → in-flight(带截止) → delivered | retrying(指数退避+jitter) → dead-letter
├── dedup：同 agent 同 content hash 窗口期内去重（对齐 buzz queue.rs dedup 模式）
├── 忙碌合并：同 agent 多条 pending 消息可合并为一条复合 prompt（对齐 buzz 批量合并重提示）
└── 事件回调：onQueued / onRetry / onDeadLetter → daemon-core 经 WS 上报 server
```

**参数基线**（可调，env 覆盖）：
- in-flight 截止：60s（对齐现有 turn timeout）
- 退避：1s 起步 ×2 封顶 30s，±20% jitter
- MAX_RETRIES = 3，之后进死信并上报 server（消息不落丢）

**接入点**：
- `agent-runtime-dispatch.ts` 的 `doDispatch` 改为「入队 + 由队列驱动投递」，
  现有的 stopped 检查 / starting 转换 / `mintAgentCredential` 保留在投递执行器里。
- `onDeliveryQueued` 回调保留（浏览器 toast 兼容），由队列的 onQueued 触发。
- 死信处理：经 WS 上报 server，server 侧把消息标记为 delivery_failed（不自动重投）。

**验收**：
- 单测覆盖：忙碌排队→空闲按序投递、写入失败重试、3 次后死信上报、dedup 命中、
  agent stopped 时入队即死信。
- 现有 `dispatchPromises` 门控单测全部转绿（语义等价或明确变更）。

### A2 子进程 env 默认清空 + 显式白名单（backlog B2）

**问题**：`persistent-claude.ts` / `claude-print.ts` 用 `{ ...process.env, ...opts.env }`
全量继承 daemon 环境——daemon 进程里有 server apiKey 等高敏感变量，全量流向
agent 子进程及其再派生的 MCP 子进程。buzz 侧纪律是 `env_clear()` +
`WINDOWS_SHELL_RESOLUTION_ENV` 白名单（见 02 文档 §1.4）。

**目标模块**：新建 `packages/daemon/src/agent-env-whitelist.ts`

```
buildAgentEnv(overrides: Record<string,string>): Record<string,string>
├── 基础白名单（Windows 必需）：SystemRoot, SystemDrive, COMSPEC, PATHEXT,
│   PATH, APPDATA, LOCALAPPDATA, USERPROFILE, USERNAME, HOMEDRIVE, HOMEPATH,
│   TEMP, TMP, NUMBER_OF_PROCESSORS, OS
├── 网络白名单（按需）：HTTP_PROXY/HTTPS_PROXY/NO_PROXY（daemon 自己用了才转发）
├── Node/npm 链：PERSISTENT 路径 spawn claude.cmd 需要（npm prefix 目录已在 PATH 内）
└── overrides 最后合并（SLOCK_* 由调用方显式给）
```

**接入点**：
- `persistent-claude.ts` spawn env：`buildAgentEnv(opts.env)` 替代全量继承。
- `claude-print.ts` 同样替换。
- PTY 路径（`agent-manager.ts` / `buildPtyEnv`）：同样收窄——现有逻辑已是
  「继承 + 剥离 token」，改为「白名单 + 显式追加」，语义反转。
- **兼容兜底**：`SLOCK_ENV_INHERIT=1` 一键回到全量继承（排障用，默认关）。

**风险**：白名单漏项导致 agent 内工具链（git、node、公司代理）断裂——
Phase A 落地时先以 `warn-only` 模式跑一轮（构建白名单 env 但对比全量 env
打 diff 日志），确认无缺失再收紧。

**验收**：env diff 日志无意外缺失项后默认收紧；`SLOCK_AGENT_TOKEN` 明文
不出现在任何子进程 env（O11 语义保持）；单测覆盖白名单构造。

> **✅ 2026-08-25 翻正**（评估报告 P0.4）：默认已改为 `whitelist`；
> `SLOCK_ENV_INHERIT=1` 仍为排障回退；`SLOCK_ENV_WHITELIST=1` 保留为兼容 no-op。

## 2. Phase B：headless 观察遥测补齐 → 默认路径切换

### B1 PersistentClaude 结构化观察帧（headless 化的前置）

**问题**：`SLOCK_PERSISTENT_CLAUDE=1` 路径输入通道已结构化（stream-json
stdin，无键盘模拟），但终端观察面板只消费 PTY 帧（`pty-output-bus.ts` →
`terminal:frame` WS 推送），headless 下围观能力为零。buzz 的答案是
observer 结构化帧（02 文档 §1.5）。

**设计**：新建 `packages/daemon/src/agent-observation-bus.ts`

```
ObservationFrame = {
  runId, seq, timestamp,
  kind: "text" | "thinking" | "tool_use" | "tool_result" | "turn_start" | "turn_end" | "error",
  turnId, payload
}
```

- `persistent-claude.ts` 解析 stdout stream-json 事件（assistant/tool_use/result），
  逐事件 emit ObservationFrame（顺带把 B3 审计需要的 tool_use 生命周期事件源做出来）。
- 总线复用 `pty-output-bus.ts` 的 per-runId 发布/订阅 + 引用计数模式
  （无人观看零开销的纪律保留）。
- 渲染侧：web 终端面板新增「结构化流视图」——tool_use 折叠卡片 + text 流，
  对齐 buzz observer 帧的信息密度；**不追求复刻 TUI 像素画面**。
- replay buffer：每 run 保留最近 N 帧（对齐现有 PTY 历史落盘）。

**验收**：`SLOCK_PERSISTENT_CLAUDE=1` 下浏览器可实时围观 agent 工作全程
（文字输出 + 工具调用可视），刷新后 replay 恢复最近画面。

### B2 默认路径切换 + PTY 降级

**切换条件**（全部满足才动默认值）：
1. B1 观察帧上线且至少一轮真实使用回归无 P0/P1；
2. A1 队列落地（headless 下消息投递可靠性不低于 PTY 现状）；
3. 观察面板结构化视图在目标浏览器验证通过。

**改动**：
- `agent-runtime.ts` 默认 `usePty = false`（env `SLOCK_USE_PTY=1` 显式回退），
  PersistentClaude 从「兜底路径」转正为默认，`claudePrint` one-shot 仅作
  PersistentClaude 启动失败的再兜底。
- 会话保持：stream-json 持久会话天然保住上下文（替代 PTY 的 `--resume` 链）；
  `agent-runtime-spawn.ts` 的 resume/grace 逻辑在 headless 路径不启用。

### C2（随 B2 之后）PTY workaround 清理

按 01 文档 §2.2 的删除条件逐个确认后下线（grep `何时可删（O13）`，共 5 处）：
`post-start-input-writer.ts`、`agent-runtime-terms-dialog.ts`、
`agent-runtime-turn-tracker.ts` 的 ❯ 启发式、`agent-sessions.ts` 的 mtime 捕获。
PTY 模式代码保留作 fallback，但 workaround 注释更新为「仅 fallback 路径存活」。

## 3. Phase C：审计增强

### C1 agent 工具调用生命周期事件流（backlog B3）

**现状**：平台操作（MCP 17 工具）走 server 审计事件（O2）；agent 本地工具调用
（claude 内建 Read/Edit/Bash…）无审计流。buzz 侧是逐调用 emit
pending/in_progress/completed/failed（02 文档 §1.4）。

**设计**：
- 事件源：B1 的 stream-json 解析已经拿到 tool_use/tool_result 事件，零额外成本。
- 新建 `agent-tool-audit.ts`：ObservationFrame 的 tool_use 帧 → 转换为审计事件，
  经 WS 上报 server（新增事件类型 `agent:tool-call`，字段：agentId/runId/turnId/
  toolName/status/起止时间/参数摘要——**参数与结果截断**，对齐 buzz-dev-mcp
  的截断纪律，完整内容留在本地 run 历史落盘）。
- server 侧入库与展示为配套项（本方案只锁定 daemon 侧 emit 协议）。

**注意**：PTY 路径下无结构化事件源，C1 只在 headless 路径生效——
这是 B2 切换前审计覆盖不全的已知窗口，文档明示即可。

## 4. 远期锚点：Steer 语义（本轮不施工）

进行中回合的消息注入（buzz `ControlSignal::Steer`）。依赖：结构化输入通道
（B2 之后具备）+ claude stream-json 是否支持回合中注入待验证（可能受 CLI
能力限制，buzz 是进程内直驱 LLM 才能做到真 steer）。若 claude CLI 不支持，
降级方案为 A1 队列的「合并重提示」——新消息不打断当前回合，回合结束后与
队列合并为一条复合 prompt。**仅作方向记录，验证后另立文档。**

## 5. 施工顺序与验证纪律

| 顺序 | 任务 | 依赖 | 验证 |
|------|------|------|------|
| 1 | A1 派发队列 | 无 | 新增单测 + 既有 dispatch 测试转绿 |
| 2 | A2 env 白名单（warn-only → 收紧） | 无 | env diff 日志一轮真实运行无缺失 |
| 3 | B1 观察帧 | 无（但与 A1 并行会改同文件，建议串行） | headless 下浏览器围观全程 |
| 4 | C1 工具调用审计 emit | B1 | WS 事件流单测 + server 侧联调 |
| 5 | B2 默认路径切换 | B1 + A1 + 切换条件三条 | 全量 97 vitest + 一轮真实频道回归 |
| 6 | C2 workaround 清理 | B2 稳定后 | grep 确认 + tsc + 测试转绿 |

每个任务完成后：
1. `npx tsc --noEmit -p packages/daemon/tsconfig.json`
2. `pnpm --filter @slock/daemon test`（vitest 全量）
3. 更新 `.claude/goal-progress.json`

**回退预案**：每个 Phase 都有 env 开关可独立回退（A1 队列可旁路、
A2 `SLOCK_ENV_INHERIT=1`、B2 `SLOCK_USE_PTY=1`），回退不依赖代码回滚。

---

## 6. 落地状态与遗留事项（2026-08-18 施工完成后补记）

**全部任务已落地并验证**（commit `1b3764d` daemon / `034def1` server/web /
`27dfd49` B1 web 面板 / `83b526c` 回复守卫 v2），含七轮真机回归与审计流
端到端验证（10/10 断言）。计划外新增：**回复守卫**（回合结束无 send_message
→ daemon 以 agent 身份代发最终正文，弱模型漏回复的确定性兜底）。

**遗留事项**（均不阻塞使用，按优先级）：

| 事项 | 说明 | 触发条件 |
|------|------|---------|
| A2 白名单默认值翻正 | 当前默认 warn-only（全量继承 + diff 日志）；翻正 = 默认 whitelist 收紧，`SLOCK_ENV_INHERIT=1` 降级为回退开关 | 用户决定暂缓——`SLOCK_ENV_WHITELIST=1` 多跑一段时间无工具链断裂后再翻 |
| Steer 语义 | 进行中回合消息注入；回复守卫已验证「回合边界自动注入」，真 steer 待 claude stream-json 能力验证 | 远期，另立文档 |
| PTY 模式整体退役 | 4 处 workaround 的最终删除条件 | headless 长期稳定后再议 |
| agent 引导层加固 | 系统提示加「网络命令必须带 --max-time」（curl 挂死是真机反复出现的回合挂死源） | 随手可做 |

**已知边界**（真机实测记录，遇到再处理）：
- 单段超长生成超 300s 无事件会被不活跃超时误杀——调 `SLOCK_PERSISTENT_TURN_MS`（grok 中继慢生成场景暂定 600000）
- WebFetch 在「claude.ai 不可达」的网络环境（如 grok 中转）不可用，白名单只放 WebSearch
