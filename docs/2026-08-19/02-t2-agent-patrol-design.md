# T2 设计：Agent 自主巡检 / 定时主动发起（Patrol Jobs）

> 日期：2026-08-19
> 输入：`docs/2026-08-19/01-buzz-borrowing-todo.md`（T2，🔴 高，预估中）
> 衔接：A1 派发队列（已落地 `agent-dispatch-queue.ts`）、reminder scheduler
> （`reminder-scheduler.ts`，`FOR UPDATE SKIP LOCKED` 原子认领）、idle-reclaimer
> （60s 沉默自回收）、B1 观察帧（`27dfd49`）
> 范围：`packages/server` + `packages/daemon` + `packages/web`（最小面板）

## 0. 一句话定位

不新建调度系统——把现有 reminder 从「闹钟语义」升级为「任务语义」：
**一条带指令的周期任务（patrol job），到点唤醒 agent 执行，允许沉默产出，
有护栏防失控，全程可审计。**

## 1. 现状盘点：已落地的积木

| 积木 | 状态 | 位置 |
|------|------|------|
| 周期调度 | ✅ `repeat_rule`：`every:N{s\|m\|h\|d}` / `hourly` / `daily` / `daily@HH:MM`，fire 后自动重排 | `server/src/lib/reminders.ts` |
| 多实例安全认领 | ✅ `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`，20s tick | `server/src/lib/reminder-scheduler.ts` |
| 唤醒链路 | ✅ WS `reminder.fire` → daemon-core → `runAgentReminder` → A1 队列 → 冷启动恢复 session | `daemon-core.ts:423`、`agent-runtime-dispatch.ts:524` |
| 派发队列 | ✅ dedup / 合并 / 重试 / 死信（A1） | `daemon/src/agent-dispatch-queue.ts` |
| 沉默自回收 | ✅ 60s 无活动优雅关闭 + sessionId 持久化，下条消息冷启动恢复 | `daemon/src/idle-reclaimer.ts` |
| agent 自建设入口 | ✅ `slock reminder schedule` CLI + `POST /internal/agent/:id/reminders` | `daemon/src/cli.ts:581`、`routes/agents-reminders.ts` |
| 巡检数据源 | ✅ agent 已有 `message read/search/check`、`task list`、`dispatch list` 全套读工具 | `daemon/src/cli.ts` |
| 归属鉴权 | ✅ `requireOwnAgent`（owner 或 agent 本人凭证均可过） | `server/src/lib/agent-helpers.ts` |

## 2. 差距分析：4 个缺口

1. **任务语义**：fire 时 prompt 只有「你之前设置的提醒触发了：「title」」——没有
   结构化指令、没有产出约定、没有沉默协议（不补这条，cron 每次触发都刷屏频道）。
2. **护栏**：无频率下限、无 job 数上限、无空转自动暂停、无「fire 又自我续期」
   的循环放大防护。
3. **管理面**：Web 端零 UI；只有 cancel 没有 pause/resume；`reminder_events` 只记
   fired，不记结果（发了言还是沉默）。
4. **类型区分**：人的闹钟和 agent 的巡检混在一个语义里，UI/审计应分流。

## 3. 关键决策

### D1 复用 reminders 表，加 `kind` 分流（不建新表）
调度、认领、重排、事件日志全部复用；`kind='patrol'` 的行走新 prompt 与护栏。
人的 reminder（`kind='reminder'`，默认）行为**一字不动**——零回归面。

### D2 沉默判定走 server 侧代理，不加协议（v1）
「本轮是否沉默」= 上次 fire 到本次认领之间，该 agent 是否在目标频道发过消息。
在 **claim 时**判定并回写 `consecutive_silent`，不新增 daemon→server 协议。
已知误差：窗口期内 agent 因别的触发（被 @）发言会误清零——v1 接受，
v1.5 可加 daemon `turn.result` 显式上报再精确化。

### D3 paused 用独立布尔列，不动 status CHECK 约束
`status CHECK IN ('scheduled','fired','canceled')` 是建表约束，改它要动约束迁移；
加 `paused BOOLEAN` 是纯增量，scheduler 认领条件加 `AND NOT paused` 即可。

### D4 巡检循环放大防护写进 prompt + 参数双保险
prompt 明示「不要为延续本任务给自己设新提醒」；参数侧 patrol job 的
`repeat` 只允许 server 校验过的白名单语法（复用 `nextFireFromRepeat`，
不接受任意 cron 字符串），频率下限 5 分钟。

## 4. 详细设计

### T2.1 [server] migration `012_patrol_jobs.sql`

