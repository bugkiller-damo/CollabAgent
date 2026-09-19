# Server（Guild）化重构计划 —— Raft 式「用户持服」模型

> 日期：2026-09-18
> 状态：**P0 已落地**（2026-09-18：后端 `test/orgs.test.ts` 7 例 + `test/metrics.test.ts` 12 例全绿；前端 `vue-tsc` 干净、vitest 168/168 全绿）
> **P1 推进**：B5 已落地（2026-09-18：`test/orgs.test.ts` 11/11 全绿；补口径——默认社区/广场拒删 409，`GET /api/orgs` 返回 `isDefault` 供前端隐藏入口）；B6 已落地（2026-09-18：`test/orgs.test.ts` 14/14 全绿；补口径——personal server 拒转 409，默认社区**可转**作为实例管理员显式交接路径）
> **IA 变更**（2026-09-18）：撤销最左 ServerRail 独立列，server 切换/新建/加入收进左下角头像二级菜单（`UserAvatarButton`：私有空间/公共服务器分组 + 未读角标 + 连接状态；移动端抽屉顶栏同组件向下弹出）
> 范围：`packages/server`（少量端点 + 一处安全收紧）、`packages/web`（server rail + 路由/存储加维度）、`packages/shared`（协议字段透传）；daemon 派发链路零改动
> 依据：2026-09-18 三包并行核查（server 数据模型 / WS·权限 / web IA）；`lib/tenant.ts`、`lib/orgs.ts`、`routes/orgs.ts` 现状
> 视觉约束：不仿 Raft UI，沿用现有灰蓝 Tailwind（与 08-23 成员页报告同口径）

---

## 0. 一句话

**底层早已是多 server 架构，这次是把「用户创建/切换/管理 server」的产品面补全**：注册后强制 wizard 建服、最左加一列 server rail、频道 URL 与缓存按 server 消歧、补 4 个端点 + 修 1 个权限回归。不动 schema 主结构、不动 dispatch、不动 ACL。

---

## 1. 现状核查结论（为什么这不是重建）

| 层 | 已存在 | 缺口 |
|---|---|---|
| Schema | `servers`（`personal`/`owner_id`）、`server_members`（owner/admin/member）、`invites`（限额/过期/吊销）；`channels/messages/agents/computers/machine_tokens` 全带 `server_id` | 无 `servers.icon_url`（P1 再加）；`server_members.user_id` 无 FK（历史残留，本期不动） |
| API | `GET /api/orgs`（我的 server + 计数）、成员增删改（owner）、邀请链接 CRUD、`GET /invites/:token` 校验、注册消费 invite、`POST /agents` 已收 `serverId` | **无 `POST /orgs`**、无改名/退出/删除/转让、无已登录接邀请 |
| 租户/ACL | `resolveTenant` 四级解析、`isServerMember`、`canAccessChannel` = server 成员 ∪ 频道成员 | 单租户降级豁免保留（见 §6.3） |
| WS | 广播按「公开频道=server 成员 ∪ 频道成员；private/dm=频道成员」圈定，pub/sub 多实例扇出 | 零改动 |
| 注册 | 消费 invite 入圈 + 自动加入默认社区（2026-09-17 收紧配套）+ 惰性建 personal server | 无建服 wizard |
| 前端 | `channelStore.serverId` 已存并回传；`WorkspaceMembers` 已有 org 下拉 + 邀请链接 | 无 server 切换 UI；URL `/channels/:name` 跨 server 撞名；消息缓存 key 按频道名会串 |

**结论**：工作量 ≈ 后端 4~5 个端点 + 1 处权限收紧 + 前端 IA 加一维。

---

## 2. 已拍板口径

