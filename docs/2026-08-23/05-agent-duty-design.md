# Agent 值班（Duty）：人工控制在线 / 离线

> 日期：2026-08-23
> 状态：Step A+B 已落地（2026-08-23）。审查拍板默认 Q1-A / Q2-A / Q3-A。
> 范围：`packages/server` + `packages/daemon` + `packages/web` + `packages/shared` + CLI
> 依据：现状盘点（daemon 启动即全员绿点）；Computer `02-computer-onboarding-design.md.md`；成员档案 `01-member-profile-design.md` + `03-member-page-raft-gap-report.md` Q3；IA 拆分 `04-admin-agent-ia-split.md`；T2 巡检 / T8 分诊
> 视觉：不仿 Raft UI。沿用现有灰蓝 Tailwind。

审查拍板默认 Q1-A / Q2-A / Q3-A 已按此实施。

---

## 0. 一句话

**值班是成员意愿，进程是办公室执行。** 人类可以让某个 Agent 停班并仍保留身份；daemon 连上只表示办公室开门，不表示里面每个同事都在值班。

停班 ≠ 删人，关进程 ≠ 离线，计算机掉线 ≠ 主动停班。

---

## 1. 为什么现在全是绿点

协作面的 `isOnline` 绑的是 **owner 的 daemon 是否在 `daemonClients`**：

```
isOnline = daemonClients.has(agent.user_id)
```

一台机挂 5 个 Agent，daemon 一连，5 个全绿。这和 Computer 文档已经写过的分层相反：

> Presence 分层：Computer 连上/没连上；Agent 闲/忙/错在档案里；机离线不装假忙闲。

现状把三层压成一层：

| 层 | 本应表达 | 今天实际 |
|----|----------|----------|
| 计算机 | 办公室开门没有 | daemon WS 在不在（唯一真值） |
| 值班 | 这个同事接不接活 | **不存在** |
| 运行时 | 脑子在不在转 | 五态只在本机，UI 常常被 `isOnline` 盖掉 |

运行时里其实有五态（`uninit / idle / starting / working / stopped`）和 `stopAgent()`，但：

- `loadExistingAgents` 把 `mine=1` 的 **全部** agent 标 `idle`，不过滤任何库字段；
- `stopAgent` 只杀进程，不注销、不拦下一条 @；
- WS `agent:stop` 只在 **DELETE** 时发，等于卸掉身份；
- `agents.status` 默认 `active`，`PATCH` 能写，**daemon 不读、列表不过滤、前端无开关**。

所以用户要的「这个人先别干活」今天做不到，只能关整台 daemon 或删掉 agent。

---

## 2. 目标与非目标

**做：**

1. 每个 Agent 有一份 **持久化的值班意愿**（`on` / `off`），owner 可改，重启 / 重连不丢。
2. 展示拆成三层，任何一面（People / 档案 / Computer / @ 候选 / 顶栏）用同一套合成函数，禁止再把 `daemonClients.has(owner)` 直接当 agent 在线。
3. 停班 fail-closed：@、DM、分诊、巡检、经理派单、daemon 本地 `hasAgent` **全部不唤醒**。消息本身仍落库（人说的话不丢）。
4. 值班打开 = **有资格被唤醒**，不 eager spawn（保持 lazy + session resume）。
5. 入口落在 **计算机页（主）+ 该 Agent 档案 owner 区（次）**，与 04 的对象职责一致。
6. 变更进审计链，浏览器经 WS 即时刷新，不必重载页面。

**不做：**

- 把 Raft 的「启动 / 重启 / 重置」做成档案主按钮（`03` Q3-A 对 **进程启停** 的否决仍然成立，见 §3）。
- 真人 presence 协议、last-seen 精确到分钟。
- 一人多机、按 computerId 改连接键。
- 日程排班、时区自动上下班、按频道分别值班（P2）。
- 用关 daemon / 删 agent 冒充停班。
- 停班期间把 @ 悄悄改投给别人。
- 改成本记账键、巡检 cron 语法、分诊三选一 prompt。

---

## 3. 与既有拍板的关系（必须先说清）

`03` Q3-A / `04`「档案不做启动/重启主按钮」否决的是：

> 点一下就 **拉起 Claude 进程**（Raft 桌面顶栏那套运维动作）。

