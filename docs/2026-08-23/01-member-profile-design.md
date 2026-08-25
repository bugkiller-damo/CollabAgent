# 成员档案（Human / Agent 一等公民）

> 日期：2026-08-23
> 状态：P0 已落地（2026-08-23）；目录 IA + 近 7 天统计 / 跑在哪台机 / 编辑资料深链于 2026-08-23 随 `03-member-page-raft-gap-report.md` 落地。P1 余：`?member=` 刷新恢复、Activity Tab、工具白名单只读、派任务。拍板：抽屉无独立路由、无派任务主按钮、People 单击开档案、人类不做假绿点
> 范围：`packages/web` 协作面 + `packages/server` 只读聚合；daemon 运行时不改
> 依据：Raft 成员图（`docs/2026-08-22/raft成员图1.png`）功能对照；现有 `PeoplePane` / `ChannelMembersPanel` / `AgentManagement` / `ProfileSettings`；侧栏两列化 `docs/2026-08-22/01-web-two-column-sidebar-design.md` §4.5
> 视觉约束：不仿 Raft UI（`docs/2026-08-22/02-raft-ui-visual-alignment.md` 已废弃）。沿用现有灰蓝 Tailwind。

P0 入口：`GET /api/people/:handle`、`MemberProfileDrawer`、People pane / 频道成员行 / 消息头像。

---

## 0. 一句话

把「成员」从名单 + 管理动作，升级为 **可浏览、可操作、可配置的对象**：人类和 Agent 共用同一套档案壳，字段按类型切换。数据大半已有，缺的是汇到一张卡。

---

## 1. 为什么做

Raft 成员页拉开的不是皮肤，是产品判断：**人 / Agent 是工作对象，不是侧栏一行字。**

Slock 现状：

| 入口 | 能看到 | 缺口 |
|------|--------|------|
| 频道右栏 `ChannelMembersPanel` | handle、角色、经理、邀请/踢 | 无 bio、无状态、无统计、点开无详情 |
| 侧栏 `PeoplePane` | Agent 在线/工作中；人类点开 DM | 人类无 last seen；Agent 点开是终端不是档案 |
| `/admin/members` | org 角色、邀请链接 | 纯组织管理 |
| `/admin/agents` | CRUD、巡检、runtime/model | 管理员后台，不是协作面 |
| 顶栏进度 / 观察面板 | 「正在干什么」 | 不绑定具体成员 |

一句话：**有成员列表和 Agent 运行时，没有成员对象。**

已有可复用数据（不必先造表）：

- 人类：`users.display_name / description / avatar_url / created_at`
- Agent：`agents.display_name / description / avatar_url / runtime_profile / created_at`；daemon 五态（`agentStore`）；`isOnline`（daemon 是否连上该 owner）
- 频道：`channel_members.role / joined_at`；经理（`007_dispatches.sql` / PATCH member）
- 消息：`messages.sender_id + sender_type`（可计消息数）
- 任务：`messages.task_assignee / task_status`
- 成本：daemon D3 按 (agent, channel, UTC day)（web 尚未挂到人）
- 进度：T4 `agent:progress` + 观察流

---

## 2. 目标与非目标

**做：**

1. 同一套档案壳（人类 / Agent）；
2. 从频道成员、People pane、消息头像三处进入同一份详情；
3. 主操作：发消息（人类 DM / Agent DM 或当前频道 @）；Agent 另开观察；
4. 只读监督块：近 7 天消息/任务；Agent 再加当前进度、成本、工具白名单只读；
5. 配置仍走现有权限（频道角色 / 经理 / Admin CRUD），收拢入口，不平行造第二套管理。

**不做（本期明确拒绝）：**

- Raft 黄底、硬阴影、奶油工作台脸；
- 把人类做成 worker pool（Idle Timeout / Max Concurrent Tasks / Default Priority）——Slock 调度对象是 Agent；
- 空壳 Skills 大卡片；
- 把 Admin 整页塞进 240px pane；
- 改 daemon 派发 / 成本记账语义；
- 真人 presence 协议（心跳、最后出现精确到分钟）——P0 用「当前会话在线」即可，last seen 能从 `updated_at` / 最近消息近似再标「近似」。

---

## 3. 壳子：抽屉，不是新整页

推荐 **主区右侧抽屉**（约 360–400px，叠在 ChannelView / 任意主页上），原因：