| # | 问题 | 拍板 |
|---|------|------|
| Q1 | 默认公共社区 | **保留为广场**：注册仍自动加入 Default Server |
| Q2 | Agent 跨 server | **每 server 一份 agent**（`agents.server_id` 单归属不变，同名不同行） |
| Q3 | 建服流程 | **强制 wizard**：新注册必填 server 名后才落地 |
| Q4 | 前端 IA | **独立 server rail 列**（Discord 式最左图标列） |
| D1 | 受邀注册用户 | **同样强制，但顺序宽松**：先落地被邀 server，wizard 以「每会话一次、可暂关、未建服则持续出现」的提示跟随，直至建出自己的 server（此条按用户答复语义落稿；若受邀用户完全不强制，改 §3.4 一处即可） |
| D2 | DM 中 agent 同名消歧 | `resolvePeer` 优先 active server 的 agent；DM 列表显示所在 server 副标 |
| D3 | 存量用户 | **不强制补建**（已有归宿），rail「+」随时可建 |
| D4 | server 删除级联 | **有 agents 的 server 禁止删除**，先删 agents（危险操作分级） |
| D5 | server 图标 | MVP 用首字母自动图标；`icon_url` 上传 P1 |

---

## 3. 目标模型

### 3.1 生命周期

```
注册 ──► 事务内：建用户（+ 消费 invite 入被邀 server）
     ──► 自动加入 Default Server（广场，保留）
     ──► 【强制 wizard】填 server 名
            ├─ 无 invite：ensure personal org → PATCH 命名 → 落地 /s/:id/channels/general
            └─ 有 invite：落地被邀 server，提示跟随（D1）
之后：rail「+」→ POST /api/orgs 建更多 server（personal=false）
```

### 3.2 实体口径

- **server**：用户可持多个。`personal=true` 仅标记首个/兜底 server——daemon 首连、computer upsert、`POST /agents` 无 serverId 时的落点继续用它（`lib/orgs.ts` 现有调用点全部不动）。
- **channel**：`server_id NOT NULL` 不变。新建 server 自动带 `general` 频道（沿用 seed 惯例），创建者为 channel owner。
- **DM**：schema 不动（仍 `type='dm'` 寄生某 server，`lib/access.ts` 已豁免 server 校验）；UI 提成 rail 顶部「首页/私信」入口，即 Discord Home。
- **agent**：`agents.server_id` 单归属 + `(server_id, lower(name))` 唯一不变。同一用户在不同 server 各建一份；daemon 按 userId 单连接派发，跨 server 天然兼容，**派发链路零改动**。`POST /agents` 已收 `serverId`，前端传 active server 即可。
- **computer**：用户级设施（一人一机），`computers.server_id` 继续指 personal server，不暴露成 server 资产，`/computers` 页保持账号级。

### 3.3 server 角色

沿用 `server_members.role`：owner（建服者，唯一）/ admin（owner 授予，可管成员与频道）/ member。本期不加细粒度权限。

### 3.4 wizard 强制规则（D1 细化）

- 判定条件（落地实现 `serverStore.hasOwnServer(orgs, handle)`）：owns **非 personal** server，或 personal server **已被改名**（≠ `getOrCreatePersonalOrg` 默认名 `{handle} 的私有空间`）。不能单看 `role='owner'`——personal server 用户天然 owner，会把全员误判为「已有」。
- 新注册：wizard 页为落地前必经步骤，不可跳过。
- 受邀注册：落地被邀 server 后，顶部提示条「创建你的服务器」（可暂关、每会话一次、未建则下次登录再现）。
- 存量用户（D3）：不弹 wizard；若无自有 server 仅见可暂关提示条。

---

## 4. 后端 delta

### 4.1 新端点