值班开关 **不是** 那个按钮：

| | 被否决的「启动 Agent」 | 本期「值班」 |
|--|------------------------|--------------|
| 对象 | 进程 | 接活意愿 |
| 默认 | 点了才跑 | 创建即值班；停班是例外 |
| 关 | 杀进程，下一条 @ 仍会再拉 | 身份还在，任何唤醒源都不投 |
| 入口 | 档案主 CTA | 计算机行内开关；档案 owner 次要操作 |

**修订**：Q3-A 继续禁止「启动/重启进程」主按钮。档案 **允许** owner 看到「值班 / 停班」开关（次要、危险区上方，不是头图主 CTA）。Computer 文档「Agent 闲/忙/错在档案里」补一句：闲/忙之前先看值班。

---

## 4. 三层模型

```
Computer.connected     办公室门
Agent.duty             这个同事今天来不来
Runtime (五态)         来了之后脑子在不在转
```

合成（唯一允许的产品口径，server / web / daemon 上报共用语义）：

```
function composePresence(duty, computerOnline, runtime?): Presence {
  if (duty === "off") return "off_duty";          // 主动停班，压过一切
  if (!computerOnline) return "computer_offline"; // 办公室关门
  if (runtime === "working" || runtime === "starting") return runtime;
  if (runtime === "stopped") return "idle";       // 进程回收 ≠ 离线
  return "idle";                                  // 值班中、门开着、等活
}
```

展示文案（灰蓝，不造新色体系）：

| Presence | 文案 | 点颜色 |
|----------|------|--------|
| `working` | 工作中 | 蓝 |
| `starting` | 启动中 | 琥珀 |
| `idle` | 空闲 | 绿 |
| `off_duty` | 停班 | 灰 |
| `computer_offline` | 计算机离线 | 灰（与停班区分用文案，不用第二套绿点） |

人类成员继续：不做假绿点（`01` 已拍板）。

`runtime === stopped` 对值班中的 agent **不得** 显示「已停止」。idle-reclaimer 回收进程是省钱，不是下班。UI 上的「已停止」只留给 `off_duty`。

---

## 5. 数据模型

### 5.1 为什么不复用 `agents.status`

列还在，默认 `'active'`，几乎没人读。若直接改成值班枚举：

- 和运行时五态、频道成员心理模型撞名；
- 现有 `PATCH /api/agents/:id`（`agents.ts`）还能写 `status`，且误把 `runtime`/`model` 当成顶层列（schema 里是 `runtime_profile`）——这条路由本身是半残的；
- 将来若要做软删除 / 归档，`status=active|archived` 才是它该干的活。

**本期加专用列，不动 `status` 的生命周期含义。**

### 5.2 Migration `015_agent_duty.sql`

```sql
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS duty varchar(8) NOT NULL DEFAULT 'on';

ALTER TABLE agents
  DROP CONSTRAINT IF EXISTS agents_duty_check;
ALTER TABLE agents
  ADD CONSTRAINT agents_duty_check CHECK (duty IN ('on', 'off'));

CREATE INDEX IF NOT EXISTS idx_agents_duty ON agents (user_id, duty);

COMMENT ON COLUMN agents.duty IS 'Desired availability: on = eligible to wake; off = human off-duty';
```

- 存量行 → `on`（行为与今天一致：daemon 连上即可被唤醒）。
- 新建默认 `on`。
- `canonical_schema` / drizzle `schema.ts` 同步加列。
- **不**给 `computers` 加 duty；办公室只有连/断。

### 5.3 字段职责

| 字段 | 谁写 | 谁读 | 含义 |
|------|------|------|------|
| `agents.duty` | owner 经 POST duty | 所有唤醒路径、列表、档案 | 意愿 |
| `agents.status` | 本期不写 | 本期不当 presence | 预留归档 |
| `daemonClients` | WS 握手 | Computer.online、合成函数的 `computerOnline` | 门开没开 |
| runtime 五态 | daemon 内存 | `agent:status` → `agentStore` | 忙闲 |
| `idle-reclaimer` | daemon | 不进产品文案 | 省进程 |

---

## 6. 协议

### 6.1 不要复用 `agent:stop`