- 频道右栏已经是 240px 名单，再加一列会挤聊天；
- 独立 `/people/:handle` 会把人从当前频道上下文里抽走；刷新可深链，但 P0 协作路径是「看着频道点开这个人」；
- People pane 只有 240px，放不下档案。

```
┌─ rail ─┬─ pane ─┬──────── 聊天 / 看板 ────────┬─ 档案抽屉 ─┐
│  👥    │ Agent  │ #代码项目                    │ 头 + Tab   │
│        │ 成员   │ …消息…                       │ Overview   │
└────────┴────────┴──────────────────────────────┴────────────┘
```

规则：

- 同时只开一份档案。再点另一个人 → 换内容，不叠抽屉。
- Esc / 点遮罩 / 点关闭 → 关抽屉。频道成员名单抽屉（现 `ChannelMembersPanel`）与档案互斥：开档案则关名单，或名单缩成「返回成员列表」。
- URL：**P0 不强制路由**（视图状态，类似 pane）。P1 加 query `?member=alice` / `?agent=coder`，刷新可恢复。独立 `/people/:handle` 列为可选（见 §10 Q1）。
- 移动：档案改全屏 sheet，底栏成员键仍进 People 列表，点行再进 sheet。

视觉：现有灰蓝、圆角、字号层级与 `ChannelSettingsModal` / Admin Card 一致。头像沿用 `Avatar.vue`。

---

## 4. 入口（三处进同一组件）

| # | 从哪 | 现在点了怎样 | 改成 |
|---|------|--------------|------|
| 1 | `/people` 目录行 | 开档案 | 单击开档案；桌面填右栏，移动全屏 sheet |
| 2 | 频道成员名单行 | hover 改角色 / 设经理 / 踢 | 行主体单击开档案；管理按钮仍 hover，不挡 P0 |
| 3 | 消息行头像 / 显示名 | 无 | 单击开档案（自己也开，便于核对资料） |

另外保留：

- 档案内「发消息」= 现 DM 路由 `/dm/:handle`（`getOrCreateDmChannel` 已支持 human/agent）；
- 档案内「在此频道 @」= 把 `@{handle} ` 写入当前 composer（仅当主区是该频道）；
- 档案内「打开观察」= 现 `uiStore.openTerminal(name)`（仅 Agent）。

People pane §4.5 的底链（管理 Agent / 工作区成员 / 接入）不动。

---

## 5. 档案头（人类与 Agent 共用）

```
[头像]  显示名                 [Human|Agent 徽章]
        @handle · 工作中/空闲/离线
        bio 一行（无则隐藏，不放空态大图）
        加入 YYYY-MM-DD · 最近出现（能算则显示）
        [发消息]  [派任务]     Agent 另：[打开观察]
```

### 5.1 字段

| 字段 | 人类 | Agent | 来源 |
|------|------|-------|------|
| 头像 | `avatar_url` | `avatar_url` | 已有 |
| 显示名 | `display_name` 或 handle | `display_name` 或 name | 已有 |
| handle | `users.handle` | `agents.name` | 已有 |
| 类型徽章 | Human | Agent | 由路由/查询类型决定 |
| 在线态 | 当前 WS 会话（P0 能做则做，否则省略，不造假绿点） | daemon 五态：工作中 / 启动中 / 空闲 / 离线 / 已停止 | `agentStore` + `/api/agents.isOnline` |
| bio | `users.description` | `agents.description`（创建时已当角色设定） | 已有，列表从未展示 |
| 加入 | `users.created_at` 或该频道 `channel_members.joined_at` | `agents.created_at` 或频道 joined_at | 已有。档案在频道上下文打开时优先「加入本频道」 |
| 最近出现 | P0 可省略或用该人最近一条消息时间（标注「最近发言」） | Agent `working` 用进度 headline；否则最近发言 / daemon last seen | 不新增 presence 表 |
| 频道角色 | owner / admin / member | 成员 + 可选 👔 经理 | 现面板已有 |

### 5.2 主按钮

| 按钮 | 人类 | Agent | 权限 |
|------|------|-------|------|
| 发消息 | 开 `/dm/{handle}` | 开 `/dm/{agentName}` | 登录即可 |
| 派任务 | P0 **不做**（见 §10 Q2） | P0 **不做**；P1 走现任务指派 / 经理派单 | — |
| 打开观察 | 无 | 开终端面板 | 登录即可 |
| 在此 @ | 写入 composer | 写入 composer | 仅当前主区是频道时显示 |

