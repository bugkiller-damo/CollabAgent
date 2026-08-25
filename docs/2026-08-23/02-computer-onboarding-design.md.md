# Slock 接入优化：Computer 一等公民（对标 Raft 功能，不抄 UI）

> 日期：2026-08-23
> 状态：P0 已落地（2026-08-23）。审查拍板见 §11。连接命令现阶段以 `pnpm --filter @collabagent/daemon` 为主（包未发 npm）。`/connect` 重定向到 `/computers`，ConnectWizard 已删除。
> 相对 v2：**纠正「远程机器」含义**。不是同一账号 SSH 挂第二台机；是 **另一位用户在自己的电脑上把 Agent 接到同一 Server，再在频道里和人对聊 / agent 对聊**。v2 里「一用户多 Computer / 连接键改 computerId / SSH 认领」整段撤回。
> 相对 v1：仍要对齐 Raft 的 **Computer / Runtime / Agent** 产品拆分，以及多 Agent CLI 的能力地图；但骨架按 **一人一机（当前）+ 多人各带自己的机进同一 Server（未来已由 user_id 支撑）** 来长，不按「单用户机群」来长。
> 范围：接入漏斗 + 本机资产面 + runtime 探测/选择。**不改** 派发、成本、巡检、分诊语义。
> 后续 IA：增删 Agent 收口到本页、配置/巡检收口到成员档案，见 `04-admin-agent-ia-split.md`（规划，未实施）。
> 视觉：不仿 Raft brutal 黄/硬阴影。沿用灰蓝 Tailwind。
> 依据：Raft Computer 详情 dump + docs.raft.build；Slock `ConnectWizard` / `daemonClients` / `probe.ts` / `command-presets.ts`；侧栏 `01-web-two-column-sidebar-design.md`；成员档案 `01-member-profile-design.md`。

审查通过后再拆实施。

---

## 0. 先校正名词（v3 最重要的一段）

| 说法 | 是 | 不是 |
|------|----|------|
| **远程（用户原话）** | 未来：用户 B 在 **B 自己的电脑** 上跑连接器、创建属于 B 的 Agent，加入同一个 Server，在频道里和 A / A 的 Agent 通信 | 用户 A 把自己的云主机 / 另一台笔记本挂到 A 的账号下 |
| **本机** | 当前登录用户正在用来跑 daemon 的那一台电脑 | 工作区里所有人的电脑总和 |
| **Computer** | 「某位成员的办公室」——一台真机 + 其上的 CLI + 挂在这台上的 Agent | 机群、跳板、SSH 目标 |

多人协作在 **数据模型上已经成立**：

- Agent 有 `user_id`（owner）
- daemon WS 按 `userId` 登记（`daemonClients`）
- 投递 `sendToDaemon(ownerUserId, …)`，注释写明「不要广播，否则别人的 daemon 会误注册」
- 频道里人 / 各家 Agent 本来就能互相说话

缺的是 **产品对象**：B 没有「我的计算机」页，只有一份账号级 token + `/connect` 向导；A 也看不见「这是 B 机器上的同事」，只看见一个 Agent 绿点。

**P0 不需要一用户多机，也不需要把连接键改成 computerId。** 一人一槽（`Map<userId, WS>`）正好对应「每位成员自己的电脑」。未来真要一人多机，再拆键；那是另一条需求。

---

## 1. Raft 设计思路（只借功能）

### 1.1 对象模型

| 对象 | 是什么 | 不负责什么 |
|------|--------|------------|
| Server | 大家说话的房间 | 不跑模型 |
| Computer | 某成员的一台真机。「Agent 的办公室」 | 不是成员，不发消息 |
| 连接器（daemon） | 那台上的常驻进程：保活、启停 Agent、上报探测 | 不是 Agent 身份 |
| Agent | Server **成员**。挂在某台 Computer（= 某位 owner 的机）上跑 | 停进程 ≠ 删身份 |
| Runtime | 该机已装的 Agent CLI | 不是 Computer，不是成员 |

关系： **Server = 房间；Computer = 这位同事的办公室；Runtime = 脑子；Agent = 有名字的同事。**

Slock 映射：办公室的主人 = `users` 行。B 连上 = B 的 `userId` 在 `daemonClients` 里有一条 WS。B 的 Agent 的 `user_id = B`。A 不会、也不该替 B 跑进程。