今天 `agent:stop` = 删除后的注销。若停班也发它，daemon 无法区分「人没了」和「人请假」，重连后再 `loadExistingAgents` 还会把还活着的行注册回来——除非过滤 duty，但删除路径会变模糊。

**新消息，旧消息职责收窄。**

### 6.2 server → daemon（补进 `WsToDaemonMessage`）

```ts
| { type: "agent:duty"; agentId: UUID; name: string; duty: "on" | "off" }
```

daemon：

| 收到 | 行为 |
|------|------|
| `duty: "off"` | `unregisterAgent(name)`：杀 PTY / PersistentClaude、清 session 跟踪、`hasAgent=false`、五态 `stopped`。进行中的回合中止，不续跑。 |
| `duty: "on"` | `registerAgent(...)`（与创建/PATCH 相同的合并语义），标 `idle`，**不 spawn**。 |
| 重连 / `loadExistingAgents` | `GET /api/agents?mine=1` 只 `register` `duty=on` 的行；`duty=off` 的名字不得出现在 `agentDrivers`。 |

`agent:start` 仍只用于创建 / 改资料 / 改 runtime。若某次 PATCH 时该行已是 `off`，**禁止**再发 `agent:start`（否则会把停班的人重新注册）。`agent:stop` 仍只用于 DELETE。

### 6.3 daemon → server → browser

现有 `agent:status` 继续报运行时忙闲。补一条意愿广播，避免列表靠轮询：

```ts
| {
    type: "agent:presence";
    agentId: UUID;
    agentName: string;
    duty: "on" | "off";
    computerOnline: boolean;
    presence: "idle" | "starting" | "working" | "off_duty" | "computer_offline";
  }
```

- duty 变更：server 在写库成功后向该 agent 所在 server 的在线浏览器广播（不必进频道 fan-out；People / Computer / 档案都要听到 → **按 org/server 广播**，或复用现有 user 级推送）。
- daemon 连上 / 断开：对 **该 owner 名下 duty=on 的 agent** 重算 `computer_offline ↔ idle`，同一条 `agent:presence`。
- 运行时 starting/working/idle：仍走 `agent:status`；web 合成时 duty/computer 优先。

若觉得多一条事件太重：允许 web 只听 `agent:presence`（duty 变更 + daemon 上下线），`agent:status` 只覆盖 working/starting。文档实施时二选一，**推荐两条都留**，合成函数在客户端，避免 server 为每个 keystroke 重算。

### 6.4 REST

**唯一写入口**（不要再往半残的 `PATCH agents.ts` 塞）：

```
POST /api/agents/:agentId/duty
Authorization: owner（requireOwnAgent）
Body: { "duty": "on" | "off" }
→ 200 { id, name, duty, presence, computerOnline }
  400 非法枚举
  403 非 owner
  404 无此 agent
  409 已是目标态（可选；推荐幂等 200，方便 UI 连点）
```

写路径：

1. `UPDATE agents SET duty=$1, updated_at=now() WHERE id=$2`（幂等）；
2. `appendEvent`：`verb=agent.duty_on | agent.duty_off`，`object_type=agent`；
3. `sendToDaemon(owner, { type: "agent:duty", ... })`——daemon 不在就只改库，下次 `loadExistingAgents` 对齐；
4. 广播 `agent:presence`。

读路径：所有返回 agent 的接口带上 `duty` + **合成后的** `presence`（或同时给 `isOnline` 但标 `@deprecated`，值改为 `presence === "idle"|"starting"|"working"`，避免旧 UI 把停班画成绿）。

至少改：

- `GET /api/agents`、`GET /api/agents?mine=1`
- `GET /api/agents/channel/:id`
- `GET /api/people/:handle`（`PersonProfile`）
- Computer 页用的同一份 `/api/agents`

`GET /api/agents?mine=1`：**必须返回 off 的行**（daemon 要知道别注册谁）。过滤发生在 daemon 注册，不是发生在 API 隐瞒。

---

## 7. 唤醒漏斗（fail-closed）

原则：**server 是闸门，daemon 是第二道闸。** 只改一边会漏。