P0 两个主按钮最多：**发消息 +（Agent）打开观察**。Raft 的 Assign Task 等 P1，避免档案上放一个点了进空看板的死按钮。

---

## 6. Tab

P0 只做 **Overview**。其余 Tab 有数据再露，没有就不要空壳。

### 6.1 Overview（P0）

块顺序：

1. **当前状态**（Agent）：顶栏同款一句话「正在读文件…」；无进度则隐藏。人类隐藏。
2. **本周统计**（P1 可后补；若 API 顺手 P0 可带只读数字）：
   - 消息数（近 7 天，`sender_id + sender_type`）
   - 任务：进行中 / 完成（`task_assignee` + `task_status`）
   - Agent 另：近 7 天成本 USD（D3；server 需能读到或先显示「仅本机 daemon 可见」）
3. **能力摘要**（Agent，只读）：runtime / model（`runtime_profile`）；工具白名单名称列表（若 server 还没有，P0 只显示 runtime+model，工具放到 P1）。
4. **所在频道**（最多 8 个 + 「查看全部」）：该成员加入的频道名。点频道 → 切聊天并关抽屉或保留抽屉。
5. **最近活动**（P1）：该 actor 的通知/任务/发言摘要。P0 可只放「最近 5 条由其发送的消息」链接。

人类 Overview 没有「当前状态 / runtime / 成本」。

### 6.2 Activity（P1）

该成员的动作流，复用 T3 方向；P1 最小是「按 sender 筛消息 + 被指派任务」。不要承诺完整活动协议。

### 6.3 Settings（P1，管理员）

**不**把 Raft 的人类 Idle Timeout 搬过来。

| 谁 | 可改什么 | 走哪 |
|----|----------|------|
| 自己（人类） | 显示名 / bio / 头像 | 链到 `/settings/profile`，抽屉里不复制表单 |
| Agent 所有者 / org owner | 显示名 / description / 头像 / runtime / model | **已改口径**（`04-admin-agent-ia-split.md`）：档案内嵌编辑，不再深链 `/admin/agents` |
| 频道 admin+ | 频道角色、是否经理 | 现 `PATCH /api/channels/:id/members/:id` |
| Agent 所有者 | 巡检 | **已改口径**：`AgentPatrolPanel` 挂在该 Agent 档案，不走 Admin 卡片 |

### 6.4 Danger（P1）

拆清两级，文案写后果：

- **移出本频道**（现已有）：仍可访问工作区其他频道。
- **停用 / 删除 Agent**（仅所有者）：**已改口径**（`04-admin-agent-ia-split.md`）：档案 Danger 可直接确认删除自身；计算机列表也可删。不再链 Admin。
- **移出工作区**（org owner，人类）：现 `/admin/members`。

P0 危险操作继续留在名单 hover，档案只展示只读角色。

---

## 7. API

### 7.1 P0：读聚合

新增只读：

```
GET /api/people/:handle
```

`:handle` 先按用户 handle 解析，没有再按当前 org 的 agent name（与 `resolvePeer` 同序）。

响应草案：

```ts
{
  type: "human" | "agent",
  id: string,
  handle: string,
  displayName: string | null,
  description: string | null,
  avatarUrl: string | null,
  createdAt: string,
  // 人类
  //  Agent
  runtime?: string,
  model?: string,
  isOnline?: boolean,          // daemon 是否在线（agent）
  // 可选上下文
  channel?: {
    id: string,
    role: string | null,
    isManager: boolean,
    joinedAt: string | null
  }
}
```

频道上下文用 `?channelId=`（从 ChannelView 打开时带上）。不传则 `channel` 为 null。

在线态：Agent 继续用现 `daemonClients.has(owner)` + 前端 `agentStore` 覆盖 working/idle。人类 P0 可不返回 presence。

### 7.2 P1：统计

```
GET /api/people/:handle/stats?days=7
```

```ts
{
  messages: number,
  tasksOpen: number,
  tasksDone: number,
  costUsd?: number | null   // 没有则 null，UI 隐藏
}
```