硬约束（Raft 仍成立，口径换成「每位成员」）：

- 没有在线 Computer，这位成员的 Agent 无处执行。
- 一台 Computer 挂多个 Agent（同一人多个专家）。
- Computer 离线 → **这人的** Agent 全灰；别人的不受影响（现网已是这个语义）。
- 删 Computer 必须先清空这台上的 Agent。

本 dump：一人一机（`灵耀14air`）+ 5 个 Claude Code Agent。这就是我们要对齐的主场景，不是一人两机。

### 1.2 Computer 详情 IA

```
[页头] 显示器图标 + 显示名
[身份] 大图标 | 名
              | ● 在线/离线     ← 这台机 / 这位成员的连接器
              | hostname 弱行
[字段] 名称 ✎ / 描述 ✎
[信息] OS · 连接器版本 · 检测到的运行时芯片 · 创建时间
[接入] 未连：copy-paste 启动命令
[逃生] 密钥不回放，点一下轮换
[Agent] 「这台计算机上的 Agent · N」  [创建]
        行：头像 · 名 · Runtime · presence
[危险] 删除计算机 — 必须先删光 Agent
```

Presence 分层：Computer 连上/没连上；Agent 闲/忙/错在档案里；机离线不装假忙闲。

**别人的 Computer（未来协作面）**：只读摘要（名、在线、Agent 数），不能看别人的连接命令、不能轮换别人的钥。P0 可以不做「工作区全部计算机」列表——People / 档案已经能看到别人的 Agent。P1 再在 Computers pane 加「工作区」分段也不迟。

### 1.3 漏斗（每位成员各走一遍）

```
登录 Server
  → 添加 / 打开「我的计算机」（没有则创建一条属于我的 Computer 记录）
  → 复制命令，在 **我这台电脑** 的终端粘贴
  → 连接器 ready（hostname / os / CLI 探测）
  → 绿点
  → 无可用 runtime 则拦住创建
  → 在这台上创建 Agent
  → 进频道 @ 别人 / 被别人 @
```

用户 B 做完全相同的事，用的是 **B 的账号、B 的 token、B 的电脑**。不需要 A 发一条「远程安装」命令，也不需要 `--computer` 让 A 的第二台机认领。

原则：**网页生成命令；执行权留在「要跑 Agent 的那台电脑」= 当前这个用户自己的机器。**

### 1.4 Runtime 探测

能力地图：已装 / 未装 / 已装但平台未接线。未装也列出（教学）。创建 picker 只收「已装且已接线」。

Slock 目录跟自己的接线走（§4），不要抄 Raft 十引擎。

### 1.5 可迁移原则

1. 先有办公室，再有同事。创建入口贴在「我的计算机」上。
2. 对外说「计算机」，daemon 留在高级文案。
3. 网页出命令，用户自己的机器执行。
4. 旧密钥只轮换、不回放。
5. 能力可见，不可用也可看见。
6. 身份轻编辑，破坏重确认。
7. Presence 分层：机 ≠ 人 ≠ Agent 进程。
8. 一台机多个专家（多 CLI / 多 Agent）。
9. Computer = 运维对象，Agent = 协作对象。别人进房间看见的是 Agent，不是你的安装命令。
10. **多人 = 多人各有一间办公室**，不是一人多间办公室。

---

## 2. Slock 现状

| 今天 | 对「多人各自接入」 | 对「多 CLI / 产品面」 |
|------|-------------------|----------------------|
| `daemonClients: Map<userId, WS>` 一人一槽 | **正确**，请保留 | — |
| `sendToDaemon(ownerUserId)` | **正确**，B 的 Agent 进 B 的进程 | — |
| `machine_tokens` 绑 user+org | **正确**（B 自己的钥） | 没有「这台机」产品对象，轮换散落 |
| `agents.user_id` | **正确**（谁的同事） | 没有「跑在哪台」的展示名 |
| `isOnline = daemonClients.has(user_id)` | 语义是「主人的连接器在」≈ Computer 在线 | 向导用它冒充「Agent 进程已起」是错的 |
| `/connect` + `pnpm --filter … dev` | B 在自己电脑上也能跑，但命令是开发者向 | 不像产品 |
| `probeClaude()` 只打日志 | B 没装 Claude 时 A 只看到「离线/在线」含混 | Web 无能力地图 |
| `command-presets` 已有 4 CLI | — | 接线雏形在，UI 写死 Claude |
| Rail 无 Computers | 接入藏在菜单，B 找不到「我的机」 | — |