```
消息 / 巡检 / 派单
        │
        ▼
 server: 候选人 ∩ duty=on ∩ （频道成员规则仍有效）
        │  空 → 不投递、不 spawn；人类消息照常落库
        ▼
 sendToDaemon(owner)
        │
        ▼
 daemon: hasAgent(name)？  // 只有 duty=on 才会在表里
        │  否 → 忽略
        ▼
 A1 队列 → lazy spawn
```

### 7.1 @ 提及（`messages.ts`）

现查询：

```sql
SELECT name FROM agents WHERE server_id = $1 OR user_id = $2
-- 私有频道则 JOIN channel_members
```

改为 **候选必须 `duty = 'on'`**。公开频道自动入圈也只对 `duty=on` 的名字 INSERT。

被 @ 但 `duty=off`：

- 消息照发；
- 不进 `mentionAgents`；
- 给发送者一条 **非阻塞** 提示（WS toast 或回执字段 `skippedMentions: [{ handle, reason: "off_duty" }]`）。不要插一条机器人频道消息（吵）。

### 7.2 DM

`dmOtherMembers` / `dmAgentRecipients` 去掉 `duty=off`。对人发起「停班 Agent 的 DM」：会话可打开、历史可看、新消息落库，但 **不唤醒**；composer 上方一条静态提示「对方已停班」。

### 7.3 T8 分诊

`computeTriageAgents` 保持纯函数。查询经理时加 `AND a.duty = 'on'`。

唯一经理停班 → `managerName=null` → 本条不分诊（与「没经理」相同）。**不要**降级到下一个非经理 worker。频道设置里若开关开着但经理停班，UI 提示「经理已停班，分诊暂停」，不自动关开关。

### 7.4 T2 巡检 / reminder

`reminder-scheduler` 认领条件加：owner agent `duty=on`。停班期间到期行 **保持 due、不认领、不累计沉默**（沉默是「值班却划水」，不是「人请假」）。值班打开后下一 tick 再 fire。

与现有 `paused` 的区别：

| | `reminders.paused` | `agents.duty=off` |
|--|--------------------|-------------------|
| 粒度 | 单条巡检 | 整个 Agent |
| 谁设 | 巡检面板 / 空转自动暂停 | 值班开关 |
| 停班时 | 已 paused 的继续 paused | 未 paused 的也不 fire |

### 7.5 经理派单（`agents-dispatch.ts`）

worker `duty=off` → `409 { error: "worker is off duty" }`，不插任务合同、不 `forceDeliverTo`。

### 7.6 daemon 本地

即使 server 漏网，`hasAgent` 为 false 就不会 `runAgent` / `runAgentTriage` / `runAgentDm`。`agent:deliver` 现逻辑已是「不在表里就跳过」。

A1 忙碌合并：停班时人已不在表里，队列里未完成的项随 `unregisterAgent` **丢弃并走死信回调**（已有 `onDeliveryDeadLetter`），toast 文案改为「对方已停班，消息未投递」。不要在停班后再排一次。

成本熔断（D3）不改；停班的人不会进 `dispatchToAgent`。

---

## 8. 产品面

### 8.1 对象职责（接 04）

```
计算机（办公室）                      成员（同事）
  门开 / 门关                          档案、@、观察、巡检配置
  创建 / 删除 Agent                    owner：值班开关（次要）
  本机工人名单 + 行内值班开关           只读：合成后的 presence
  文案：「停班后仍是成员，只是不接活」
```

别人的档案 / 别人计算机上的行：**只读状态，无开关**。

### 8.2 Computer 页（主入口）

每行：头像 · 名 · runtime/model · **值班开关** · 合成 presence。

- 计算机离线：开关 disabled，tooltip「先连上这台计算机」。意愿仍显示（停班在关门时也要看得见，避免连上瞬间全员被唤醒——意愿以库为准）。
- 开 → `POST .../duty {on}`；关 → 确认（见 §8.4）。
- 创建成功默认值班，无需第二步。

### 8.3 档案（次入口）

owner、Agent 类型：

- 头图主 CTA 仍是「发消息 / 观察」，**不加**「启动」。
- Overview 身份条用合成 presence。
- 资料区加一块「值班」：开关 + 一句说明 + 链回 `/computers`。
- Danger 仍是删除。值班不要放进 Danger（停班可逆，删除不可逆）。

非 owner：只看到「停班」灰字，无开关。

