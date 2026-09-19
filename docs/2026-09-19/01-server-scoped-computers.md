# Server 级计算机模型 —— 计算机跟着 server 走

> 日期：2026-09-19
> 状态：**设计稿定稿**——§6 全部开放问题已确认（2026-09-19），可开工
> 修订：v3——单 scope 修正为「每台机器一个 server」+ daemon `--server` 参数 + `machineKey` 每机一槽注册
> 上游：`docs/2026-09-18/02-server-permission-model.md`（§3 agent 归属：人持有、放进 server）
> 起因：新建 server（如 005）后 /computers 页仍显示「灵耀14air」和其上 agent——计算机是用户级设施。用户构想：计算机信息由 daemon 运行获取、**跟着 server**，新 server 里只有 daemon 跑起来才自动识别并写库；且一用户在一 server 要支持多台计算机。

## 0. 现状实证（代码核查 2026-09-19）

| 维度 | 现状 | 位置 |
|------|------|------|
| 行粒度 | `computers.user_id UNIQUE`——**一人一机一行** | `db/migrations/014_computers.sql` |
| `server_id` | 仅是**注册标签**：`getUserOrgIds()[0]` / `server_members LIMIT 1` 随手落点，无查询按它过滤 | `ensureComputerRow`（computers.ts:50）、`persistComputerReady`（handler.ts:497） |
| 信息来源 | ✅ 已是 daemon 驱动：`ready` 帧 → `persistComputerReady` 写 hostname/os/arch/daemon_version/runtimes/last_ready_at | `ws/handler.ts:258-279, 469-529` |
| 写库时机 | daemon ready + **web 端懒建**（`POST /computers`、`POST /computers/me/token` 调 `ensureComputerRow`）——无 daemon 也有行 | computers.ts:42-60,121-126,187 |
| token scope | `machine_tokens.server_id` 列存在，但 `verifyMachineToken` 只回 `userId`——**握手不解析 server** | `lib/auth-token.ts:56-88`、handler.ts:220-225 |
| 连接注册 | `daemonMeta`/`daemonClients`/`presenceAdd`/`computerOnlineFor` 全部按 **userId** 键——一用户一连接单槽 | handler.ts:26,38,244-246 |
| agent↔computer | `LEFT JOIN computers c ON c.user_id = a.user_id`——用户级 join | `agents-public.ts:60` |
| agent↔机器 | **无绑定**——agent 跑在「属主当前连着的那台机器」上 | — |
| 派发链 | `sendToDaemon(userId)`——用户级单槽投递 | handler.ts |
| 删服（B5） | computers/machine_tokens 重指到主人们 personal org | `routes/orgs.ts` ~L237 |

## 1. 目标模型

**`computers` 改为「(用户, server, 机器) 三维注册」**：

```
computers：UNIQUE(user_id, server_id, machine_uuid)
  一行 = 某用户的某台物理机在某 server 的注册（信息由 daemon ready 帧写入）
  同一台物理机可在多个 server 各有一行；
  同一用户在同一 server 可有多台机器（灵耀14air + 台式机），各自一行、各自在线状态
```

- **`machine_uuid`**：daemon 首启生成 UUID 持久化到本机 `.slock/machine-id`，`ready` 帧上报——它是「同一台物理机」的稳定身份（hostname 可变，不做键）
- **行只在 daemon 握手/ready 时产生**：机器令牌携带 `server_id` → WS 校验解析 `(userId, serverId)` → `ready` 帧带 `machine_uuid` → upsert `(user_id, server_id, machine_uuid)` 行 + 写探测字段
- **web 端不再建行**：/computers 页在某 server 无行 → 空态 + 连接指引（`ensureComputerRow` 退役）
- **单 scope = 每台机器一个 server**（Q1 修正口径）：一个 daemon 进程同时只连一个 server；换 server = 停进程 → 换 token/`--server` 重跑。**不是**「一用户一连接」——同一用户的不同机器各自持有连接
- **连接注册按 `machineKey` 键**（Q2 相容性推论）：`daemonClients`/`daemonMeta` 从 `Map<userId>` 改为 `Map<machineKey>`（`machineKey = userId:machineUuid`），**每台机器一个槽**。同一用户的两台机器连同一 server → 两个 machineKey 自然共存、同时在场；同一台机器换 scope 重连 → 同 machineKey 顶掉旧连接（崩溃重连语义），顺带在注册层强制兑现「一台机器同时只在一个 server」
- **在线语义**：`(user, server, machine)` 行在线 ⟺ 存在 `machineKey = (userId, machineUuid)` 的活跃连接且其 token scope = server

