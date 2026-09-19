# Server 权限模型收敛 —— 两类 server + owner/member 二元角色

> 日期：2026-09-18
> 状态：**已落地**（2026-09-18：server `tsc` clean、vitest 587/587 全绿含迁移 029；web `vue-tsc` clean、vitest 168/168 全绿）
> 上游：`docs/2026-09-18/01-server-guild-refactor-plan.md`（B1–B6 已落地）
> 起因：bugkiller 的「私有空间」引出概念错位——personal server 从未被强制私有（members/invites 端点只查 `isOrgOwner`，无 personal 拦截），「仅自己可见」只是 UI 标签而非执行

## 1. 模型：只有两种 server

| 类型 | 判定 | 语义 |
|------|------|------|
| **公共服务器** | `servers.is_public = true` | 对所有用户开放：注册自动入圈 + 已登录可自助 join；当前只有广场（最早非 personal server） |
| **用户服务器** | `is_public = false` | 用户自己创建、邀请制；personal server（系统自动建的「私有空间」）**归入此类**，personal 只作来源标签，不再承担任何能力差异 |

`personal` 列保留，降级为**来源标签**（onboarding 默认命名「X 的私有空间」、UI 打「个人空间」标记、`hasOwnServer` 向导判定、删除时设施重指的优先落点）。它不再意味着：

- ~~不可拉人~~（本来就没拦——现在明说：和其他用户 server 一样可邀请）
- ~~拒退/拒删/拒转~~（生命周期统一：member 可退、owner 可删可转——见 §4）

## 2. 角色：owner + member 二元；admin 冷冻

`server_members.role` 的 `'admin'` 值保留在 schema CHECK 里但**不做实**——所有非 owner 成员平权，admin 视为 member。将来扩充管理员角色时复用该值，不另起设计。

```
owner   改名 / 删除 / 转让 server；建频道；成员增删（含角色）；邀请链接 CRUD；
        server 内增删 agent、配置 agent 的计算机连接
member  频道内读写；@ 调用频道内 agent 工作；查看 agent 基本信息；退出 server
```

变化点：

- **建频道收敛到 owner**：`POST /api/channels` 现只查 `isServerMember`，改为 `isOrgOwner`（频道 PATCH/DELETE 仍走 `canManageChannel`——只有 owner 能建频道后两者天然重合）
- **member 不能拉人**：成员增删 + 邀请链接维持 owner-only（现状已是）
- **admin 入口冻结**：WorkspaceMembers 角色下拉只保留展示（不再有 member/admin 切换控件；存量 admin 行显示为成员）

## 3. Agent 归属：人持有、放进 server（现状确认 + 一处收口）

现状（`routes/agents-public.ts` 实证）：

- `agents.user_id` = 属主用户；`agents.server_id` = 放置的 server；agent 跑在**属主的** daemon/计算机上（`computers` 按 `user_id` 关联，一人一机）
- `POST /agents {serverId}` 现只查「我是该 server 成员」——**任何 member 都能把自己的 agent 放进任何所属 server**
- PATCH/DELETE/duty 全走 `requireOwnAgent`（只有属主本人）

按「owner 增删 agent」收口：

- `POST /agents {serverId}` → **`isOrgOwner(serverId)` 限定**（403 口径与成员管理一致）。personal server 建 agent 不受影响（创建者即 owner）
- **server owner 可移出 server 内他人 agent**：`DELETE /api/orgs/:id/agents/:agentId`（owner 限定）——**踢出而非销毁**：`agents.server_id` 重指到 agent 属主的 personal org（属主兜底空间恒在），agent 本体与 daemon 注册不动。销毁性 `DELETE /agents/:id` 维持 `requireOwnAgent`
- 「配置不同计算机连接」现状即「agent 跑在创建者（=server owner）的计算机上」；跨计算机/他人计算机调度是一人一机放开后的扩展点，本期不动

## 4. 生命周期统一（personal 锁全部解除）

| 操作 | 现口径 | 新口径 |
|------|--------|--------|
| leave | member 可退非 personal；owner 拒退；personal 拒退 | **member 可退任意 server**（含 personal 与广场——退出广场后可经 join 回来）；owner 恒拒退（`owner must transfer or delete`，各 server 恒有 owner） |
| delete | personal 409 + 默认社区 409 + agents>0 409 | personal **放行**（同一套级联）；`is_public` 仍拒删；agents>0 仍 409 |
| transfer | personal 409 | personal **放行**（B6 同一套事务互换）；`getOrCreatePersonalOrg` 按 `owner_id+personal` 命中，转出后原主下次需要时自动获新兜底空间 |

