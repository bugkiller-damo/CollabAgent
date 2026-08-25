# 管理后台 Agent IA 拆分：增删归计算机，配置归成员档案

> 日期：2026-08-23
> 状态：Step A + B 已落地（2026-08-23）。Q1 档案可删自身、Q2-A OrgMembersPanel → `/admin/members`、Q3-A 创建不自动开档案。
> 范围：`packages/web` 信息架构 + 入口收口；**不改** daemon 派发 / 成本 / 巡检 API / 一人一机语义。
> 依据：用户判断「Admin Agent 管理尴尬」；Computer `02-computer-onboarding-design.md.md`；成员档案 `01-member-profile-design.md` + `03-member-page-raft-gap-report.md`。
> 视觉：不仿 Raft UI。沿用现有灰蓝 Tailwind。

审查通过后再拆实施。

---

## 0. 一句话

**创建 Agent 只发生在「我的计算机」，创建时一次填齐身份与 runtime / model；删除两边都能做（本机列表 + 该 Agent 档案）。** 配巡检、改设定、观察只在成员档案。`/admin/agents` 不再作为产品入口。

---

## 1. 为什么尴尬

Computer 和 People 已经按「办公室 / 同事」长出来了，但真正能写的操作还堆在 `/admin/agents`。三套面叠在同一张管理页：

| 动作 | 真正属于谁 | 今天 |
|------|------------|------|
| 创建 Agent | **计算机**（先有办公室再有同事） | Computer 已有创建 Modal；Admin 又有一份更全的表单 |
| 删除 Agent | **计算机**（删机前必须清空这台上的工人） | 只有 Admin；Computer 危险区只拦「有 Agent 就不能删机」，本页不能删 Agent |
| 编辑 display / bio / 头像 / runtime / model | **这个 Agent 成员** | Admin 表单；档案「编辑资料」只深链 `/admin/agents?agent=` |
| 巡检 | **这个 Agent 成员** | 只在 Admin 卡片按钮上（`AgentPatrolPanel`） |
| 打开观察 | **这个 Agent 成员** | Admin + 档案都有 |
| `OrgMembersPanel`（谁能看见我的 Agent） | 工作区 / 计算机周边 | 硬塞在 Agent 管理页 |

现设计已经写过、但没收口：

- Computer：`Computer = 运维对象，Agent = 协作对象`；创建入口贴在「我的计算机」上。
- 成员档案：Admin 是重操作，档案 Settings 深链、不平行造第二套管理。
- 成员对照报告：不要把 Claude Code 运维整块塞进通讯录。

结果：**协作面能看、运维面能写，用户不知道该进哪。** Admin 变成第三套 CRUD。

---

## 2. 目标与非目标

**做：**

1. **创建**唯一入口 = `/computers`；Modal 一次填齐身份 + runtime / model（对齐今天 Admin 表单，必填项见 §4.1）。
2. **删除**两处：计算机列表（清办公室）+ 该 Agent 档案 Danger（owner 删自身）。同一 `DELETE /api/agents/:id`。
3. 该 Agent 的配置与功能（编辑资料、巡检、观察）入口 = 该成员档案（`/people` 右栏 / 抽屉）。
4. `/admin/agents` 下线为 redirect；Admin 只留工作区级能力（频道、人类成员、指标）。
5. 入口（People「管理」菜单、档案 `goEdit`、Onboarding、Admin 概览）全部改指向新家。
6. `OrgMembersPanel` 找新家，不随 Agent 管理页一起消失。

**不做：**

- 改 daemon 派发、成本记账、巡检 API、一人一机、`daemonClients` 键。
- 为删 Agent 新开写接口（继续 `DELETE /api/agents/:id`）。
- 把 Admin 整页塞进 240px pane。
- Raft 式 7 个空 Tab、档案上的启动/重启主按钮（`03` 已否决）。
- 在 `/people` 通讯录或 Admin 再放一套「创建 Agent」。
- 让 A 在自己的计算机页增删 B 的 Agent；别人档案上不露删除。

---

## 3. 对象职责

```
计算机（办公室）                         成员（同事）
  连上 / 探测 / 令牌                       人类档案 / Agent 档案
  创建（完整表单：身份 + runtime/model）    发消息 / @ / 观察
  删除这台上的 Agent                        改显示名、bio、头像、模型
  清空后才能删机                            巡检任务
                                           owner 可删除自身
                                           只读：跑在哪台机（链回计算机）
```

漏斗（与 Computer 设计一致，只是把「真正能写」从 Admin 拔掉）：