### 1.1 agent 的机器绑定（Q2/Q3 闭环）

多机在线后「agent 跑在属主的计算机上」必须指明**哪台**。新增 `agents.computer_id`：

- `POST /agents {serverId}`：校验目标 server 里**我已有计算机行**（Q3）；绑定规则——仅一台已注册 → 自动绑定；多台 → 须显式 `computerId`（缺省报 400 列出候选）
- 派发路由：`sendToDaemon` 解析 agent → `computer_id` → `machineKey` 找连接。agent 在线/可派发 ⟺ 绑定机器持有 scope=agent.server_id 的活跃连接
- 存量 agent `computer_id = NULL`：派发回落「属主在该 server 任一在线机器」（单机时行为等价现状）；新 agent 一律绑定
- **触碰面如实标注**：`daemonClients` 多槽 + `sendToDaemon` 增 machine 路由是 server 侧 WS 注册/路由层的维度扩展；daemon 侧小改（CLI 收 `--server` + `.slock/machine-id` 生成 + ready 多送 `machineUuid`）；派发链的消息语义与队列不变

## 2. 链路设计

```
[web] /computers 页（活跃 server = X）
  └ GET /api/computers?serverId=X → server X 内所有成员的计算机（Q6：都可见，只读他人）
  └ POST /computers/me/token { serverId: X }        ← owner 校验（Q5 已确认）
       └ connect command:
          daemon --server-url <origin> --api-key sk_machine_<token>(token→X) --server <X 名>

[daemon] 本机 .slock/machine-id（首启生成）+ WS 握手
  └ verifyMachineToken → { userId, serverId }
       └ --server 参数与 token scope 一致性校验（拿错 token 立刻报，
          不静默连错 server；token 仍是唯一权威 scope）
       └ registerConnection：daemonClients[userId:machineUuid] = conn（每机一槽）
          daemonMeta[machineKey] = { serverId, hostname:"?", runtimes:[], connectedAt }

[daemon] ready 帧（hostname/os/arch/daemonVersion/runtimes/machineUuid）
  └ persistComputerReady(userId, serverId, machineUuid, probe)
       └ UPSERT computers(user_id, server_id, machine_uuid)

[读侧]
  computerOnlineFor(userId, serverId, machineUuid) → machineKey 连接存在且 scope 匹配
  GET /agents → agent.computer join (user_id, server_id, machine_uuid)
  sendToDaemon(agent) → agent.computer_id → machineKey → conn
```

### 2.0 daemon CLI：`--server` 参数（Q1 修正的落地）

- 生成命令带 `--server <server 名>`：运维语义明确（这台机器给谁干活），daemon 日志/prompt 可显示 scope
- **校验**：握手时 daemon 把 `--server` 传给 server 端比对 token scope——不一致即拒连（`token server mismatch`），防止「想连 X 却拿着 Y 的 token」这类运维错误静默发生
- token 仍是唯一权威 scope 来源；`--server` 是声明+校验+展示，不是权限边界
- 为将来 per-server 工作区/配置隔离（`.slock/servers/<id>/`）留口子

### 2.0a 隔离语义——「完全隔离」的兑现边界

例：电脑 A 在 001 建 agent1 → 停 daemon → 换 `--server 002` 重跑：

- **数据面**：`agent1.server_id=001`——002 的 agents 列表/成员页/频道@ 按 server 过滤，**不可见**（DB scope 保证，与 daemon 参数无关）
- **派发面**：`sendToDaemon(agent1)` → `machineKey(你,A)` → 连接 scope=002 ≠ 001 → **拒派**；agent1 在 001 显示离线，@它走现有 A1 队列语义
- **恢复面**：A 切回 001 → agent1 上线，盘上 session 续跑——「机器搬家，agent 留守」
- **本机面（诚实边界）**：`.slock/` 里 agent1 的工作区/session/token 文件仍在盘上休眠；同机不同 scope 的 agent 共享 OS 用户与文件系统——002 的 agent 技术上能读到 001 agent 的盘文件。**产品面隔离 ≠ OS 级隔离**；硬隔离需容器/独立 OS 用户，超出本期
- **可选硬化（记口子）**：`.slock/servers/<id>/` per-scope 目录（工作区/session store 按 scope 分）——降低误读、换 scope 目录天然分离；v1 可不做

### 2.1 token 签发与失效

- `POST /computers/me/token {serverId}`：**`isOrgOwner` 校验**（Q5 已确认）——与 `POST /agents {serverId}` owner-only 对齐：只有 owner 能把算力放进 server。若产品上想开 member 挂机，agent 放置权限也得同步放开，两口径同进退
- 存量 token：`server_id` 是旧随手标签但仍指向有效 server → 按它注册，自然兼容；指向已删 server → 校验拒连（§4.3）
- token 轮换「先吊销全部旧钥」v1 保留（单用户维度足够；多 scope 并行后再细化）