一句话：协作投递模型已经是「每人自己的机 + 自己的 Agent」；缺的是把「我的机」做成和 Raft 一样能看、能诊、能选 CLI 的对象。

---

## 3. 目标与非目标

**做：**

1. **Computer 产品对象**（P0 即可落库一行 / 或与 user 1:1）：名称、描述、OS、版本、探测、在线、轮换命令、这台上的 Agent、删除门槛。
2. **漏斗**：连我的计算机 → 看见探测 → 在这台上创建 Agent → 进频道。
3. **多 CLI**：能力地图 + 创建时 Runtime picker（只列已接线的）。
4. Presence 分层：计算机连上 ≠ Agent 空闲 ≠ 工作中。
5. 产品语言：对外「计算机」；入口从「接入 Agent」改过来。
6. 连接命令改成可给非仓库用户复制的 daemon 启动命令（B 不需要 clone slock monorepo）。

**明确不做（含 v2 撤回）：**

- 同一用户挂多台 Computer / SSH 到「远程机」跑第二条 daemon。
- 把 `daemonClients` 键改成 `computerId`（P0）。一人一槽保持。
- `--computer <uuid>` 必填启动参数（P0）。token 已能识别是谁。
- 平台代装、device-login（P2）。
- Raft 十引擎目录、Raft 皮肤。
- 改派发 / 成本 / 巡检 / 分诊。
- 让 A 看到 B 的 API 密钥或连接命令。
- Agent 跨用户 / 跨机热迁移。

**P1 才考虑：** 工作区「其他人的计算机」只读列表；Agent 档案上「跑在 {name}」。

**更远（一人多机）才考虑：** `computer_id` 进 token / Agent、连接键拆分。不要预支。

---

## 4. 对象模型

```
Server
  └── Member (User)
        └── Computer     P0：与 User 1:1（「我的计算机」）
              ├── Token*   已有 machine_tokens（user_id + server_id）
              ├── Probe    ready 上报，内存即可
              └── Agent*   已有 agents.user_id
```

### 4.1 表（P0 最小）

两种都合法，拍板见 §11。推荐 **落一行 `computers`，仍按 user_id 连接**：

```
computers (
  id              uuid pk,
  user_id         uuid not null unique,   -- P0 一人一行
  server_id       uuid not null,
  name            text not null,
  description     text not null default '',
  hostname        text,
  os              text,
  arch            text,
  daemon_version  text,
  last_ready_at   timestamptz,
  created_at      timestamptz not null default now()
)
```

- 不改 `daemonClients` 键。
- 不给 `machine_tokens` / `agents` 加 `computer_id`（P0）。归属继续用 `user_id`。
- 首次打开「计算机」或首次成功 `ready`：没有行就按 hostname 插一条。
- `user_id unique` 把「一用户多机」从库层挡住，避免 v2 那种预支。

若审查嫌 migration 重：P0 可以不建表，详情全吃 `daemonMeta` + 名称暂存 `users` 扩展字段；P1 再落 `computers`。功能 IA 不变。

### 4.2 运行时目录

来源：`command-presets.ts`。

| id | 展示名 | P0 探测 | P0 spawn | 芯片 |
|----|--------|---------|----------|------|
| `claude` | Claude Code | 已有 `probeClaude()` | 已接线 | installed / not_installed |
| `codex` | Codex CLI | 新增 `probeBinary` | 未接线 | installed_unsupported / not_installed |
| `gemini` | Gemini CLI | 同上 | 未接线 | 同上 |
| `opencode` | OpenCode | 同上 | 未接线 | 同上 |

地图四格都画。创建 picker **只允许已接线且 installed**（P0 = Claude）。已装未接线写「已检测到，运行时尚未接入」。某 CLI spawn 接线完成后推进 picker，不改 IA。

离线：显示上次 ready 缓存，标注快照。

### 4.3 在线与投递（保持现网）

```
Computer.online  = daemonClients.has(ownerUserId)
Agent.isOnline   = 主人 Computer.online     // 「办公室亮灯」
Agent 五态       = agent:status             // 闲/忙
deliver          = sendToDaemon(ownerUserId)
```