| # | 端点 | 契约 | 权限/事务 | 状态 |
|---|------|------|-----------|------|
| B1 | `POST /api/orgs` | `{ name }` → `{ org }`。name 1–100 字、trim、拒空 | 事务：`INSERT servers(personal=false, owner_id=me)` + `server_members(role='owner')` + `INSERT channels(name='general')` + `channel_members(owner)`。失败全回滚 | ✅ |
| B2 | `POST /api/invites/:token/accept` | 已登录消费邀请 → `{ ok, serverId, serverName }`；已是成员幂等不烧 uses | 条件 UPDATE invites（revoked/expires/max_uses 入库判定，复用 register 的单语句防 TOCTOU 口径）+ `INSERT server_members ON CONFLICT DO NOTHING` + `invalidateServerMembers`，同一事务 | ✅ |
| B3 | `PATCH /api/orgs/:id` | `{ name? }`（预留 `iconUrl?`）→ `{ org }` | owner 限定（`isOrgOwner`）。wizard 复用：先 `getOrCreatePersonalOrg` 再 PATCH 命名 | ✅ |
| B4 | `POST /api/orgs/:id/leave` | → `{ ok }` | member/admin 可退；**owner 拒退**（409 `owner must transfer or delete`）。personal server 拒退（409） | ✅ |
| B5 | `DELETE /api/orgs/:id`（P1） | → `{ ok }` | owner 限定 + **前置校验：`agents.server_id = :id` 计数为 0**，否则 409 `delete agents first`（D4）。删除 = 事务内删 channels→messages 依赖序 + server_members + invites + servers。personal server 拒删 | ✅ |
| B6 | `POST /api/orgs/:id/transfer`（P1） | `{ userId }` → `{ ok }` | owner 限定；目标须为 server member；事务内改 `servers.owner_id` + 两人 `server_members.role` 互换 | ✅ |
| 补 | `GET /api/invites/:token` 增强 | 返回新增 `serverId`；已登录且已是目标成员时返回 `alreadyMember:true`（在 exhausted 检查之前短路） | 可选鉴权（cookie）。受邀注册后主路径必经：register 事务已消费 invite，max_uses=1 时已耗尽——无此短路 InviteAcceptPage 会误显「已达上限」 | ✅ |

### 4.2 安全收紧（P0 必做，防回归）—— ✅ 已落地

**`lib/orgs.ts isInstanceAdmin` 现判定「任一非 personal server 的 owner」**。B1 上线后任何用户都能建非 personal server → metrics 门禁全员放行。改为：

```ts
// 仅默认社区（广场）owner 视为实例管理员
WHERE s.id = <getDefaultServerId> AND (s.owner_id::text = $1 OR sm.role = 'owner')
```

代码注释已预留此口径（"改此一处即可"）。同步查 `isInstanceAdmin` 全部调用点确认无其它依赖。

### 4.3 顺带修正

- `POST /api/orgs` 与 wizard 路径都要 `invalidateServerMembers`（新 server 无缓存可省，但统一调用无害）。
- `GET /api/orgs` 已按 `personal DESC, created_at ASC` 排序，前端直接用。
- `GET /api/server/info?serverId=` 已有 explicit 成员校验，切换 server 即调它。

---

## 5. 前端 delta

### 5.1 布局：三列 → rail 复合

```
┌─ ServerRail ~64px ─┬─ 现有 rail/pane ─┬─ 主区 ─┐
│ 🏠 首页·私信        │ chat/tasks/...   │        │
│ ─────────          │ （随 server 切换） │        │
│ ○ server A（首字母）│                  │        │
│ ○ server B         │                  │        │
│ ＋ 建/加 server     │                  │        │
└────────────────────┴──────────────────┴────────┘
```

- `ServerRail.vue` 新组件（✅）：首页/DM 图标 → 分隔线 → server 圆形首字母图标（`Tooltip` 显示全名；**未读聚合角标已顺手落地**——`unreadCounts` key 前缀匹配该 server 求和）→「+」弹层内双 tab「创建服务器 / 加入服务器（粘邀请链接或码）」。
- 点击 = `serverStore.setActive(serverId)` → `channelStore.resetForServer + fetchChannels(serverId)`（AppLayout watcher）→ 跳该 server 上次访问频道（localStorage `slock.lastChannel.<serverId>`，无则 `general`）。
- 移动端：ServerRail 随 Sidebar 一起在抽屉内可见（不单开抽屉）；`MobileTabBar` 的聊天/任务跳转已走 server-aware path。

