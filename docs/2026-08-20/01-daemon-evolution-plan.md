# Daemon 演进方案：还债 + 定向扩建（承接现状核查）

> 日期：2026-08-20
> 基线：daemon 现状核查（49 源文件；headless 自 2026-08-18 起为默认；A1 派发队列、
> scoped token、五态状态机、idle 回收、观察帧均已落地）。
> 结论：**不需要推倒式大改**。大改已在 07-15 路线图（26 项）+ 08-18 headless pivot 中
> 完成；本文列出剩余的「还债批」与「定向扩建批」。
> 衔接：`2026-08-19/01-buzz-borrowing-todo.md`（T/L 系列）、
> `2026-08-19/03-t8-manager-triage-design.md`、`2026-08-16/02`（O 系列）。
> 执行跟踪：本文是方案面；**推进状态以 `2026-08-20/02-daemon-evolution-tracker.md`
> 为准**（任务勾选 + 完成记录）。

---

## 0. 与 01-buzz-borrowing-todo.md 的依赖关系（先回答「要不要等」）

**不需要等它完成。** 该文件是滚动产品 backlog（含冻结/待决策项），没有「完成」态。
逐项依赖判定：

| 本文事项 | 与 buzz-todo 的关系 | 可否现在启动 |
|---|---|---|
| P0 还债批（PTY 退役/死代码/文档/测试/类型对齐） | L3 已在其中；其余无交集 | ✅ 完全独立，立即可做 |
| D3 成本记账 + 熔断 | 无交集 | ✅ 独立 |
| D1 Context Builder / D2 thread↔session 亲和 | 与 **T8 共享 `agent-runtime-dispatch.ts`** | ⚠️ 建议 T8 落地后启动；可与 T8 并行设计 |
| D4 进度呈现进频道 | 是 **T4 的 daemon 侧一半** | 并入 T4，不另立项目 |
| D5 第二家厂商 adapter | 无交集（buzz-todo 未覆盖） | 等产品决定接第二家 |
| D6 Orchestrator | 承接 T8 经理分诊 | T8 之后 |

---

## 1. 现状核查摘要（为什么不是大改）

已兑现（无需再投）：

- **headless 默认**：`drivers/persistent-claude.ts` 常驻进程 + stream-json 双向结构化通道，
  `result` 事件 = 精确回合边界；沉默超时（300s）卡死保护；mid-turn 退出 reject 供重试。
- **每 agent 串行队列**：`agent-dispatch-queue.ts`（退避/死信/15s 去重/忙碌合并）+
  PersistentClaude 回合级 Promise。
- **显式 @触发**：server 端 mention 路由 + `forceDeliverTo` + DM。
- **token/权限**：scoped runtime token（`agent-runtime-credentials.ts`）、token 文件 0600、
  `--allowedTools` 白名单 fail-closed、env 白名单（A2）。
- **Agent 频道一等公民**：DB 模型完整（avatar/description/capabilities/`agent:identity`）。
- **Agent 间信息经过频道**：manager→worker 走 forceDeliverTo + 自环防护；产物走频道附件。

真实空白（扩建方向）：

1. **Context Builder**：agent 只收到被派发的单条消息，历史靠 `read_history` 自助——
   无相关性筛选 / 线程重组 / 压缩；
2. **thread↔session 亲和**：现状亲和粒度是 per-agent（一个常驻进程跨所有频道），
   非 per-thread；
3. **成本记账**：`total_cost_usd` 只在观察帧一闪而过，无持久化、无预算熔断；
4. **进度呈现进频道**：观察帧只到 web 旁观面板，未成为频道内节流更新的进度消息；
5. **多厂商 adapter 抽象**：codex/gemini preset 是死代码，`runtime_profile.runtime` 存而不用。

---

## 2. P0 · 还债批（现在可做，与 T 系列并行）

### P0.1 PTY 路径冻结隔离（= buzz-todo L3 的修正版，2026-08-20 用户决策）
- **决策**：退役 ≠ 删除。PTY 整体冻结为 legacy 兜底、代码保留——headless（08-18 起默认）
  尚未经过长期验证，保留 `SLOCK_USE_PTY=1` 回退能力。删除推迟到 **2026-09 底评估**
  （headless 稳定运行满 6 周）。