```
连机 → /computers 绿点
  → 在这台上「创建」：名称 / 显示名 / 描述 / 头像 / runtime / model
  → 出现在本机列表 + /people 通讯录
  → 点这个 Agent：改设定 / 巡检 / 观察 / @ / 删除自身
  → 或在本机列表删除
  → 机要拆：先删光 Agent，再删计算机
```

---

## 4. 计算机页

`ComputerView` 已有「这台计算机上的 Agent · N + 创建」。补齐、收口。

### 4.1 创建（完整表单，不是瘦 Modal）

创建时就要定下这个同事是谁、用哪颗脑子，不把「先建空壳再去 Admin 补字段」留回去。

| 字段 | 必填 | 说明 |
|------|------|------|
| name | 是 | handle，如 `slock-backend` |
| displayName | 是 | 通讯录显示名 |
| description | 否 | 角色设定；空则档案显示「未填写」 |
| avatarUrl | 否 | |
| runtime | 是 | picker **只列已接线且 installed**（P0 = Claude）。未连机 / 未装 Claude 整表禁用 |
| model | 是 | 随 runtime 的可选模型（P0：sonnet / opus / haiku） |

现 Computer Modal 太瘦（只有 name / 描述 / model）。实施时换成今天 Admin 那套字段，runtime + model 必选，不能默认蒙混过关还不让用户看见。

成功：刷新列表 + 文案「已创建。被 @ 时才会拉起进程」。**不要跳 Admin。** 不自动开档案（§11 Q3-A）。

### 4.2 列表

- 行：头像、名、runtime、五态（复用 `agentStore`，不要用 `isOnline` 冒充进程已起）。
- 单击开档案（协作对象）。行上 **不堆** 巡检 / 编辑 / 终端。
- **删除**：行 hover 或行尾危险操作 + 与档案同一确认文案（移除身份与频道成员关系，历史消息保留）。
- 删光之前，「删除计算机」继续 disabled。

### 4.3 不要搬上来

巡检、事后改角色设定、开终端——点进这个人再做。runtime / model **创建时就要选**；建成后改在档案里改，不在计算机行上改。

### 4.4 权限

只能管自己这台上、`user_id = me` 的 Agent（现 `GET /api/agents?mine=1` 已是这个语义）。

---

## 5. 成员档案（具体 Agent）

档案已经是「点开这个对象」的壳。把 Admin 卡片上的功能收进来，而不是再做一张管理页。

**owner / `ownedByMe` 才露写操作；非 owner 继续只读。**

| 块 | 做法 |
|----|------|
| 编辑资料 | 档案内嵌：显示名、描述、头像、runtime、model。保存走现 `PATCH /api/agents/:id`。人类自己仍链 `/settings/profile`，抽屉里不复制人类表单 |
| 巡检 | 现成 `AgentPatrolPanel` 挂在该 Agent 档案（区块或「巡检」分段），不要先做空 Tab |
| 打开观察 | 已有，保留 |
| 跑在哪台 | 已有，点回 `/computers/:id` |
| 删除自身 | owner 可见 Danger：「删除此 Agent」→ 与计算机页同一确认框 → `DELETE /api/agents/:id` → 关档案，回到 `/people` 或当前频道。非 owner 不露 |

`MemberProfileBody.goEdit()` 今天跳 `/admin/agents?agent=`，改为档案内打开编辑态（或 query `?tab=settings`，P0 不必上独立路由）。

People 页「管理」菜单：

- **去掉**「管理 Agent」
- 保留「工作区成员」→ `/admin/members`（人的邀请/角色，不是 Agent）
- 「我的计算机」可留，或只靠 rail

---

## 6. 管理后台瘦身

Admin 只留 **工作区级、跨对象** 的事：

| 保留 | 理由 |
|------|------|
| `/admin/channels` | 房间，不是人/机 |
| `/admin/members` | 人类邀请、org 角色 |
| `/admin/metrics` | 全局监督 |

**Agent 管理 Tab 下线：**

- `/admin/agents` → redirect `/computers`；若带 `?agent=` 则去 `/people` 并 `openProfile`
- `AdminPanel` 去掉该卡片 / Tab
- `AgentManagement.vue`：抽共享小组件后删除页面

`OrgMembersPanel`（私有空间谁能看见我的 Agent）不属于 Agent CRUD：

- 短期：挪到 `/admin/members` 或 Computer 页底部「谁能看见这台上的 Agent」
- 不要跟着 Agent 管理一起删掉却无处安放

---