### 8.4 关值班确认

进行中（`working`/`starting`）时确认框写明：**当前回合会中止，未完成输出不会代发。** 空闲时可用轻确认或直接关（Computer 行内倾向直接关 + toast；档案可同一套）。

### 8.5 People 目录 / 频道成员 / @ 候选

- 列表点：按 `presence`，停班与计算机离线都是灰，靠文字区分。
- @ 候选 **仍列出停班的人**（否则队友不知道这个名字还在），右侧徽章「停班」。选中可插入，发送走 §7.1。
- 频道成员名单不因停班除名。

### 8.6 CLI

```
slock agent duty on  <name>
slock agent duty off <name>
slock agent ls          # 增加 DUTY / PRESENCE 列
```

走同一 REST。给只连着终端的 owner 用，不另做协议。

---

## 9. 关键路径（实施时按此改）

| 层 | 文件 | 改什么 |
|----|------|--------|
| DB | `migrations/015_agent_duty.sql`、`000_canonical_schema.sql`、`schema.ts` | `duty` 列 |
| shared | `index.ts` | `AgentDuty`、`AgentPresence`、`WsToDaemonMessage` 加 `agent:duty`、`WsToBrowserMessage` 加 `agent:presence`；`PersonProfile` 加 `duty` + `presence` |
| server | 新 `routes` 或挂在 `agents-public.ts` | `POST /duty`；列表/档案返回合成字段 |
| server | `messages.ts` | 候选 SQL + `skippedMentions` |
| server | `manager-triage.ts` 调用处 | 经理查询加 duty |
| server | `reminder-scheduler.ts` | 认领加 duty；不计沉默 |
| server | `agents-dispatch.ts` | worker 409 |
| server | `people.ts` | 档案 presence；`isOnline` 废弃或改语义 |
| server | `ws/handler.ts` | 中继 `agent:presence`；daemon 上下线重算该 owner 的 on-duty agent |
| daemon | `daemon-core.ts` | `case "agent:duty"`；`loadExistingAgents` 过滤 |
| daemon | `agent-runtime.ts` | `register`/`unregister` 已够；确认 off 走 unregister 而非只 `stopAgent` |
| web | `ComputerView.vue` | 行内开关 |
| web | `MemberProfileBody.vue` | owner 开关 + 文案 |
| web | `PeopleView.vue`、成员行、`useMentionSuggest` | 用 `presence`，停班徽章 |
| web | `wsDispatch.ts`、`agentStore` | 收 `agent:presence`；合成函数抽到 `lib/presence.ts`（与 server 单测同一套纯函数，放 shared） |
| web | `AgentStatusBar.vue` | 停班不显示「在线」 |
| CLI | `packages/daemon/src/cli.ts` | `agent duty` / `ls` 列 |
| 测试 | server：mention / triage / patrol / dispatch / duty POST；daemon：load 过滤 + duty 消息；shared：`composePresence`；web：store 合成 |

`packages/server/src/routes/agents.ts` 那条会写 `status`/`runtime`/`model` 顶层列的 PATCH：**本期不要接值班**；能删则删，不能删就标 deprecated，避免第三套写入口。

---

## 10. 状态机（意愿 × 门 × 进程）

```
          POST duty=off                         POST duty=on
   ┌──────────────────────────┐         ┌──────────────────────┐
   │                          ▼         │                      │
 任意 ──unregister──► off_duty ◄────────┴── register idle      │
   ▲                      │                                    │
   │                      │ daemon 上线也仍是 off_duty          │
   │                      └────────────────────────────────────┘
   │
   duty=on 且门开：
     idle ──消息──► starting ──result──► working ──回合结束──► idle
                     │                      │
                     └─ 60s 回收进程 ───────┴──► 仍显示 idle（duty 未变）
   duty=on 且门关：
     一律 computer_offline（进程本来也起不来）
```

非法组合在合成函数里消掉，不落库。库只存 `duty`。

---

## 11. 权限、多租户、并发