### 2.2 删服（B5）口径变化

server 删除时 `computers` 行**不再重指兜底**——行是 (user,server,machine) 注册，server 没了行即无意义：级联删除；该 scope 的 `machine_tokens` 吊销。绑定在被删 server 计算机上的 agent 本就随 `agents.server_id` 级联（agents>0 仍 409 先删 agent，口径不变）。

## 3. 迁移（新增 030）

```sql
-- ① computers：user_id UNIQUE → (user_id, server_id, machine_uuid) UNIQUE
ALTER TABLE computers DROP CONSTRAINT computers_user_id_key;   -- 约束名以实际为准
ALTER TABLE computers ADD COLUMN IF NOT EXISTS machine_uuid TEXT;
UPDATE computers SET machine_uuid = 'legacy-' || id::text WHERE machine_uuid IS NULL;  -- 存量行占位
ALTER TABLE computers ALTER COLUMN machine_uuid SET NOT NULL;
CREATE UNIQUE INDEX computers_user_server_machine_uniq ON computers (user_id, server_id, machine_uuid);

-- ② agents 机器绑定
ALTER TABLE agents ADD COLUMN IF NOT EXISTS computer_id UUID REFERENCES computers(id);
CREATE INDEX IF NOT EXISTS idx_agents_computer ON agents (computer_id);
```

存量 computer 行（每用户一行、server_id 旧标签）保留即视为「已在该 server 注册」，`machine_uuid = legacy-<id>` 占位——该机器下次 daemon ready 时按 machine_uuid 重写或新增行（若旧行 uuid 是占位而新上报真 uuid，会产生第二行：接受，或在 upsert 时按 (user,server) 单机回填占位行——落地时择一，建议回填：同一 (user,server) 只有占位行时直接 UPDATE 真 uuid）。

## 4. 逐端点/文件 diff

### 4.1 server

| 位置 | 现在 | 改为 |
|------|------|------|
| `verifyMachineToken`（auth-token.ts） | 返回 `{ ok, userId, scope }` | 增 `serverId`；token 的 server 不存在 → 拒 |
| WS 握手（handler.ts） | `resolveUserId` 只回 userId | 回传 `(userId, serverId)`；`daemonClients`/`daemonMeta`/`presenceAdd` 改 `machineKey` 键 |
| `ready` 帧 | 无 machine 概念 | 校验 `msg.machineUuid`（缺省拒绝或生成 legacy 占位）；`daemonMeta[machineKey]` 记 scope+meta |
| `persistComputerReady` | UPSERT by `user_id` 单行 | UPSERT by `(user_id, server_id, machine_uuid)`；删「无成员随手插 personal」分支 |
| `GET /api/computers` | 无此列表端点（只有 /me） | **新增 `?serverId=`**：返回该 server 全部计算机行（成员可读，Q6）；附 owner handle/在线状态 |
| `GET /computers/me` | user_id 单行 | 活跃 server 语境查「我在此 server 的机器」（可能多行→数组；或保留单机语义取最近在线） |
| `POST /computers`（懒建） | `ensureComputerRow` | **删除**（web 不建行） |
| `PATCH /computers/me` | user_id 单行 | 按 `(me, server, machineId)` 定位（body 带 machineId 或行内编辑逐机） |
| `DELETE /computers/me` | user_id 单行 + agents>0 409 | 按 `(me, server, machineId)` 删行；409 口径「绑定在这台机器上的 agents」 |
| `POST /computers/me/token` | serverId 随手落 | `serverId` 参数 + **`isOrgOwner`**（Q5） |
| `POST /agents` | owner + daemon 在线 | + 目标 server 内有我的计算机行；绑定 `computer_id`（单机自动/多机需传参） |
| `GET /agents` join | `c.user_id = a.user_id` | `c.id = a.computer_id`（优先）→ 存量 NULL 回退 `(user_id, server_id)` 任一 |
| `computerOnlineFor` | `(userId)` | `(userId, serverId, machineUuid)` |
| `sendToDaemon` | `(userId)` 单槽 | `(machineKey)`；agent 相关调用先解 `computer_id` → machineKey；非 agent 调用（如用户级通知）广播全部 machineKey 或沿用首连接 |
| `ensureComputerRow`/`loadComputerRow` | user_id 单行 | 退役/改签名 |
| B5 删服级联 | computers/tokens 重指兜底 | computers 行级联删 + scope tokens 吊销 |