`servers.owner_id` 语义不变；`getOrCreatePersonalOrg` 保留（onboarding + 设施兜底仍会触发创建）。

## 5. 公共服务器：`is_public` 列 + 自助 join

- **迁移**：`ALTER TABLE servers ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT false`；`UPDATE servers SET is_public=true WHERE id = (SELECT id FROM servers WHERE personal=false ORDER BY created_at ASC LIMIT 1)`（广场标记从「最早非 personal」启发式升格为显式列）
- `getDefaultServerId` / `isInstanceAdmin` / `GET /orgs` 的 `isDefault`：优先取 `is_public=true`（无则回退原启发式——多公共 server 场景下 admin 锚点恒取最早 `is_public`）
- **新端点** `POST /api/orgs/:id/join`：已登录用户自助加入 `is_public` server → `server_members` 幂等 INSERT；非 public → 403（`invite required`）
- 注册自动入圈改按 `is_public` 过滤（行为等价，口径更诚实）
- `GET /api/orgs` 返回 `is_public`（替换/并存 `isDefault`）

## 6. 前端口径

- **UserAvatarButton 菜单**改两段：**公共服务器**（`is_public`）+ **我的服务器**（其余全部，personal 行打「个人空间」小标而非独立分区；删掉「仅自己可见」谎言标签，副标改为 `角色 · N 成员`）；公共区补「加入」动作（非成员时显示）
- WorkspaceMembers：角色下拉冷冻（admin 不可再指派）
- ChatPane 建频道按钮：`isOrgOwner` 门控（member 隐藏）
- Agent 创建/删除入口：仅 server owner（个人空间不受影响）
- owner 对他人的 agent 显示「移出 server」而非删除

## 7. 逐端点 diff 清单（后端）

| 端点 | 现在 | 改为 |
|------|------|------|
| `POST /api/channels` | `isServerMember` | `isOrgOwner` → 403 `only org owner can create channels` |
| `POST /api/agents` | `getUserOrgIds` 含 serverId | `isOrgOwner(serverId)` → 403 |
| `POST /api/orgs/:id/leave` | personal 409 | 去掉 personal 分支（owner 拒退保留） |
| `DELETE /api/orgs/:id` | personal 409 + 默认 409 | 去 personal 分支；默认拒删改判 `is_public` |
| `POST /api/orgs/:id/transfer` | personal 409 | 去 personal 分支 |
| `POST /api/orgs/:id/join` | — | **新增**：`is_public` 开放自助加入 |
| `DELETE /api/orgs/:id/agents/:agentId` | — | **新增**：owner 把 agent 移出 server（重指属主 personal org） |
| `GET /api/orgs` | `isDefault` 计算列 | 增 `is_public`（`isDefault` 保留兼容或随之改判） |
| 注册事务 | 自动入最早非 personal | 自动入 `is_public`（回退原启发式） |
| members/invites 端点 | owner 限定 | 不变 |
| `requireOwnAgent` 族 | 属主本人 | 不变 |

## 8. 测试更新

- `orgs.test.ts`：B4/B5/B6 的 personal 409 三例翻转为成功路径；新增 join 端点用例（public 可入/非 public 403/幂等）；owner 移出他人 agent 用例
- `channels.test.ts`：member 建频道 → 403
- `agents-public` 相关测试：member `POST /agents {serverId}` → 403；personal 建 agent 仍 200
- 迁移测试：`is_public` 列 + 广场标记回填

## 9. 开放问题（已确认 2026-09-18）

1. **owner 移出他人 agent = 踢出** ✅ 不销毁：`agents.server_id` 重指属主 personal org，agent 本体与 daemon 注册不动
2. **`is_public` 给实例管理员预留** ✅：`PATCH /api/orgs/:id { isPublic }` 走 `isInstanceAdmin` 门禁（广场 owner 可翻转任意 server 的公共标记）
3. **广场可退** ✅（2026-09-19 修订，原「不可退」废除）：member 可退任意 server 含 `is_public` 广场——`GET /api/orgs/discover` 发现面落地后退出不再失联，卡片回发现面可经 `POST /orgs/:id/join` 再加入；owner 拒退规则不变（与 §4 表口径一致）
4. **存量 admin 显示为「成员」** ✅：WorkspaceMembers `roleLabel(admin)` → 成员；角色指派下拉整体移除

