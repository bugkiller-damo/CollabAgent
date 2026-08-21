# T8 设计：频道经理自动分诊（无 @ 消息 → 经理接活/派单）

> 日期：2026-08-19
> 输入：`docs/2026-08-19/01-buzz-borrowing-todo.md` 讨论增补（原 T1–T7 之外立项）；
> 衔接：`02-t2-agent-patrol-design.md`（沉默协议 prompt 模式共享）、
> A1 派发队列（忙碌合并）、007 dispatches（`is_manager` + 经理派单工具）
> 范围：`packages/server`（路由 + migration）+ `packages/daemon`（deliver 分支 + prompt）
> + `packages/web`（频道设置开关）

## 0. 一句话定位

T2 解决「到点自己来」（时间触发），T8 解决「有事立刻来」（事件触发）：
**频道里人类发了一条没有 @ 任何 agent 的消息，频道经理 agent 自动醒来分诊——
自己回、派给合适的 worker、或沉默放过。**

两者共享沉默协议与派发底座，代码面不冲突（T2 动 scheduler，T8 动 messages 路由）。

## 1. 现状链路：断点在哪

发帖路由 `messages.ts`（POST /send）事务内：

```
content.includes("@")? ──否──> mentionAgents = undefined ──> 无任何唤醒字段
        │是                                                    │
        ├─ 公开频道:候选 agent 子串匹配 → 命中自动入圈           ▼
        └─ 私有频道:仅成员 agent 可被唤醒              daemon agent:deliver 直接 break
```

daemon 侧（`daemon-core.ts:342`）只有三个唤醒源：`mentionAgents`（被 @）、
`dmAgentRecipients`（DM）、`forceDeliverTo`（经理派单 📋 通知）。
**无 @ 普通消息 → 三个字段都没有 → agent 完全无感。**

## 2. 已有零件盘点

| 零件 | 状态 | 位置 |
|------|------|------|
| 频道经理一等公民 | ✅ `channel_members.is_manager`（007 迁移）+ `isChannelManager()` | `agent-helpers.ts` |
| 经理 → worker 派单 | ✅ `dispatch_task`：📋 通知 + 看板卡片同步 + `forceDeliverTo` 唤醒 worker | `agents-dispatch.ts` |
| 防刷屏合并 | ✅ A1 队列：经理忙时多条消息合并成一条复合 prompt | `agent-dispatch-queue.ts` |
| 防自环 | ✅ `senderType === 'agent'` / `🤖` 前缀直接丢弃 | `daemon-core.ts:345,371` |
| 沉默协议模式 | ✅ T2 patrol prompt 同款（「沉默是正常产出」） | 02 文档 §T2.3 |
| worker 回报闭环 | ✅ `report_task` → 经理收到 ✅ 通知 + 看板流转 | `agents-dispatch.ts` |

**缺的只有：一条路由规则 + 一个 prompt 模板 + 一个频道开关。**

## 3. 关键决策

### D1 事件驱动，不用 patrol 轮询近似
patrol 最小周期 5min：延迟高、无事空醒烧 token、还要簿记「哪些消息已分诊」。
巡逻适合「周期性地看」，不适合「有事立刻来」。两条链路各司其职。

### D2 频道级 opt-in 开关，默认关
`channels.manager_triage_enabled BOOLEAN NOT NULL DEFAULT false`。
不是每个频道都要经理盯（闲聊频道开了纯烧 token），由人类显式开启。

### D3 新字段 `triageAgents`，server 端单选一名经理
不复用 `mentionAgents` 语义（那是「有权回应的 @ 名单」）。
server 只下发**一名**经理（多名 `is_manager` 时取最早加入者）——
多 daemon 拓扑下若各醒一名经理会重复分诊；单选保证全集群唯一分诊者。