### 5.2 路由迁移（URL 加 server 段）

频道名不全局唯一，URL 必须带 server。**用 UUID**（server 名也不唯一）：

| 旧 | 新 |
|---|---|
| `/channels/:name` | `/s/:serverId/channels/:name` |
| `/channels/:name/:threadId` | `/s/:serverId/channels/:name/:threadId` |
| `/dm/:peerName` | `/dm/:peerName` 不变（DM 出 server 语境） |
| `/tasks/:channelName` | `/s/:serverId/tasks/:channelName` |
| `/people` `/activity` `/search` `/computers` `/settings/*` | 不变（读 `activeServerId` 的走 store，不走 URL） |

兼容（✅ 落地为 AppLayout `router.replace` 规范化而非真 302）：`/channels/*`、`/tasks/*` 旧路由仍注册同组件，watcher 在 `activeServerId` 就绪后 replace 成 `/s/<active>/...`（保留 query/hash）。波及点已全部改走 `lib/nav.ts` helper（`channelPath`/`threadPath`/`tasksPath`/`parseChannelRoute`/`parseTasksRoute`）：`ChatPane`、`TasksPane`、`TaskBoard`、`SearchView`、`MessageRow`、`MemberProfileBody`、`MobileTabBar`、`SidebarRail`、`notification-jump`、通知创建侧 `metadata.serverId` 透传。

### 5.3 Store（✅ 已落地，key 口径以代码为准）

- **新 `serverStore`**（`stores/serverStore.ts`）：`orgs[]`、`activeServerId`（localStorage `slock.activeServer` 持久化，回落 = 首个非 personal ?? 首个）、`setActive`/`fetchOrgs`/`createServer`/`renameServer`/`leaveServer`/`acceptInvite`；导出纯函数 `hasOwnServer`/`personalDefaultName`（§3.4 判定）。注册 `setTenantProvider` 回调——apiClient 对 `/api/` 请求自动注入 `x-server-id`，`tenant:false` 或显式同名 header 可覆盖。
- **`channelStore`**：`unreadCounts` key = `<serverId>:<裸名>`（无 serverId 退化为 `:<名>`；读写清单三侧统一 `unreadKeyFor`）；`fetchChannels(sid)` 显式传参；`resetForServer(sid)` 切 server 即清旧列表防短暂串显；`joinChannel`/`leaveChannel` 已接 `POST /channels/:id/join|leave`。
- **`messageStore`**：本地 target key = `<serverId>:#<name>`（**保留 # 前缀**——`parseScopedTarget` 按 `<uuid>:` 前缀拆分，DM `dm:<uuid>` 原样）；`apiTarget()` 解包成线上 `#name` + 显式 `x-server-id` init——离线队列重发投递到**入队时**的 server，与当前活跃无关。localStorage 缓存/水位/pending key 同 target 消歧。
- **`agentStore`**：未改；按 server 过滤在消费侧做（`PeopleView`/`ChatPane` 私信候选按 `server_id === active` 过滤）。
- **WS 广播**：`WsDeliverMessage` 新增可选 `serverId`（shared；三处广播点 `messages.ts`/`agents-messages.ts`/`agents-dispatch.ts` 均带）——`wsDispatch` 据此生成 scoped target key 并按 server 分桶未读；daemon 不消费该字段，兼容。

### 5.4 频道/成员 UI（✅ 已落地）

- `ChatPane` 顶部加 server 头：server 名 + 下拉（邀请链接｜成员管理→`/settings/members`｜改名 owner 限定｜退出 server）。邀请链接走 `POST /orgs/:id/invites`（owner 限定，与后端口径一致）。
- `CreateChannelModal` 经 `channelStore.createChannel` 带 `serverId = 当前频道语境`。
- 建 agent 入口（`ComputerView`）传 `serverId = activeServerId`（缺省回落 personal org——server 端既有行为）。
- 「浏览公开频道并加入」✅：ChatPane 未加入频道行 hover 显「加入」按钮，`joinedChannels` 真正消费。
- `WorkspaceMembers` 默认选中改为当前活跃 server（回落 = 首个非 personal）。