## 10. 第二批落地（2026-09-18 同日追加）

### 10.1 初始频道 = 私有 `onboarding-owner`（✅ 已落地，用户 server 全口径）

- **`POST /api/orgs` 与 `getOrCreatePersonalOrg` 同口径**：用户主动建服和 personal 兜底空间都只建 **`type='private'` 的 `onboarding-owner`**（owner 的私有引导频道），不再建公开 `#general`——「个人 server」= 所有非公共 server，初始频道统一
- `getOrCreatePersonalOrg` 整体包进事务：server + owner member 行 + 频道 + owner 的 channel_members 行一次成形
- **幂等**：ensure 对新旧 personal org 都跑——`GET /api/orgs` 每次调用本函数，存量空间惰性补建，无需迁移；并发竞态由 `idx_channels_server_name` 唯一索引 + `ON CONFLICT DO NOTHING` 吸收（postgres.js 事务内不能 catch 23505 续跑，冲突跳过 + 重 SELECT 是等价做法）
- 私有频道只对 channel_members 可见：之后拉进 server 的其他成员看不到它，团队频道由 owner 另建（`POST /channels` owner-only）
- 存量用户 server 的 `general` 频道保留不动（已是正常公开频道）
- **落点统一**：新增 `channelStore.resolveLandingChannel(sid, preferred)`（preferred → localStorage lastChannel → 频道列表首项 → general 兜底）；UserAvatarButton 切服、AppLayout 三个 watcher、ChatPane 退/删后落点、OnboardingServerPage、InviteAcceptPage、MobileTabBar、SidebarRail、ChannelView 全部改走 helper——personal server（无 general）落地不再 404，`/channels/general` 字面量经 watcher 统一修正

### 10.2 私信 server 归属（✅ 已落地）

- **Bug 根因**：`GET /channels/dms` 无 server 过滤 + dm 频道统一落广场 → 任何 server 下私信区列同一份全局列表（新建 server「带着私信记录」）
- **修复口径**：
  - `/dms`：显式租户（x-server-id）时过滤 `c.server_id = <active>`；非该 server 成员 → 403；无租户头的旧调用方维持全局列表（兼容）
  - `getOrCreateDmChannel` 落点（仅新建时定死，`dm_<idA>_<idB>` 全局唯一）：有 agent 一方 → agent 所属 server；human↔human 三级——① 调用方语境 server 且双方均成员 → ② 双方共有的最早**非 personal 且非 is_public** server（广场全员共有，计入会使该级恒命中广场，故排除）→ ③ 默认社区兜底
  - 前端 ChatPane 私信 watch 源加 `activeServerId`：切 server 重拉
- **已知取舍**：对端退出 dm 所在 server 后其 /dms 在该语境不再列出（channel_members 行仍在，直接访问与重回 server 不受影响）
- 测试：`test/dms-scope.test.ts` 4 用例（跨 server 隔离核心断言、共有私有社区优先、agent DM 回归、非成员 403）

### 10.3 成员管理融合进侧边栏成员页（✅ 已落地）

评估结论：管理面**必须有出口**（移除成员/转让所有权/邀请链接 CRUD/personal org 增删当时仅此一处），但载体从设置页换到**活跃 server 语境天然一致的 PeopleView**——同时消掉了 `OrgMembersPanel` 只对 personal org 做直拉的不对称。

- **PeopleView 数据源**：humans 列表从 `/api/server/info` 换 `/api/orgs/:sid/members`（新增 `avatar_url` 列）——成员可读，带 `role`/`user_id` 支撑管理操作；成员行显示 `所有者/成员` 角色与「（我）」标记
- **owner 行内操作**（hover，与 agent 移出同模式）：Crown 转让 + X 移除，均走 ConfirmDialog；转让后 `serverStore.fetchOrgs()` 刷新，`isServerOwner` 翻 false 面板自动收起
- **owner 邀请面板**（成员区头部 UserPlus 图标展开）：handle 直拉（任意 owned server，替代 OrgMembersPanel）+ 邀请链接生成/复制/吊销（用量/过期显示）
- **退役**：`WorkspaceMembers.vue` + `OrgMembersPanel.vue` 删除；`/settings/members`、`/admin/members` 重定向 `/people`；SettingsLayout 导航项、AppLayout 标题/高亮、MobileTabBar 检测、ChatPane 服务菜单「成员管理」、OnboardingChecklist「去邀请」全部改指 `/people`；PeopleView 页头「管理」菜单仅剩「我的计算机」直达按钮