### D4 只认 human 顶层消息
- agent 消息不触发（沿用 `senderType` 防自环，dispatch 📋 走 `forceDeliverTo` 不受影响）；
- **线程回复不触发**（`threadId IS NULL` 才分诊）——线程是已进行的子会话，
  逐条分诊噪音太大；线程内仍可 @ 唤醒；
- DM 不触发（DM 已有无条件唤醒）。

### D5 沉默协议复用 T2 模式
分诊是软约束 prompt + 硬底座（A1 合并）：
「无需 agent 处理 → 直接结束回合，不发任何消息」。
人类之间的闲聊经理不应插嘴——这是产品体验红线。

### D6 触发条件 = 「无 agent 会被唤醒」的全集
`mentionAgents === undefined`（没 @）**或** `mentionAgents.length === 0`
（@ 了但没命中任何 agent，如 @ 的是人）都算，避免「@ 了人但没人理」的空档。

## 4. 详细设计

### T8.1 [server] migration `013_manager_triage.sql`

```sql
ALTER TABLE channels ADD COLUMN IF NOT EXISTS manager_triage_enabled BOOLEAN NOT NULL DEFAULT false;
```

### T8.2 [server] 发帖路由（`messages.ts`）

mention 检测之后、broadcast 之前加：

```ts
// T8 分诊：无 agent 会被唤醒 + 顶层消息 + 频道开关开 → 附加单选经理
let triageAgents: string[] | undefined;
const noAgentWoken = mentionAgents === undefined || mentionAgents.length === 0;
if (!dm && !threadId && noAgentWoken) {
  const ch = await app.pg.query(
    "SELECT manager_triage_enabled FROM channels WHERE id = $1", [resolvedChannelId]);
  if (ch.rows[0]?.manager_triage_enabled) {
    const mgr = await app.pg.query(
      `SELECT a.name FROM channel_members cm JOIN agents a ON a.id = cm.member_id
        WHERE cm.channel_id = $1 AND cm.member_type = 'agent' AND cm.is_manager = true
        ORDER BY cm.joined_at ASC LIMIT 1`, [resolvedChannelId]);
    if (mgr.rows[0]) triageAgents = [mgr.rows[0].name];
  }
}
// broadcast 负载加:...(triageAgents ? { triageAgents } : {})
```

### T8.3 [daemon] deliver 分支（`daemon-core.ts`）

`agent:deliver` 处理链末尾（mention 未命中后）加第四唤醒源：

```ts
const triageList = m.triageAgents as string[] | undefined;
const triageTarget = triageList?.find((n) => this.runtime.hasAgent(n));
if (triageTarget) {
  // channelName/replyTarget 计算与 mention 路径相同
  await this.runtime.runAgentTriage(triageTarget, channelName, replyTarget, senderName, content);
}
break;
```

位置在 `senderType === 'agent'` 拦截之后 → agent 消息天然不触发。

### T8.4 [daemon] 分诊 prompt（`agent-runtime-dispatch.ts`）