- 写 duty = `requireOwnAgent`（与删、改 runtime 相同）。频道 admin / 经理不能远程关掉别人家的工人。
- org 成员只读别人的 presence。
- 一人一机：`sendToDaemon(user_id)` 不变。
- 连点：UPDATE 幂等；daemon register 已是合并语义；unregister 对不存在的名字应是 no-op（`unregisterAgent` 已按 name 删 map，补一句容错即可）。
- daemon 在 duty 消息之前就 `loadExistingAgents`：以库为准，off 的不会进表。
- daemon 晚于 duty 消息连上：只靠 load 过滤，不依赖那条 WS 重放。
- 两个标签页同时拨开关：最后一次写入赢，广播以库为准。

---

## 12. 分期

接受较大改动，但仍按可审查切片交，避免「开关画了、巡检还在喊人」。

### Step A — 语义与闸门（先于 UI）

1. migration + shared 类型 + `composePresence` 纯函数（shared，两边单测）。
2. `POST /duty` + 审计 + daemon `agent:duty` + `loadExistingAgents` 过滤。
3. 所有唤醒路径 fail-closed（§7）。
4. 列表/档案 API 返回 `duty`/`presence`；`isOnline` 改语义或删除调用点。

**验收**：用 curl 把一个 agent `duty=off`，daemon 日志不再 `Registered` 它；@ / DM / 分诊 / 巡检 / 派单都不 spawn；`duty=on` 后下一条 @ 才 lazy 拉起。计算机断开时 on-duty 显示 `computer_offline`，off-duty 仍是 `off_duty`。

### Step B — 产品面

1. Computer 行内开关。
2. 档案 owner 开关 + People / @ 徽章。
3. `agent:presence` 广播 + `agentStore`。
4. 进行中关班确认、skipped mention toast。
5. CLI。

**验收**：本机两个 agent，停一个，频道里只有另一个接 @；刷新 / 重启 daemon 意愿还在；另一用户只看得到灰字。

### Step C — 收口与文档

1. 扫掉残留 `isOnline = daemonClients.has(user_id)`（agent 语境）。
2. 修订 `01`/`02`/`03`/`04` 各加一段「值班见 05」，Q3 旁注。
3. CLAUDE.md 索引 + tracker 不把本需求塞进 daemon Step 7（这是产品能力，不是观察帧）。

P2（本文不排期）：按频道值班、排班日历、停班时自动委派、软删除走 `agents.status=archived`。

---

## 13. 风险与故意取舍

| 点 | 选择 | 理由 |
|----|------|------|
| 关班是否等回合结束 | **立即 unregister** | 「别再花钱」比「把这句说完」更符合停班；busy 队列走死信，不暗吞 |
| 停班是否出频道 | **不出** | 身份是同事，不是进程；踢人是另一条权限 |
| @ 停班是否拦截发送 | **不拦截** | 人说话权利在频道，不在工人排班 |
| 经理停班 | **本频道分诊暂停** | 不偷偷换经理，避免权责错位 |
| 进程回收是否显示停止 | **否** | 避免和停班抢文案 |
| eager 开班拉起 | **否** | 延续 2026-07-29 去掉静默恢复回合的决定 |
| 复用 `agents.status` | **否** | 留给归档；值班是正交概念 |

---

## 14. 审查时请盯

1. 有没有新代码又把 `daemonClients.has(owner)` 画成 agent 绿点。
2. `agent:stop` 有没有被停班误用（删除路径会伤身份）。
3. `GET ?mine=1` 若过滤掉 off 行，daemon 重连会 **无法注销** 内存里的旧注册——所以 API 必须返回 off 行，过滤在 register。
4. 巡检沉默计数在停班期间必须冻结。
5. 档案头图不要出现「启动 Agent」。
6. 视觉仍是灰蓝，停班不要做红开关大按钮。

---

## 15. 请拍板（未标按推荐）

**Q1. 关班时正在跑的回合？**

- A（推荐）：立刻中止并死信未投出的队列。
- B：等本回合 `result` 再 unregister（更温柔，停班不即时）。

**Q2. 档案上的开关？**

- A（推荐）：owner 次要开关，主入口仍在 Computer。
- B：档案只读 + 深链「去计算机页改值班」，档案零写操作。

**Q3. 被 @ 的停班 agent？**

- A（推荐）：消息发出 + toast「@x 已停班」。
- B：发送前 modal 拦截，必须去掉 @ 才能发。

未回复则按 A / A / A 实施。