```sql
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'reminder';
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS instructions TEXT;          -- 巡检任务指令
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS paused BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS consecutive_silent INT NOT NULL DEFAULT 0;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS max_consecutive_silent INT NOT NULL DEFAULT 5;
CREATE INDEX IF NOT EXISTS idx_reminders_patrol_due
  ON reminders (status, fire_at) WHERE status = 'scheduled' AND kind = 'patrol' AND NOT paused;
```

### T2.2 [server] scheduler 护栏（`reminder-scheduler.ts`）

- 认领条件加 `AND NOT paused`；
- claim 到 patrol 行时：查该 agent 自 `last_fired_at` 以来在 `channel_ref`
  是否发过消息 → 无则 `consecutive_silent+1`，有则清零；
- `consecutive_silent >= max_consecutive_silent` → 置 `paused=true`，
  写 `reminder_events` 事件 `auto_paused`，发 WS 通知 owner（复用现有通知面）；
- 创建校验：patrol 的 `repeat` 必须可解析且周期 ≥ 5min；每 agent 活跃 patrol ≤ 10 条；
- 结果回写：`reminder_events` detail 增加 `{ outcome: 'posted' | 'silent' }`。

### T2.3 [daemon] patrol prompt（`agent-runtime-dispatch.ts`）

`reminder.fire` 负载加 `kind`/`instructions`；`runAgentReminder` 按 kind 分流：

```
【定时巡检】<title>
任务指令：<instructions>
产出约定：
- 有值得报告的发现 → 用 send_message 发到 <channel>（target 严格用该值）
- 没有值得报告的发现 → 直接结束回合，不发任何消息（沉默是正常产出）
- 不要为延续本任务给自己创建新提醒；调度由系统负责
```

`kind='reminder'` 保持现有模板不变。`REMINDER_TAIL` 统一追加逻辑不动。

### T2.4 [server+daemon] API / CLI

复用 `/internal/agent/:agentId/reminders` 族路由（`requireOwnAgent` 天然支持
owner Web 会话与 agent 凭证两种身份），请求体加 `kind/instructions/maxConsecutiveSilent`；
新增 `POST /:id/pause` / `POST /:id/resume`（resume 清零 `consecutive_silent`）。

CLI 新命令组（`daemon/src/cli.ts`）：
```
slock patrol create --title <t> --every 2h --channel #security --instructions "..." 
slock patrol list | pause <id> | resume <id> | log <id> | cancel <id>
```
底层走同一组 HTTP 路由（`kind=patrol`），`slock reminder *` 保持人用小闹钟语义。

### T2.5 [web] 最小管理面板

Agent 设置页加「定时巡检」卡片：job 列表（标题/周期/频道/状态/已连续沉默次数）、
pause/resume/cancel 按钮、最近 fire 记录（outcome 着色）。不做编辑器级 UI。

### T2.6 测试 + 文档

见 §5。文档回写 `01-buzz-borrowing-todo.md` 勾选 T2，并在功能概览把
「更主动的自己巡检/发起」从「规划中」改为「已落地」。

## 5. 验证方案（四层）

**L1 单测**
- repeat 解析：合法白名单通过、`every:30s`（<5min）拒绝、非法语法 400；
- 护栏：连续沉默达阈值 → auto_paused + 事件落库；resume 清零；
- daemon：patrol prompt 含沉默协议与严格 target；reminder kind 模板不回归。

**L2 集成**（server test 框架）
- 到期 patrol → claim → WS `reminder.fire`（带 instructions）→ 重排 + fire_count+1；
- paused 行不被 claim；`kind='reminder'` 行行为不变；
- 频率下限 / job 上限校验。

**L3 手动 E2E**（真链路 ~30min 剧本）
```bash
slock patrol create --agent @secbot --every 5m --channel #alerts \
  --instructions "读 #alerts 最近消息，有新告警汇总发 #security，无则沉默"
# ① 5min 内 agent 自动醒来（daemon 日志有 dispatch）
# ② 无告警时频道零新消息（沉默协议生效）
# ③ 往 #alerts 发假告警 → 下轮 #security 出现汇总
# ④ 60s 无活动后进程回收；下轮冷启动 session 连续（上下文不断）
# ⑤ 连续 5 轮沉默 → job 自动 paused，owner 收到通知，events 有 auto_paused
```

**L4 指标/审计**
- 复用 `remindersFired`，新增 `patrolPosted` / `patrolSilent` / `patrolAutoPaused` counters；
- `GET .../reminders/:id/log` 可见完整 fire/outcome 历史（路由已有，扩 detail 即可）。