### 5.5 注册/onboarding（✅ 已落地）

- `RegisterPage` 成功 → 无 invite：`/onboarding/server`；有 invite：`/invite/:token`（InviteAcceptPage 的 alreadyMember 短路直接落地被邀 server）。
- `OnboardingServerPage`：预填 personal server 现名 → `hasOwnServer` 已成立者直接放行（存量/受邀用户手动进入不挡）→ submit = `PATCH /orgs/:id` 命名 personal（无 personal 才 `POST /orgs`）→ `router.replace(/s/:id/channels/general)`。
- `InviteAcceptPage`：已登录先 `GET /invites/:token` 校验（`alreadyMember` → 直接落地）；未登录 → `/register?invite=`。
- D1 提示条在 `AppLayout`：`hasOwnServer === false` 时显示（sessionStorage 暂关）。

### 5.6 产品页 server 语境（✅ 已落地，一处口径修订）

| 页 | 口径 |
|---|---|
| `/people` | active server 成员（humans = `/server/info` 经注入圈定，agents = `/api/agents` 按 `server_id===active` 过滤）；切 server 重拉 |
| `/tasks` | active server 频道内任务；`TaskBoard`/`TasksPane` 全部调用显式带 `x-server-id`（`taskInit`），不依赖 active 同步时序 |
| `/search` | **口径修订：随 `x-server-id` 注入圈定活跃 server**——原拟本期保持全局，但结果行只有频道名无 serverId，全局结果无法生成消歧的 `/s/` 跳转；按 server 圈定反而语义正确（同 Discord） |
| `/activity` | 全局（通知自带 `metadata.serverId` 精确落地，列表本身不分 server） |
| `/computers` `/settings/*` | 账号级，不变 |

`people.ts`/`tasks.ts`/`server/info`/`messages*` 均走 `resolveTenant`，头部注入即圈定；`TaskBoard` 额外显式传 `x-server-id` 防切 server 途中的时序窗口。

---

## 6. 兼容与迁移

1. **存量数据**：全部留在 Default Server，成员身份不变；老用户不弹 wizard（D3）。
2. **旧 URL**：`/channels/*` 一律 302 到新格式；消息 localStorage 缓存 key 变更后旧条目自然过期（或有版本前缀一次性清）。
3. **`resolveTenant` 单租户豁免保留**（`tenant.ts:115-124`）：Default Server 是广场，所有注册用户本就入圈，豁免不扩大暴露面。多社区托管（SERVER_HOST_MAP）开启时该豁免已自动失效，无需改代码；P1 复查一遍即可。
4. **个人空间命名**：存量 personal server 名「{handle} 的私有空间」统一不迁移；用户可自行改名。
5. **`isInstanceAdmin` 收紧**（§4.2）与 B1 **同批上线**，顺序不可颠倒——先开建服再收紧 = 门禁空窗期。

---

## 7. 边缘 case 清单

| case | 处理 |
|------|------|
| DM `/dm/cindy` 跨 server 同名 agent | `resolvePeer` 优先 active server 的 agent；DM 列表行加 server 副标（D2）。仍歧义时取最近交互 |
| owner 退出/删除 personal server | 一律 409 |
| owner 转让 personal server | 一律 409（B6 落地补口径：`servers.owner_id` 是 `getOrCreatePersonalOrg` 的命中键，转出会让原主丢兜底空间、受让者凭空多一个 personal server） |
| owner 删除默认社区（广场） | 一律 409（B5 落地补口径：删除会让 `getDefaultServerId` 静默易主到任意自建 server，注册自动入圈与 `resolveTenant` 豁免随之转移） |
| 被邀 server 与自建 server 同名频道 | URL 已带 serverId 消歧 |
| daemon 派发跨 server | 零改动：`agent:deliver` → owner userId → `daemonClients` |
| 用户被移出 server 后 WS 扇出 | `invalidateServerMembers` 后下一条消息起不再收到（成员集合每次扇出前解析） |
| 建服后立刻建 agent | `POST /agents {serverId}` 校验 `getUserOrgIds` 含新 server（同一请求序内已过事务） |
| server 图标 | 首字母圆形（D5）；`icon_url` 列 P1 迁移再加 |

