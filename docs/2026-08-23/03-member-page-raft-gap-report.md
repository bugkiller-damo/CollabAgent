# 成员页对照 Raft 的功能分析与修改报告

> 日期：2026-08-23
> 状态：本期 A + B 已落地（2026-08-23）；拍板 Q1-A / Q2-B 同批 / Q3-A 不放启动按钮
> 范围：`/people` 协作面 + `MemberProfileDrawer`；不改 daemon 派发语义
> 依据：Raft 提取 `docs/2026-08-23/临时.txt`、截图 `docs/2026-08-22/raft成员图1.png`、现设计 `docs/2026-08-23/01-member-profile-design.md`、现实现 PeopleView / PeoplePane / MemberProfileDrawer
> 视觉约束：**不仿 Raft UI**。不抄 brutal 黄、硬阴影、奶油工作台脸。沿用现有灰蓝 Tailwind。本文只借信息架构与产品判断。

---

## 0. 一句话

Raft 成员页的判断是对的：**人 / Agent 是工作对象，不是侧栏一行字。** Slock P0 已经用抽屉把对象点开了。下一步不要把 `/people` 做成 Raft 皮肤，也不要把 Claude Code 运维整块塞进通讯录；要补的是 **目录页本身的浏览结构** 和档案里 **有数据才露的监督块**。

---

## 1. Raft 成员页：功能设计（忽略视觉）

### 1.1 形态

**左列表 + 右栏详情面板**（`thread-layout-container`），不是独立整页，也不是遮罩抽屉。

```
┌─ 左：成员目录 ─────────┬─ 右：选中对象的面板 ──────────────┐
│ 成员 | 计算机 | 应用    │ 头 + 主操作                         │
│ 搜索 / + / 筛选         │ 资料* 动态 聊天 提醒 工作区 应用 MCP │
│ 人 / Agent 行           │ 身份 + 信息 + 配置 + 操作           │
│ 3 台计算机 · 5 个成员   │                                    │
└─────────────────────────┴────────────────────────────────────┘
```

窄屏：面板占满主区，`上一步` 回列表。

当前 dump 打开的是 Agent「灵耀Cindy」，副标题 `Onboarding Assistant`。

### 1.2 左栏（截图）

| 能力 | 说明 |
|------|------|
| 一级导航 | 成员 / 计算机 / 应用 并列 |
| 搜索 | 搜成员 |
| 添加 | `+` 创建成员或 Agent |
| 筛选 | 漏斗（维度未知） |
| 人类行 | 名 + 「在线」+ 「你」 |
| Agent 行 | 名 + 描述 + 「离线」 |
| 底统计 | 「3 台计算机」「5 个成员」 |

### 1.3 右栏头 + 主操作

- 头像、显示名、描述一行
- **消息**（进聊天）
- **启动 Agent** / **重启 / 重置**（桌面顶栏；移动收进「更多操作」）
- 移动：`上一步`

### 1.4 Tab（7 个，可拖拽排序）

| Tab | testid | 意图 |
|-----|--------|------|
| 资料* | `panel-tab-profile` | 身份与配置（本 dump 唯一有内容） |
| 动态 | `panel-tab-activity` | 活动流 |
| 聊天 | `panel-tab-chat` | 与该对象私聊 |
| 提醒 | `panel-tab-reminders` | 针对该对象的 reminder |
| 工作区 | `panel-tab-workspace` | 该 Agent 工作区文件 |
| 应用 | `panel-tab-integrations` | 绑定的集成 |
| MCP | `panel-tab-mcp` | 该 Agent 的 MCP |

后三个偏 worker；前四个偏同事。dump 里后 6 个只有标签，无空态/列表。

### 1.5 资料 Tab 区块（穷尽）