- **本 Step 动作**（详见 tracker Step 3）：9 个 PTY 文件加统一 ❄️ legacy 头注；
  混合文件分支点标注（`agent-runtime-spawn.ts` 的 `writeMcpConfig` 与
  `terminal-log.ts` 服务 headless，不在冻结范围）；`SLOCK_USE_PTY=1` 启动打 legacy
  警告日志；web 终端面板保留；依赖 `node-pty`/`@xterm/headless` 保留。
- **原删除方案保留备查**（评估到期后执行）：删 9 文件 + 收编 `agent-runtime.ts` /
  `agent-runtime-dispatch.ts` / `daemon-core.ts` 的 PTY 分支与 `SLOCK_USE_PTY` 门控 +
  卸依赖 + 删 `agent-sessions.ts` mtime 启发式。
- **验收**：全仓 build 绿 + daemon 测试绿；`SLOCK_USE_PTY=1` 路径可编译可用；
  每个 PTY 文件带 legacy 标记。

### P0.2 死代码与占位清理
- 删 `packages/adapter-layer/`（空壳，不在 workspace，仅有 dist/node_modules）。
- 删 `src/drivers/claude.ts`（ClaudeDriver 未在 runtime 接线，dispatch 层只认
  PersistentClaude/claudePrint——删除前最后 grep 确认）。
- `src/agent-stdin-writer.ts` 四种 writer 仅打日志不真实写入，标注 deprecated 或
  并入 dispatcher，消除「看似可用」的假象。
- **验收**：grep 无引用；包体积/依赖收敛。

### P0.3 shared WS 类型对齐
- `packages/shared/src/index.ts` 的 `WsServerMessageType`/`WsClientMessageType` 与真实
  线协议漂移（缺 `agent:tool-call`、`terminal:*`、`reminder.fire`、`delivery-queued/
  dead-letter`；`agent:deliver:ack`/`reminder.*` 命名不一致）。
- **做法**：以 `server/src/ws/handler.ts` + `daemon-core.ts` 实际收发为准，生成唯一
  的 `WsMessage` union（server↔daemon、server↔browser 两个方向分开）。
- **验收**：daemon/server 均改为 import shared 类型，编译通过。

### P0.4 文档债
- 重写 CLAUDE.md「当前状态」段（仍是 07-15 的 12 文件/447 行描述，严重失真）。
- 刷新 `docs/2026-07-15/01-current-state-inventory.md` 或标注「已被 08-20 核查取代」。
- **验收**：新贡献者按文档能找到正确入口文件。

### P0.5 daemon 测试补齐
- 现状：daemon 近零测试（仅 round-end-detection），队列/状态机/重试是手工测试高危区。
- **最小集**：A1 队列（退避/死信/去重/合并）、状态机非法迁移、PersistentClaude
  回合 Promise（result resolve / mid-turn exit reject / 沉默超时 kill）、
  token revokeIfMatches 竞态。mock child_process 即可，不需真 CLI。
- **验收**：vitest 覆盖上述四模块核心路径；CI 可跑。

---

## 3. P1 · 定向扩建批（引用文指出的投资方向）

### D1 Context Builder（频道消息流 → agent 上下文）【最高优先】
- **插入点**：daemon 侧 dispatch 前置（`agent-runtime-dispatch.ts` 收到 `agent:deliver`
  后、入 A1 队列前），不改 server 路由、不改进程管理。
- **职责**：相关性筛选（@/回复链/发言对象）→ 线程化重组（thread 消息聚合成任务上下文）
  → 超窗压缩（老消息摘要、近期原文保留，经 server 历史 API 拉取）。
- **与 T8 的关系**：T8 决定「谁该说话」，D1 决定「说话时带什么上下文」；D1 的 prompt
  组装必须容纳 T8 的 triage prompt（自己回/派单/沉默三选一）。
- **验收**：无 @ 的长线程讨论中，agent 被 @ 时能引用线程内早前消息作答，
  无需人工复述背景；token 消耗可观测（接 D3）。