---

## 8. 分期

### P0 — 核心闭环（✅ 已完成 2026-09-18）

- 后端：B1–B4 + §4.2 `isInstanceAdmin` 收紧 + `GET /invites/:token` 返回 `serverId`/`alreadyMember` + `WsDeliverMessage.serverId` + `resolvePeer` meId 兜底（DM/people 解析）
- 前端：ServerRail + serverStore + URL 迁移（旧链规范化）+ store key 消歧 + ChatPane server 头 + wizard 页 + `/invite/:token` 页 + joinedChannels 入口 + people/tasks/computers server 语境
- 验收：新注册 → wizard 建服 → 落地 #general；「+」建第二 server 并切换；邀请链接已登录可接；两 server 各有同名频道不串消息/缓存；DM 正常；metrics 仅广场 owner 可见
- 验证结果：server `tsc` clean；web `vue-tsc` clean；`test/orgs.test.ts` 7/7、`test/metrics.test.ts` 12/12；web vitest 168/168（含新增跨 server 未读分桶、alreadyMember、scoped key 用例）

### P1 — 完整度

- ~~B5 删除 server（D4 级联校验）~~ ✅（补口径：默认社区拒删；computers/machine_tokens 挂靠重指 personal server；action_cards/attachments 孤儿随级联清理）
- ~~B6 转让~~ ✅（补口径：personal server 拒转 409；默认社区可转 = 实例管理员显式交接；事务内 RETURNING 复检防目标被移出竞态；脏数据多 owner 时旧主钳到 member）
- `icon_url` 列 + 上传、server 图标未读聚合角标、activity/search server 过滤、`resolveTenant` 豁免复查、`server_members.user_id` 补 FK（连同 `::text` 残留清理）

### 不做（本期明确）

- 频道分类（category）、server 内细粒度权限、server 模板、server 发现页、跨 server 迁移频道/agent、群聊 DM

---

## 9. 测试点

- `POST /orgs`：事务原子性（channels 失败不留 server 孤行）、name trim/长度、owner 行写入
- `invites/:token/accept`：限额并发（沿用 register 的 TOCTOU 用例形态）、已成员幂等、revoked/expired 410
- `orgs/:id/leave`：owner/personal 409；member 退出后 `server/info` 403
- `isInstanceAdmin`：新建 server 的 owner **不**获得 metrics 权限（回归测试必写）
- wizard：注册无 invite → 强制落地；有 invite → 提示跟随
- 前端：同名频道跨 server 的 URL/缓存隔离；activeServerId 持久化；旧 `/channels/x` 302

---

## 10. 审查时请盯

1. **§4.2 与 B1 同批**，不许拆批上线。
2. B1 事务里 `general` 频道名冲突：`(server_id, lower(name))` 唯一索引在新 server 内无冲突，无需 ON CONFLICT，但要断言插入成功。
3. B2 与 register 的 invite 消费保持同一「条件 UPDATE」口径，别开第二条 SELECT-then-UPDATE 路径。
4. personal server 的「兜底语义」不能因改名/暴露而破坏：`getOrCreatePersonalOrg` 仍按 `owner_id + personal` 查，改名不影响命中。
5. 前端「+」入口要同时提供「创建 / 用邀请链接加入」两个选项，别把 accept 藏进注册流。
6. DM 保持 schema 寄生现状——不要为了「干净」把 `channels.server_id` 改 nullable，ACL 豁免已经够用。