| 块 | 字段 / 动作 |
|----|-------------|
| 身份条 | 大头像（可换）、显示名、离线点、`@handle` |
| 显示名称 | 内联编辑 |
| 描述 | 内联编辑（岗位定位） |
| 信息 | 角色（徽章「成员」+ 权限帮助）、计算机（可点「灵耀14air」· 离线 · 守护进程离线）、创建时间、创建者（可点进人类资料） |
| 运行时配置 | 运行时 / 模型 / 推理强度 / 模式 / 提供方 / 命令（未定制显示斜体「默认」） |
| 已创建的 Agent | 计数 0，空态「暂无已创建的 Agent」 |
| 连接失败 | 英文 `Machine is not connected to this server replica` + **重试** |
| 操作 | 启动 Agent、重启/重置、复制诊断信息、报告问题、删除 Agent |

### 1.6 产品判断

**「成员」= 工作区参与者统一抽象。** Agent 当同事放进通讯录（能聊、看动态、设提醒、配应用），同时又是绑在某台计算机上的可启停 worker。角色层把 Agent 当普通「成员」，不是另一套 admin。

### 1.7 Slock 明确不要照抄的（worker-pool）

这些是「本机守护进程 + Claude Code runtime」运维面，不是通讯录必要 IA：

- 运行时整块：推理强度 / 模式 / 提供方 / 命令（含「默认」占位）
- replica 未连接 + 重试
- 启动 / 重启重置当档案主按钮
- 复制诊断信息、报告问题
- MCP Tab、工作区 Tab 挂在单个成员上
- 「已创建的 Agent」当档案主块（Slock 没有 spawn 子 Agent 模型）
- 删除 Agent 直接放协作抽屉
- 把计算机与成员做成同一页的两个池（Slock 计算机已是独立一等公民 `/computers`）
- 人类 Idle Timeout / Max Concurrent Tasks / Default Priority（既有设计已拒绝）
- 空壳 Skills 大卡片、空 Tab

可借的「同事」层：统一目录、显示名/描述/@handle、在场态、发消息、动态、角色、创建者/加入时间、Agent 绑哪台机（只读深链）。

---

## 2. Slock 现状（用户说的「成员页」= `/people`）

Rail / 移动底栏「成员」都进 `/people`。People pane 是同一份名单的 240px 轻列表。`/admin/members` 是 org 人类管理，不是这页。

### 2.1 `/people` 现在什么样

- 顶栏：「成员」+ 「工作区里的人与 Agent」
- 右上：**管理 Agent** / **工作区成员** / **我的计算机**（跳走，不是本页能力）
- 分区卡片网格：Agent（绿点、五态、`@name`、两行 bio）/ 人类（无绿点、无 bio）
- 单击开右侧抽屉，不直接 DM / 终端
- 列表数据：`GET /api/agents` + `GET /api/server/info` 的 `humans`（排除自己）
- 无搜索、无筛选、无底统计、无选中后的主区详情列

### 2.2 档案抽屉（P0 已落地）

`MemberProfileDrawer`，lg 380px 列，移动全屏 sheet。无 Tab。

已有：头像、名、Human/Agent 徽章、👔 经理、`@handle`、Agent 五态、bio、加入日期、频道角色、发消息、打开观察、在此 @、当前进度、runtime·model、所在频道（超 8 条只写「还有更多频道」）。

没有：最近发言、近 7 天统计、Activity、Settings/Danger 深链、工具白名单、派任务、`?member=` 刷新恢复。

入口已多于设计三处：People 整页 / pane、频道成员行、消息头像、线程父消息、DM 顶栏、ComputerView Agent。Admin 两页仍不进档案。

### 2.3 对照一表

| Raft | Slock 现在 | 判定 |
|------|------------|------|
| 左列表 + 右面板 | 卡片网格 + 抽屉叠在任意主页 | **目录页 IA 弱**；抽屉在频道上下文是对的 |
| 搜索 / + / 筛选 | 无 | 目录要补搜索；「+」不要做成第二套创建 |
| 底统计 计算机+成员 | 无 | 可做轻量数字 |
| 7 Tab | 无（正确：无数据不画空壳） | 动态/设置按数据再露 |
| 内联改名/描述 | 无；改资料在 Settings / Admin | 深链，不复制表单 |
| 计算机 + 守护进程 | 档案无机器；`/computers` 独立 | Agent 档案只读挂「跑在哪台机」 |
| 运行时六字段 | runtime · model 一行 | 够用；其余留 Admin |
| 启动/重启主按钮 | 无；启停在 daemon / Admin 终端 | 保持，不当通讯录主操作 |
| 删除/诊断/报问题 | Admin | 保持 |
| 消息 | 发消息 → `/dm` | 已有 |
| 动态 / 提醒 | 无 | 动态走既有 Activity 方向；提醒无产品则不做 |
| MCP / 工作区 Tab | Agent 回话是 MCP，不挂成员页 | 不做成员 Tab |
| 人类绿点 | 不做假绿点 | 保持 |