B 断线只灰 B 的 Agent。不要改这条。

向导 / 创建后的「上线」**不要**用 `isOnline` 宣布进程已起；等五态或超时说「已创建，被 @ 时才会拉起」。

---

## 5. 信息架构

### 5.1 Rail

在成员和设置之间加 **计算机**。P0 列表通常 0～1 条（我的）。有机则绿/灰点。

```
🔍 搜索
💬 聊天
⚡ 动态
✅ 任务
👥 成员
💻 计算机      ← 我的办公室；不是机群控制台
⚙ 设置
```

Pane：

```
计算机
  灵耀14air     ● 在线     ← 只有我的
  （空态 CTA：连接我的计算机）
```

P0 **不在 pane 列出同事的机**。同事的 Agent 在成员 pane。避免和「工作区机群」混淆。

点行 → `/computers` 或 `/computers/:id`。无 id 时一人一行可直接进唯一详情。

实施回写 `01-web-two-column-sidebar-design.md`、`SidebarPane`、`SidebarRail.vue`。

### 5.2 路由

| 路径 | 页 |
|------|----|
| `/computers` | 我的计算机详情（一人一行时可无 :id） |
| `/computers/:id` | 同上；若 id 不是我的 → 403 或只读摘要（P0 直接 403） |
| `/connect` | 重定向到 `/computers` |

### 5.3 详情（灰蓝，IA 对齐 §1.2）

未连接：身份灰点 + 「在这台电脑的终端运行」+ 复制命令 + 轮换。
已连接：OS / 版本 / 四格 runtime / Agent 列表 + 创建 / 危险区。

创建对话框：Name、Description、Runtime（P0 = Claude）。

Agent 行打开已有 `MemberProfileDrawer`。

### 5.4 其它入口

| 现在 | 改成 |
|------|------|
| UserMenu「接入 Agent」 | 「计算机」 |
| Onboarding「连接本机 Claude」 | 「连接我的计算机」；Claude 未装不算完成 |
| People 底链 | 「我的计算机」 |
| `/admin/agents` | 创建仍算挂在我的机上；提示先连接 |
| `/settings/integrations` | 仍管全部 token；日常轮换走计算机页 |
| `/admin/metrics` | 运维向，可点 hostname（仍是各 user 的 daemon） |

---

## 6. 连接协议

### 6.1 命令

默认：

```
npx --yes @collabagent/daemon --server-url <origin> --api-key <sk_machine_…>
```

或已有 bin：`collabagent-daemon --server-url … --api-key …`

开发折叠：`pnpm --filter @collabagent/daemon dev -- --server-url … --api-key …`

**不要** `--computer`。B 用自己账号在计算机页生成自己的钥即可。

文案：「在你要跑 Agent 的这台电脑上执行（就是你正在用的这台，不是别人的机器）。」

### 6.2 ready（仍按 user 登记）

```
type: "ready"
hostname, os, arch
daemonVersion: 从 package.json 读，禁止写死 0.1.0
runtimes: [
  { id: "claude", status: "installed", version: "…" },
  { id: "codex", status: "not_installed" },
  …
]
```

`DaemonMeta` 仍键 userId，补 os/arch/结构化 runtimes。

`GET /api/daemon/status` 扩成详情（或 `GET /api/computers/me`）：

```
{ connected, hostname, os, arch, daemonVersion, runtimes, connectedAt, computer? }
```

### 6.3 握手

保持现网：`sk_machine_*` → userId → `daemonClients.set(userId, ws)`。同用户新连接覆盖旧连接（一人一机，重连合法）。

### 6.4 轮换

计算机页「生成连接命令」：签发新钥 + **吊销该用户当前 machine token**（P0 一人一机，吊销 active 即可）。明文一次。文案写清会断开现有 daemon。

集成设置若还要给 CI 留一把「不随计算机页轮换」的命名钥——P1；P0 不必。

---

## 7. Agent 生命周期

```
我打开计算机页 → 本机跑连接器 → ready / 探测
  → 创建 Agent（user_id = 我）
  → sendToDaemon(我, agent:start)
  → @ / DM / 巡检 才 spawn
我离线 → 我的 Agent 全灰；频道里别人的 Agent 照常
删 Agent → 去身份；消息留
删计算机 → 先清空我的 Agent（P0 = 清空我名下全部 Agent）
```