## 6. 参数基线（env 可调）

| 参数 | 默认 | 说明 |
|------|------|------|
| scheduler tick | 20s | 沿用现状 |
| patrol 最小周期 | 5min | 创建时校验 |
| 每 agent 活跃 patrol 上限 | 10 | 防失控 |
| 空转自动暂停阈值 | 5 次 | `max_consecutive_silent`，可按 job 覆盖 |
| claim 批量 | 20 行/tick | 沿用现状 |

## 7. 完成后效果（对齐 todo 验收）

1. 「agent 能按 cron 自主发消息/推进任务」——例：每 2h 巡检 #alerts，有异常汇总
   发 #security，无则沉默；
2. 「无人对话自动休眠」——已存在，且与 patrol 闭环：唤醒→执行→回合结束→60s 回收
   →下轮冷启动带 session 恢复，**零常驻成本**；
3. 频道不刷屏（沉默协议 + 空转自动暂停）；每次巡检可审计（fire→outcome→消息）；
4. 为 T1 工作流引擎提供 trigger 面雏形，为 T3 活动馈送提供结构化产出数据源。

## 8. 风险与边界

- **沉默判定误差**（D2）：v1 接受，文档注明；v1.5 显式上报再精确化。
- **prompt 纪律依赖模型自律**：沉默协议是软约束；护栏（自动暂停）是硬兜底。
- **与 T1 的边界**：patrol 是「单 agent 单动作」；多步骤/审批门属于 T1，
  不在本期引入 evalexpr 条件面，避免过度设计（对齐 todo 附录原则）。
- **不做**：标准 cron 语法/时区（`every:`/`daily@HH:MM` 已覆盖近期需求）、
  跨 agent 编排（T1 范畴）。

## 9. E2E 验收实录（2026-08-19，真实 server+daemon+agent）

剧本：SQL 播种 patrol（代码专家，every:5m，读 #random 找「E2E告警」汇总发 #general）。

| 轮次 | 结果 |
|------|------|
| 12:15 fire | 冷启动 spawn，17s 量级上线；fired 事件落库 |
| 12:20/12:25/12:30 | 无告警零发言，outcome=silent 逐轮计数 1→3 |
| 12:35 fire | **17 秒后** #general 出现告警汇总（E2E-3 ✅） |
| 12:40 认领 | 连续沉默 5/5 → **自动暂停**：next:null 不重排 + auto_paused 事件 + owner 通知（E2E-5 ✅） |
| 12:47 认领 | 修复后判定正确识别 posted，计数重置 ✅ |

**E2E 抓出并修复的两个真 bug**（均已回归）：
1. `reminder.fire` 名/id 错配（**既有**，非 T2 引入）：注册表以 name 为键，
   入信只有 agentId(UUID)，`hasAgent(UUID)` 必 false → agent 提醒静默丢弃。
   修复：daemon 新增 `resolveAgentName` 反查；scheduler WS 负载补 `agentName`。
2. 沉默判定误加 `agents.server_id` 约束：agent 的归属 server ≠ 活动 server
   （多 server 同名 #general），真实发言被判沉默 → 误自动暂停。修复：按频道名匹配。

**发现（未在本期修复，转 L5 边界调优）**：
- **沉默播报**：agent 连续两轮发「保持沉默」公告——续期会话有历史惯性，
  prompt 软约束衰减（新 prompt 已加「不要发确认消息」「不重复报告」，首轮仍播报）。
  后续可考虑：patrol 不复用会话 / server 侧吞掉沉默公告 / 更强的 turn 级约束。
- **idle-reclaim 默认实为 30min**（`SLOCK_IDLE_RECLAIM_MS`，agent-runtime 装配层），
  非 idle-reclaimer.ts 注释的 60s——本文 §7「60s 回收」描述以 30min 为准。
- A1 队列 inflight 截止（6min）会拉长 agent 驻留窗口，与 reclaim 叠加后
  「无人时休眠」的实际时延 ≈ max(inflight, reclaim 30min)。
- **回收覆盖面存疑（E2E-4）**：冷启动恢复两轮实证（fire 后 ~17s 上线、上下文跨轮
  连续 ✅）；但 persistent 路径的 agent 进程在无对话 40min+ 后仍未被回收
  （reclaimer 的 stopRun 走 runIdByAgent,persistent 会话可能不在覆盖面）。
  patrol 普及后 agent 常驻会更常见，建议排查 persistent 路径的回收接线。

**E2E-4 判定**：冷启动恢复 ✅ / 上下文连续 ✅ / 闲置自动回收 ⚠️ 未复现（见上）。