消息/任务用现表 count，注意权限：只能看到调用者有权读的频道。成本若只存在 daemon 本机，返回 `null`，文案「成本在托管该 Agent 的机器上查看」。

### 7.3 不新增的写接口（P0）

邀请、改角色、设经理、踢人、改资料：全部沿用现路由。档案组件调现有 `apiClient`。

---

## 8. 与现有面的关系

| 现有 | 关系 |
|------|------|
| 两列侧栏 `people` pane | **已取消**（2026-08-23）：成员只留 rail + `/people` 全页 |
| `ChannelMembersPanel` | 保留频道级管理；行单击开档案 |
| `/admin/agents` | **已改口径**（`04-admin-agent-ia-split.md`）：不再作为产品入口；增删归 `/computers`，配置/巡检归档案 |
| `/admin/members` | org 邀请/角色；档案 Danger 深链 |
| `/settings/profile` | 自己改资料 |
| T4 进度 / 观察终端 | Agent Overview 消费 `agent:progress`；「打开观察」复用终端 |
| D3 成本 | P1 stats；不改记账键 (agent, channel, UTC day) |
| T8 经理 | 档案头 👔；Overview 一句「本频道经理，可派单」 |
| T3 活动馈送 | P1 Activity Tab 的数据源，不挡档案 P0 |

---

## 9. 分期

### P0 — 成员变成可点开的对象（建议先做）

- `GET /api/people/:handle`（+ 可选 `channelId`）
- 抽屉壳 + 档案头（头像、名、handle、类型、bio、加入、频道角色/经理）
- Agent 在线/工作态（复用 store）
- 按钮：发消息；Agent + 打开观察；频道内 + 「在此 @」
- 入口：People pane、频道成员行、消息头像
- Overview 最小：所在频道列表（可从现有 membership 查）；Agent 当前进度一句话（有则显示）
- **无** 新 Tab 内容、无派任务、无统计数字也可先发（数字若 count 查询简单可顺手提）

验收：从三个入口点开同一人，看到 bio 和类型；人类能进 DM；Agent 能开观察；频道经理徽章仍对。

### P1 — 可监督

- `GET /api/people/:handle/stats`
- Overview 统计数字
- Activity：最近消息 + 被指派任务
- URL query 恢复抽屉
- Settings / Danger 深链收拢（不复制 Admin）
- Agent 工具白名单只读（若需新 API 再开）

### P2 — 可配置（视审查）

- 抽屉内嵌 Agent 编辑（display/description/model）
- 派任务：创建任务并 `task_assignee = 此人`
- 人类 last seen 若要做，再单独立 presence，不混进 P0

---

## 10. 请拍板

**Q1. 档案要不要独立路由 `/people/:handle`？**

- A（推荐）：P0 只要抽屉 + 可选 `?member=`；刷新停在当前频道。
- B：P0 就做独立页，People pane 点行跳走。

**Q2. 「派任务」按钮 P0 出不出？**

- A（推荐）：P0 不出。没有「从档案创建并指派」的现成一步流，空按钮有害。
- B：P0 出，点了跳 `/tasks` 并带 query（仍要补创建流）。

**Q3. People pane 单击还是双入口？**

- A（推荐）：单击 = 档案；发消息放到档案主按钮（多一次点击，但结束「点 Agent 却弹出终端」的意外）。
- B：单击保持现在（人 DM / Agent 终端），旁边加「详情」图标开档案。

**Q4. 人类在线绿点？**

- A（推荐）：P0 不做假绿点。有现成 WS 在线集合再用；没有就只显示 Agent 运行态。
- B：用最近发言时间当「活跃」，文案写「最近发言于」，不画绿点。

**Q5. 统计窗口？**

- A（推荐）：近 7 天。与 D3 `slock cost show` 对齐。
- B：全部历史（count 简单但越来越无意义）。

未标的按推荐做。

---

## 11. 审查时请盯

1. 抽屉 vs 独立页（Q1）一旦定，入口和返回栈就锁死。
2. 不要在 P0 堆 Settings 表单——Admin 已能改 Agent。
3. 权限：档案对工作区成员只读；写操作沿用频道/org 角色，API 不要另开一套。
4. `resolvePeer` 顺序（先 user 后 agent）必须与 DM、@ 提及一致，避免同名撞车。
5. 视觉继续灰蓝；本文任何 ASCII 框都不是视觉稿。