---

## 3. 修改原则

1. **视觉继续灰蓝。** 任何 Raft ASCII 都不是视觉稿。
2. **频道里点人仍用抽屉。** 看着聊天开档案，不要抽走上下文（既有 §3 / Q1-A）。
3. **`/people` 才改成「目录 + 详情」。** 这是 Raft 真正值得借的 IA：成员页自己能看完一个人，不必先跳进频道再开抽屉。
4. **配置不平行造第二套。** 改名/bio/runtime/删 Agent/踢人继续走 `/settings/profile`、`/admin/agents`、`/admin/members`、频道名单 hover。
5. **有数据才露块。** 不画空 Tab、空 Skills、空「派任务」。
6. **调度对象是 Agent。** 人类不做 worker pool。

---

## 4. 建议改什么（按页）

### 4.1 `/people`：从卡片墙改成目录页（本期主改）

目标骨架（灰蓝，不是 Raft 黄）：

```
┌─ 已有 rail+pane ─┬─ 目录（左，约 320px）─┬─ 详情（右，复用抽屉内容）─┐
│ 成员选中          │ 搜索                  │ 同一套 MemberProfileBody   │
│                   │ Agent / 人类 分组     │ 无独立路由                 │
│                   │ 底：N 人 · M Agent    │                            │
└───────────────────┴───────────────────────┴────────────────────────────┘
```

具体：

| # | 改动 | 不改 |
|---|------|------|
| 1 | 主区两列：左名单、右详情。未选中时右栏空态「选一个成员看档案」 | 不改成 `/people/:handle` |
| 2 | 名单保留分组（Agent / 成员），行比现在的卡更密，带五态 / `@` / 一行 bio | 不把计算机列表嵌进本页 |
| 3 | 顶加搜索（滤显示名 + handle） | 筛选漏斗无明确维度则先不做 |
| 4 | 单击行 = 选中并填右栏（`openProfile`）；高亮当前行 | 不在行上直接 DM |
| 5 | 底栏只读：「N 位成员 · M 个 Agent」 | 不并列「K 台计算机」（那是 `/computers`） |
| 6 | 右上三按钮改成次要文字链，或收进「管理」菜单，避免像本页主 CTA | 不在本页做创建 Agent / 邀请 |

窄屏：只显示名单；点行进现有全屏 sheet（已有），sheet 顶保留关闭。不必再造「上一步」新栈。

People pane 已取消（2026-08-23）：成员与搜索/动态一样只留 rail + `/people` 全页，不再占 240px 二级栏。

### 4.2 档案内容：补「同事层」，不补运维层

把抽屉里的主体抽成 `MemberProfileBody`，`/people` 右栏和抽屉共用，避免两套 UI。

在既有 Overview 上加（仍无空 Tab 栏，除非至少 2 个 Tab 有内容）：

| 块 | 谁 | 来源 | 备注 |
|----|----|------|------|
| 最近发言 | 人 / Agent | 该 actor 最近一条可见消息时间 | 文案「最近发言于」，不画绿点 |
| 跑在 | 仅 Agent | computers / owner 已有关系 | 只读，点了去 `/computers/:id`。没有则隐藏 |
| 本周统计 | 人 / Agent | 新 `GET /api/people/:handle/stats?days=7` | 消息数、进行中/完成任务；成本没有则隐藏 |
| 设置入口 | 自己 / Agent 所有者 | 深链 | 「编辑资料」→ `/settings/profile`；Agent → `/admin/agents` 带 query |
| 查看全部频道 | 已有截断 | 现 `channelsHasMore` | 把静态字改成可点展开或弹层，不要空许诺 |