```ts
const runAgentTriage = async (
  agentName: string, channelName: string, replyTarget: string,
  senderName: string, content: string,
): Promise<void> => {
  const userMsg = [
    `【频道分诊】#${channelName} 来了一条新消息，没有人 @ 任何 agent。`,
    `来自 @${senderName}：${content}`,
    ``,
    `你是本频道的经理 agent，请判断：`,
    `- 该你处理 → 用 \`send_message\`（target="${replyTarget}"）直接回复`,
    `- 该别的 agent 处理 → 用 \`dispatch_task\` 派给合适的成员 agent（对方会自动收到通知开工）`,
    `- 无需 agent 介入（人类闲聊/纯围观/与职责无关）→ 直接结束回合，不发任何消息`,
    `拿不准先读上下文再定。沉默是正常产出，不要因为"来了消息"就硬回复。`,
  ].join("\n");
  await dispatchToAgent(agentName, channelName, userMsg);
};
```

`REMINDER_TAIL` 统一追加逻辑不动；A1 队列忙碌合并天然覆盖「人类连发多条」场景。

### T8.5 [server] 开关 API（`channels.ts`）

扩展频道更新路由：`PATCH /api/channels/:id` 接受 `managerTriageEnabled: boolean`，
鉴权复用现有频道管理权限（owner/admin）。开启前置校验：频道至少有一名
`is_manager` 的 agent，否则 400（开了也没人接）。

### T8.6 [web] 频道设置

频道设置面板加「经理自动分诊」开关：无经理 agent 时置灰并提示
「先指定一名经理 agent」；开启后频道头部可显示「经理值守中」badge（可选）。

### T8.7 测试 + 文档回写

见 §5。`01-buzz-borrowing-todo.md` 汇总表勾 T8，功能概览补「频道经理自动接活」。

## 5. 验证方案（四层）

**L1 单测**
- 路由：无 @ + 开关开 + 有经理 → 负载含 `triageAgents`；有 @ 命中 agent 时不含
  （防双重唤醒）；@ 的是人类（mentionAgents=[]）时含；线程回复不含；开关关不含。
- daemon：triage prompt 含三选一分支与沉默协议；`triageAgents` 中无本机托管 agent 时不醒。

**L2 集成**（server test 框架）
- POST /send（无 @）→ `agent:deliver` 广播含 triageAgents；agent 发帖（dispatch 📋）
  不含；多经理频道只下发最早一名。

**L3 手动 E2E**（~20min 剧本）
```
① 开开关的频道发无 @ 求助「XX 接口报错变多了」 → 经理醒:直接回 或 dispatch 给 worker
② 发纯闲聊「今天天气不错」 → 经理沉默,频道零新消息
③ 人类连发 3 条 → 经理只醒一次(A1 合并成复合 prompt)
④ 关开关频道发无 @ 消息 → 无人理(现状不回归)
⑤ 线程内回复不触发;线程内 @ 经理仍正常唤醒
```

**L4 指标/审计**
- 新增 `triageWoken` counter；分诊结果可经 O2 events 链追溯
  （message.send → dispatch.create / message.send(by manager)）。

## 6. 参数基线

| 参数 | 默认 | 说明 |
|------|------|------|
| 开关 | 每频道，默认关 | opt-in 控成本 |
| 分诊经理 | 单选（最早 joined_at） | 防多 daemon 重复分诊 |
| 触发面 | human + 顶层消息 + 无 agent 被唤醒 | 线程/DM/agent 消息不触发 |
| 速率上限 | v1 不做 | 依赖 A1 合并 + 沉默协议；失控再加频道级节流 |

## 7. 完成后效果（T2 + T8 闭环）

```
人类随手在频道丢一句「最近 XX 接口报错变多了」
  → 经理 agent 自动醒来分诊(T8)
  → dispatch_task 派给 @排查工(已有工具)
  → worker 查完 report_task 回报(已有)
  → 经理汇总发频道(已有)
  → 平时经理每 2h 自己巡检告警频道(T2)
  → 全程无人时 agent 休眠,零常驻成本(idle-reclaimer)
```

「把消息丢进频道，AI 团队自己接单、分工、交付」——agent 主动性两条腿
（T2 定时 + T8 事件）补齐，这是对齐 Buzz 远程 agent 团队愿景的核心一块。

## 8. 风险与边界

- **token 成本**：每条无 @ 顶层消息都唤醒经理 → opt-in + A1 合并 + 沉默协议三重控制；
  v1 不做速率上限，观察真实用量再说。
- **经理误判**（该沉默时插嘴/派错人）：软约束 prompt；全程可审计（O2 事件链），
  体验问题迭代 prompt 解决。
- **与 T1 的边界**：分诊是「单跳判断」；多步骤编排/审批门仍属 T1 工作流引擎，
  不在本期引入规则引擎。
- **不做**：线程内分诊、多经理会签、基于内容分类的智能路由（先用 LLM 自己的判断）。