### 4.2 web

| 位置 | 现在 | 改为 |
|------|------|------|
| `/computers` 页 | 用户级单台 | 活跃 server 语境「本服务器的计算机」：全部成员可见（Q6），自己的机器可操作（改名/描述/签 token/删除），他人只读（owner 徽标 + 在线状态 + hostname/运行时） |
| 空态 | — | 无行 → 「本服务器还没有计算机」+ 连接指引 + 为本 server 签 token |
| 建 agent | 落点链 + daemon 在线 | + 目标 server 已有我的计算机行；多机时机器选择控件 |
| PeopleView 计算机分组 | join 自带 | 无需改——新 join 口径下未绑定 agent 落「未登记计算机」组 |
| apiClient | x-server-id 已自动注入（`setTenantProvider`） | ✅ 无需改——Q7：web 老调用方天然带 header |

### 4.3 不变项

- `requireOwnAgent`/`duty`/`agent:stop`（按 agent.computer_id 路由到绑定机器，语义不变）
- daemon 运行时编排/派发队列——daemon 侧增量仅：CLI 收 `--server` 参数并随握手声明（§2.0）、本机 `.slock/machine-id` 首启生成 + ready 帧带 `machineUuid`
- 频道/消息/ACL/租户解析主链路

## 5. 语义缝隙（如实记录）

1. **agent 可派发 ⟺ 绑定机器在线且 scope 匹配**：机器用 server Y 的 token 连着时，它在 server X 的行离线 → X 里绑它的 agent 不可派发。比现状（用户级在线即派发）**更严**，这正是「计算机跟 server」的兑现
2. **一台机换 scope 的代价**：机器 M 绑了 server X 的 agent 后，把 M 的 daemon 切到 server Y → X 里这些 agent 全部离线（行保留、历史消息不动）。切回 X 即恢复——「机器搬家，agent 留守」是模型内语义
3. **同 token 双机**：同一 (user,server) token 在两台机器上用 → 两行（machine_uuid 区分）都合法；若要加强绑定可后续做 token↔machine 首次绑定
4. **存量行回填**：`legacy-<id>` 占位行与真 uuid 行可能短暂并存，§3 已给回填口径

## 6. 开放问题（2026-09-19 已确认）

1. **daemon scope**：✅ **单 scope = 每台机器一个 server**——一个 daemon 进程同时只连一个 server，换 server 须停进程重跑（`--server` 参数 + token scope 一致性校验，§2.0）。**不是**「一用户一连接」：同一用户的不同机器各自持连接、同 server 同时在场（machineKey 注册层兑现，§1）
2. **一用户一 server 多机**：✅ **支持**——`UNIQUE(user_id, server_id, machine_uuid)` + 连接注册 `machineKey` 每机一槽 + `agents.computer_id` 绑定（§1.1）。与 Q1 不冲突：多机 = 不同 machineKey 共存；单机换 scope = 同 machineKey 顶连接
3. **建 agent 前置**：✅ **校验计算机已注册**——目标 server 内须有我的计算机行；单机自动绑定，多机显式 `computerId`
4. **`machine_uuid`**：✅ **持久化**——daemon 首启生成写 `.slock/machine-id`，ready 上报
5. **签发权限**：✅ **`isOrgOwner`**——与 `POST /agents` owner-only 同进退：只有 owner 能放 agent，也只有 owner 能把算力放进 server
6. **他人计算机可见性**：✅ **server 内全员可见、只读**——/computers 页列本 server 所有计算机行；操作（改名/描述/签 token/删除）仅机器属主
7. **老调用方**：✅ **补 x-server-id 而非回落**——web `apiClient` 已自动注入 `activeServerId`，零改动即匹配；非 web 调用方（脚本/CLI）须显式传 `serverId`，缺失 → **400 `serverId required`**（不回落 personal，避免静默错 scope）

## 7. 验证要点（落地时）

- 迁移 030：三维 UNIQUE + `agents.computer_id` + 存量占位/回填
- 握手：token→(user,server) 解析；scope 失效 token 拒连；`machineUuid` 缺失处理
- 多机：同用户两台机器同 server → 两行独立、多槽同时在线、互踢消失
- 建 agent：无计算机行 403；单机自动绑定；多机需 computerId；绑定后派发路由到对应 machineKey
- 在线：(user,server,machine) 三级匹配才在线；换 scope 连接 → 旧 scope 行离线
- /api/computers?serverId：server 内全员可读他人机器；操作仅属主
- 删服：computers 行级联清 + scope tokens 吊销
- 回归：computers/agents/tenant/orgs/ws/agent-duty 套件