## 7. 与现有面的关系

| 现有 | 迁完 |
|------|------|
| `/admin/agents` | 不再是产品入口；redirect |
| `/computers` Agent 列表 | **创建**唯一入口（完整表单）；也可在本机列表删除 |
| `MemberProfileBody` | 该 Agent 的配置 / 巡检 / 观察 / **删除自身**；编辑不再深链 Admin |
| `/people` 管理菜单 | 去掉「管理 Agent」 |
| `/admin/members` | 人类 org 成员；可接收 `OrgMembersPanel` |
| T2 `AgentPatrolPanel` | 从 Admin 卡片搬到档案；API 不变 |
| T4 观察终端 | 档案主按钮，Computer 行上不放 |
| Computer 设计 §1.5「创建入口贴在我的计算机」 | 补齐删除，成为完整生命周期面 |
| 成员档案 §6.3「Settings 深链 Admin」 | **本文件取代**：owner 在档案内嵌编辑 |

---

## 8. 分期

### Step A — 收口入口（建议先做）

- Computer：创建改成完整表单（身份 + runtime / model 必选）；列表补删除
- 档案：内嵌编辑 + 挂巡检 + Danger 删除自身；改掉 `goEdit` 深链
- People / Admin / Onboarding / 其它链：不再指向 `/admin/agents` 作为主入口
- `/admin/agents` redirect

验收：不打开 Admin 也能完成「连机 → 填齐资料创建 → 改设定 / 巡检 → 在档案或本机列表删除」。

### Step B — 拆页

- 抽 `CreateAgentModal`（Computer 用）、`AgentEditFields`（档案用）
- 删 `AgentManagement.vue`
- Admin 概览去掉 Agent 管理卡（剩三卡）
- `OrgMembersPanel` 搬家

### Step C — 体验（可后做）

- 档案 Settings / 巡检用轻量分段，有数据再露
- Computer 列表 `?highlight=`
- 不在本期做 Raft 7 Tab、启动/重启主按钮

---

## 9. 验收

1. 新建 Agent 只能从「我的计算机」完成，且必须选定 runtime / model、填名称与显示名；未连机 / 未装可用 runtime 仍拦住。
2. 删除：本机列表可以删；该 Agent 档案（owner）也可以删自身。两处同一确认文案。删光后才能删机。
3. 改名、改角色设定、改模型、配巡检、开观察：只在该 Agent 档案，owner 可写。
4. `/admin/agents` 书签落到计算机或该成员，不再出现第三套 CRUD。
5. 别人的 Agent：档案只读（无编辑 / 巡检写 / 删除）；计算机页看不到别人的创建/删除。

---

## 10. 涉及文件（实施时）

| 文件 | 动作 |
|------|------|
| `packages/web/src/pages/ComputerView.vue` | 创建改完整表单（runtime/model 必选）；列表删除 |
| `packages/web/src/components/people/MemberProfileBody.vue` | 内嵌编辑；挂巡检；Danger 删除自身 |
| `packages/web/src/components/admin/AgentPatrolPanel.vue` | 从 Admin 卡片改为档案嵌入（组件可不动） |
| `packages/web/src/pages/PeopleView.vue` | 「管理」菜单去掉「管理 Agent」 |
| `packages/web/src/pages/admin/AdminPanel.vue` | 去掉 Agent Tab |
| `packages/web/src/pages/admin/AgentManagement.vue` | Step B 删除 |
| `packages/web/src/router/index.ts` | `/admin/agents` redirect |
| `packages/web/src/components/admin/OrgMembersPanel.vue` | 搬家 |
| `packages/web/src/components/OnboardingChecklist.vue` 等深链 | 改指向 |

不改 server 路由语义；若档案编辑需要 `id`，用现 `GET /api/people/:handle` 的 `id` + `ownedByMe`。

---

## 11. 请拍板

**Q1. 档案能不能删除自身？** — **已拍板：能。** owner 在档案 Danger 直接确认并 DELETE，成功后关档案。计算机列表仍保留删除（清办公室 / 才能删机）。

**Q2. `OrgMembersPanel` 去哪？**

- A（推荐）：`/admin/members`（工作区成员页，和「谁在我的空间」一类）。
- B：Computer 页底部。
- C：先藏起来，P1 再做「可见性」。

**Q3. 创建成功要不要自动打开档案？**

- A（推荐）：不自动开；列表刷新 + 一句说明。用户要点再点。
- B：创建成功 `openProfile`，方便立刻改设定/巡检。

未标的按推荐做。