- **预估**：中-大 | 依赖：建议 T8 先落地（共享 dispatch 层）。

### D2 thread↔session 亲和
- **现状**：亲和粒度 per-agent 常驻进程（天然规避 O(n²) 重灌），跨频道上下文混杂。
- **做法**：`agent-run-store` 增加 `threadId → sessionId` 映射；同 thread 追问时
  `--resume` 同 session（one-shot 路径已有 `--resume` 机制可复用）；persistent 路径
  按 (agent, thread) 维度缓存/回收进程。
- **验收**：thread A 的追问不进 thread B 的上下文；回收后重进 thread 仍能续接。
- **预估**：中 | 与 D1 同批设计。

### D3 成本记账 + 熔断【独立，可随时做】
- **插入点**：`agent-observation.ts` result 事件已解析 `total_cost_usd/duration_ms/
  num_turns`——只需从「入观察帧」扩展到「落库」。
- **做法**：runStore 或 SQLite 按 (agent, channel, day) 累计；`SLOCK_COST_BUDGET_USD`
  阈值 → 超限时 A1 队列拒投并回频道一条熔断消息。
- **验收**：能回答「某 agent 上周花了多少钱」；超限自动停投 + 频道可见。
- **预估**：小-中 | 无依赖。

### D4 进度呈现进频道（并入 T4，不另立）
- 把 tool_call/result 事件**节流聚合**成频道内一条原地更新的进度消息
  （「正在执行：运行测试…」→ 最终替换为结果摘要），而非每事件刷一条。
- 建议直接并入 buzz-todo T4（观察帧产品化）的 scope，daemon 侧提供聚合事件源。

---

## 4. P2 · 远期（触发条件驱动，不排期）

| # | 事项 | 启动条件 |
|---|---|---|
| D5 | 第二家厂商 adapter（统一事件 schema + raw fallback；codex/gemini preset 复活） | 产品决定接入第二家 |
| D6 | Orchestrator（复杂任务拆解 → 多 agent 认领 → 汇总） | T8 分诊跑稳之后 |
| D7 | 隐式触发（轻量分类器，默认关） | D1 上线且成本可控后 |

---

## 5. 落地顺序建议（2026-08-20 细化）

核心逻辑：**先修地图 → 织安全网 → 拆废墟 → 装仪表 → 盖新楼**。

```
Step 0（当天，零风险）   P0.4 文档修正 + P0.2 死代码清理
Step 1（2~3 天）        P0.5 测试最小集（幸存主干安全网）
Step 2（1~2 天）        P0.3 WS 类型对齐（tsc 驱动；给 T8 备好消息 union）
Step 3（1 天）           P0.1 PTY 冻结隔离（不删代码：legacy 头注 + 分支标注 + 启动警告）
Step 4（并行轨道）       D3 成本记账（独立；必须早于 D1）
Step 5                  T8 经理分诊（在干净/有类型/有测试的 dispatch 层上开发）
Step 6                  D1 + D2 同批（设计可在 Step 5 期间并行，实施等 T8 合并）
Step 7                  T4（D4 并入其 scope）→ T3/T1 按产品优先级
远期                    D5 / D6 / D7 触发条件驱动
```

排序约束（不可调换的三条）：

1. **P0.5 先于 P0.1/P0.3**——删除与重构都落在幸存主干上，没有测试网不动刀；
2. **D3 先于 D1**——Context Builder 会显著推高 token 消耗，仪表必须先装上；
3. **`agent-runtime-dispatch.ts` 串行新功能**——Step 3 后 PTY 分支冻结不动，
   T8（加 triage）→ D1（加 Context Builder 前置）依次落地，不同时开工，避免 rebase 地狱。

---

## 附 · 明确不做

- **不重写进程管理层**：headless + A1 队列已是目标形态，PTY 只删不扩。
- **不提前做 adapter 抽象**：单一厂商下抽象必错形，等第二家逼出真实形状（引用文原话）。
- **不做隐式触发默认值**：显式 @ 是成本与混乱度的阀门。
- **不把 Orchestrator 提前**：简单任务走单 agent headless 一把梭，编排 overhead 会
  杀死简单任务体验。