明确不做（对照 Raft 操作区）：

- 档案主按钮「启动 / 重启 / 删除」
- 复制诊断、报告问题、replica 重试
- 运行时六字段编辑、推理强度、命令
- MCP / 工作区 / 应用 / 提醒 Tab
- 「已创建的 Agent」
- 派任务（P0/本期仍不做，与既有 Q2-A 一致）

### 4.3 API

现有 `GET /api/people/:handle` 够身份。本期若做统计，按既有设计 §7.2 加：

```
GET /api/people/:handle/stats?days=7
→ { messages, tasksOpen, tasksDone, costUsd?: number | null }
```

权限：只计调用者能读的频道。`costUsd` 本机 daemon 看不到就 `null`，UI 隐藏。

Agent「跑在哪台机」优先复用现 computers API，能塞进 `PersonProfile` 再加只读字段 `computer?: { id, name, online }`，没有就先不做。

不新增写接口。

### 4.4 不在本期动的面

- `ChannelMembersPanel` 管理 hover、与档案互斥：已符合
- `/admin/members`、`OrgMembersPanel`、`AgentManagement`：继续当管理面
- daemon、成本记账键、presence 协议

---

## 5. 分期

### 本期 A — `/people` 变成能看完的目录（建议先做）

1. 抽出 `MemberProfileBody`（抽屉与右栏共用）
2. PeopleView 两列：搜索 + 密列表 + 右栏详情 + 底统计
3. 空态、当前行高亮、移动仍全屏 sheet
4. 「还有更多频道」改成可展开

验收：在 `/people` 不进频道也能看完 bio、类型、Agent 五态、所在频道；搜索能滤人；视觉仍是灰蓝。

### 本期 B — 可监督（可与 A 同批若 API 顺手）

1. `GET /api/people/:handle/stats`
2. Overview 近 7 天三个数字；成本有则加第四个
3. 「最近发言于」
4. Agent「跑在 {计算机}」只读深链（数据现成才做）
5. 「编辑资料」深链，不内联表单

### 以后（仍按既有 P1/P2，不升级优先级）

- `?member=` 刷新恢复
- Activity Tab（复用 `/activity` 数据，不新协议）
- Danger 深链收口
- 工具白名单只读
- 派任务、抽屉内嵌编辑

---

## 6. 关键文件

| 文件 | 角色 |
|------|------|
| `packages/web/src/pages/PeopleView.vue` | 主改：目录 IA |
| `packages/web/src/components/people/MemberProfileDrawer.vue` | 抽 Body，抽屉只留壳 |
| `packages/web/src/components/layout/panes/PeoplePane.vue` | **已删**（成员不再占二级栏） |
| `packages/web/src/stores/uiStore.ts` | `openProfile` 已够；`/people` 选中即打开 |
| `packages/server/src/routes/people.ts` | 仅当做 stats / computer 字段 |
| `packages/shared/src/index.ts` | `PersonProfile` 扩展 |

---

## 7. 审查时请盯

1. `/people` 两列不要和频道里的抽屉抢：频道继续抽屉，成员页才是固定右栏。
2. 不要把 Admin 启停删、MCP、工作区搬进档案主路径。
3. 列表继续排除自己可以，但点自己消息头像仍应能开档案（已有）。
4. `resolvePeer` 仍先 user 后 agent，与 DM、@ 一致。
5. 搜索只做本地滤现有两份名单，不必先造 `GET /api/people` 列表。

---

## 8. 请拍板（未标按推荐）

**Q1. `/people` 要不要改成左列表 + 右详情？**

- A（推荐）：要。这是对照 Raft 后唯一值得动目录页的点。
- B：保持卡片网格，只加搜索和统计。

**Q2. 统计和「跑在哪台机」跟目录 IA 同批吗？**

- A（推荐）：先交目录 IA；统计 / 机器只读有空再挂。
- B：同批做完本期 B。

**Q3. 档案要不要出现「启动 Agent」？**

- A（推荐）：不要。启停是 daemon / 计算机面的事。
- B：Agent 离线时给一个深链到 `/computers`，文案「去计算机页启动」，不当主按钮。