公开频道 @ 自动入圈保持。B 的 Agent 被 A @ 到公开频道，走现有 deliver → B 的 daemon。

---

## 8. API 草图

```
GET    /api/computers/me          我的计算机 + online + probe（没有则 404 / 空对象）
POST   /api/computers             确保我有一行（幂等）
PATCH  /api/computers/me          { name?, description? }
DELETE /api/computers/me          409 若我还有 agent
POST   /api/computers/me/token    轮换；{ token, command }

GET    /api/daemon/status         兼容扩字段，或薄封装上面这条

POST   /api/agents                不变（user_id = 调用者）；runtime 校验对照我机探测
GET    /api/agents?mine=1         不变，daemon 只拉自己的
```

不把 computerId 打进 daemon 启动参数和 WS 键。

---

## 9. 分期

### P0 · 我的计算机工作台 + 多 CLI 地图

- [x] `computers` 表，`user_id unique`（014_computers.sql）
- [x] **不改** `daemonClients` 键
- [x] daemon `ready`：真实 version / os / arch / 四 CLI 探测
- [x] status / computers/me API
- [x] `/computers` 详情；`/connect` 重定向；ConnectWizard 已删
- [x] Rail「计算机」（只有我的）
- [x] 命令现阶段仍是 pnpm-filter（包未发 npm，用户拍板）；轮换在本页
- [x] 创建 picker 仅 Claude；地图四格诚实标注
- [x] Onboarding：未装 Claude 不勾完成；上线不冒充进程
- [x] UserMenu / People 改文案

验收：

1. A 连接自己的机，看见 hostname + Claude 芯片，能创建 Agent，频道里可 @。
2. **B 用 B 的账号**在 B 的浏览器走同一套漏斗（另一台电脑或另一用户），B 的 Agent 出现在同一 Server；A 的 daemon 不被踢。
3. B 没装 Claude 时，B 的 Web 写明「已连上计算机，但 Claude 未装，@ 不会响应」；A 侧看到 B 的 Agent 仍是「主人未就绪 / 离线」一类诚实状态。
4. A 断线只灰 A 的 Agent。

（不再要求「同一用户两个 `--computer` 并存」。）

### P1

- Agent 档案「跑在 {我的计算机名}」
- 工作区只读：同事的计算机名 / 在线（可选）
- 连接器「有更新」
- `probeBinary` 通用化
- 侧栏文档回写

### P2

- Codex / Gemini / OpenCode 真正 spawn → 推进 picker
- 安装脚本 / 服务保活
- **仅当产品真要「一人两台机」时** 再拆 `computer_id` 连接键

---

## 10. 关键文件

| 层 | 文件 |
|----|------|
| Web | `ComputerView` + `ComputersPane`；改 `router`、`SidebarRail`、`uiStore`、`OnboardingChecklist`、`UserMenu`、`PeoplePane`、`AgentManagement`；ConnectWizard 已删 |
| Server | 可选 `routes/computers.ts`；`index.ts` status；`ws/handler.ts` 只扩 DaemonMeta；`profile.ts` 轮换 |
| Shared | ready 载荷 |
| Daemon | `daemon-core.ts` ready、`probe.ts`、`index.ts` 启动说明 |
| 文档 | 本文；侧栏设计 |

---

## 11. 拍板（v3）

| # | 问题 | 决定 |
|---|------|------|
| 1 | 「远程」是什么 | **另一位用户在自己电脑上接入同一 Server**。不是一用户多机 |
| 2 | P0 连接键 | **保持 userId** |
| 3 | 是否建 `computers` 表 | **建，user_id unique** |
| 4 | `--computer` | **P0 不要** |
| 5 | Rail 计算机 | **加，只列出我的** |
| 6 | 路由 | `/computers`；`/connect` 重定向 |
| 7 | Runtime | 四格地图；picker 仅已接线（P0 = Claude） |
| 8 | Token | 仍绑 user；本页轮换吊销该用户 active 钥 |
| 9 | 视觉 | 灰蓝 |
| 10 | 创建后 spawn | lazy；诚实文案 |

v2 作废的验收：「同一账号两台 Computer 互不踢」。v3 验收改成：「两个用户各连各的机，同 Server 聊天，互不踢。」
