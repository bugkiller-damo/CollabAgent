# Slock Web 视觉对齐 Raft（界面靠近方案）

> 日期：2026-08-22
> 状态：**已废弃（2026-08-23）**。用户明确不仿 Raft UI 风格。未改视觉代码，勿按本文实施。信息架构仍以 `01-web-two-column-sidebar-design.md` 为准。
> 对照实现：`packages/web` 现网（刚落地的两列 rail + pane，见 `01-web-two-column-sidebar-design.md`）
> 对照产品：[app.raft.build](https://app.raft.build) 频道页
>   `https://app.raft.build/s/bugkillers-test-server/channel/fcaef039-f4e6-446b-b8e2-304144a81e6f`
> 官方说明：[docs.raft.build](https://docs.raft.build/llms.txt)、[raft.build](https://raft.build)

审查通过后再动 CSS / 组件。本文只定「看起来像 Raft」要改什么、先改哪、明确不抄什么。

---

## 0. 取证说明（读之前先看这）

频道 URL 是 **登录后的 React SPA**（`#root` 空壳 + `/assets/index-*.js`）。无会话时抓不到真实像素，本文不是截图像素还原，依据是：

1. **应用 CSS 设计 token**（`index-EQxYM8hQ.css` 的 `:root`：brutal 色板、阴影、字体、layer）
2. **应用 i18n**（`layout.leftRail.*` / `layout.sidebar.*`：rail 标签、聊天 pane 分段）
3. **公开文档的信息架构**（Activity / Search / Channels / Tasks / Members）
4. **营销站视觉语言**（Space Grotesk + Space Mono、theme-color `#FFD440`、2px/4px 硬阴影）

结论足够做视觉对齐；个别间距/圆角以你本机打开该频道页为准，审查时对照截图微调数字即可。

Slock 与 Raft 是同一产品线（2026-06 上海 meetup 记录过 Slock → Raft 更名）。对齐的是 **Raft 1.0 的 AX 工作台 chrome**，不是另做一套皮肤。

---

## 1. Raft 工作台骨架（要靠近的目标）

URL 形态：`/s/{server-slug}/channel/{channel-uuid}` —— 工作区是 **server**，主列是 **频道**。

```
┌─ ~56px ─┬─ ~240px ─┬──────────── 主列 ────────────┬─ 可选右栏 ─┐
│ 工作区    │ pane 标题  │ 频道头：#name · 成员数 · 🔍  │ 线程 /     │
│ 头像/字母 │            │ live-agent-activity-bar     │ 成员图     │
│           │ Pinned     │ ─────────────────────────── │            │
│ 🔍 Search │ Channels   │ 消息流（人/agent 同一套气泡） │            │
│ 💬 Chat   │   #all     │                             │            │
│ ⚡ Activity│   #…       │ composer（可勾 As Task）     │            │
│ ✅ Tasks  │ Direct Msgs│                             │            │
│ 👥 Members│            │                             │            │
│ 💻 Computers│           │                             │            │
│ ☆ Saved  │            │                             │            │
│           │            │                             │            │
│ ? Help    │            │                             │            │
│ ⚙ Settings│            │                             │            │
│ 头像      │            │                             │            │
└───────────┴────────────┴─────────────────────────────┴────────────┘
     left rail              sidebar pane                    main
```

和我们刚做的两列 **同构**：rail 常驻、pane 可折（再点当前图标折叠，`layout` 代码：`activeItem===se && !collapsed → collapse`）。这是最大的结构红利，视觉对齐不必再改信息架构。

Rail 标签（应用 i18n，中英都有）：

| 键 | 文案 | Slock 现状 |
|----|------|------------|
| Search | 搜索 | 有 |
| Chat | 聊天 | 有（默认） |
| Activity | 动态 | 有 |
| Tasks | 任务 | 有 |
| Members | 成员 | 有 |
| Computers | 计算机 | **无**（接入向导 / daemon 散落） |
| Saved | 已收藏 | **无** |
| Humans | 人类 | 并进成员 pane |
| Help | 帮助 | **无** |
| Settings | 设置 | 有（齿轮） |
| Wiki | Wiki | **不做**（非目标） |

聊天 pane 分段（Raft）：**Pinned / Channels / Direct Messages**（另有 Joint Channels）。排序：Manual / Recent / A-Z。公开+私有合在 Channels，锁图标区分，不拆「私有频道」第二节。

主列：频道头 + **live-agent-activity-bar**（agent 正在干什么，贴在消息流顶，不是顶栏一条灰字）。消息与任务是同一对象（「As Task」勾选发送）。右侧线程面板可开。

移动底栏（Raft）：Home / Tasks / Members / Settings。我们现在是 聊天 / 动态 / 任务 / 成员 —— 可后对齐，不挡第一批视觉。

---

## 2. 视觉语言（Brutal Signal）

Raft 不走 Slack 紫 / Discord 灰黑。营销站和 app 共用一套 **新野兽派（neo-brutalism）**：

- 底：近白奶油，不是冷灰
- 字：近黑暖墨 `#141111`，不是纯 `#000` / Tailwind `gray-900`
- 强调：明黄 `#FFD440`（theme-color、PWA 背景、主按钮、未读点）
- 边：真黑 1px 线，不是 1px `#e5e7eb`
- 阴影：**实心偏移** `4px 4px 0 #141111`，不是 blur drop-shadow
- 圆角：小（sm 4 / md 6 / lg 8），卡片不「药丸化」
- 字体：展示 Space Grotesk（`--font-display`），等宽 Space Mono，正文 system-ui

### 2.1 色板（从 app CSS 抽出，实施时做成 Tailwind theme / CSS 变量）

**品牌色（brutal）**

| Token | Hex | 用途 |
|-------|-----|------|
| `--color-brutal-yellow` | `#FFD440` | 主按钮、未读点、焦点环、工作区模式激活 |
| `--color-workspace-mode-active` | `#E3B100` | 进入 workspace 模式的压下态 |
| `--color-brutal-black` | `#141111` | 文字、描边、硬阴影 |
| `--color-brutal-cream` | `#FFFAEF` | 画布微暖底（layer-inset / card 更暖） |
| `--color-brutal-pink` | `#FE7DA8` | accent：提及、@、部分 badge |
| `--color-brutal-cyan` | `#27CCF3` | info / agent 活动 |
| `--color-brutal-orange` | `#F8A16F` | 警告软强调 |
| `--color-brutal-lime` | `#A9D877` | 在线 / 成功软底 |
| `--color-brutal-red` | `#F97264` | 危险 |
| `--color-brutal-lavender` | `#BBAFE6` | 次强调（线程、标签） |
| `--color-brutal-stone` | `#C0B9B1` | 次级填充 |

**层（浅色默认，app `:root`）**

| Token | 语义 | 约值 |
|-------|------|------|
| `--layer-canvas` | 主列聊天底 | 纯白 |
| `--layer-panel` | rail / pane | 纯白（不是我们的 `bg-gray-100`） |
| `--layer-inset` | 输入框、嵌入 | oklch(99% …) 微暖 |
| `--layer-card` | 卡片 | oklch(98.5% …) |
| `--layer-hud` | 深色 HUD / 代码 | 暗紫黑 |
| `--line` / `--line-strong` | 分割线 | 墨色实线 |
| `--line-hairline` | 弱分割 | 墨 15% |
| `--foreground` | 正文 | oklch(18% …) ≈ `#141111` |
| `--foreground-muted` | 次文 | 正文 60% |
| `--foreground-hint` | 更弱 | oklch(48% 0 0) |

**阴影**

```
--shadow-brutal:    4px 4px 0px #141111;
--shadow-brutal-lg: 6px 6px 0px #141111;
--shadow-workspace-mode-active: inset 3px 3px 0px #14111159;
```

按钮交互（营销 CSS 同款）：hover 时阴影缩小、元素 `translate(-1px,-1px)`；active 再压下去。**不要**用 Tailwind `shadow-md` 的模糊阴影冒充。

深色模式：Raft 默认浅色奶油；有 HUD/代码深色块，但工作台本体是浅的。Slock 现在默认 `uiStore` dark。对齐 Raft = **默认改浅色**，深色作为可选（可后做一套 brutal-dark，第一批不要两边都糊）。

### 2.2 字体

```
--font-display: "Raft Quote Glyphs", "Space Grotesk", system-ui, sans-serif;
--font-mono:    "Space Mono", ui-monospace, monospace;
正文:           system-ui / --sans-font
```

「Raft Quote Glyphs」是他们的私有展示字体，**不要拷贝**。Slock 用 **Space Grotesk + Space Mono**（Google Fonts 可合法加载）。

字重习惯：section label `uppercase` + `tracking-wider` + 接近 black（Activity 的 “Show all” 用 `font-black` / 10px）。侧栏组标题不是我们现在的 `text-xs font-semibold text-gray-500`。

### 2.3 控件皮肤（从 `data-slot` 反推）

应用里的槽位直接对应组件，对齐时按槽改，不要开新体系：

| data-slot | 含义 | Slock 对应 |
|-----------|------|------------|
| `app-rail-item` | rail 图标按钮：`min-w-9 p-3 rounded-md`，hover `fill-strong` | `SidebarRail` 按钮 |
| `sidebar-group-label` | pane 分段标题，uppercase | `SidebarSection` |
| `sidebar-item-title` / `subtitle` / `meta-icon` | 频道行 | `ChatPane` 行 |
| `sidebar-live-activity` | 频道行上的 agent 活动点 | 无 |
| `live-agent-activity-bar` | 主列顶 agent 进度条 | `AgentProgressBar`（位置应下移到频道头下） |
| `composer-*` | 输入区附件 | `MessageComposer` |
| `task-card` / `task-status-icon` | 看板卡片 | `TaskBoard` |
| `inbox-item-*` | Activity 行 | `ActivityPane` |
| `notification-center-trigger` | 通知中心（Raft 仍有，但 Activity 才是一级） | 已从顶栏拿掉，保持 |
| `panel-*` | 右栏线程/设置面板 | 线程页 / 成员抽屉 |
| `kbd` | 快捷键胶囊 | ⌘K 提示 |

Rail 项 CSS 片段（已验证）：透明 1px 边、`rounded-md`、图标 16px、字 13px、hover 实心浅填。**选中态**应是黄底或 inset brutal 阴影，不是我们现在的 `bg-gray-200`。

---

## 3. 和 Slock 现状的差距

### 3.1 已经同构（只换皮）

- 两列：56px rail + 240px pane + 可折叠
- 五个一级入口：搜索 / 聊天 / 动态 / 任务 / 成员
- ⌘K 搜消息、⌘B 折 pane
- 任务 pane + 整页看板
- 成员 pane：Agent / 人 + 深链
- 顶栏铃铛已删，未读在 rail 角标

### 3.2 视觉差（第一批要改，用户「看起来像」主要靠这）

| 点 | Raft | Slock 现在 |
|----|------|------------|
| 默认主题 | 浅色奶油 + 墨线 | 默认 dark + 冷灰 |
| 侧栏底 | 白 `layer-panel` | `bg-gray-100` / `gray-800` |
| 主色 | `#FFD440` | Tailwind `blue-600` |
| 描边 | `#141111` 实线 | `border-gray-200` |
| 阴影 | 4px 硬偏移 | 几乎无 / 模糊 |
| 选中 rail | 黄 / inset | 灰底 |
| 未读 | 黄点或黑底黄字 | `bg-blue-500` 药丸 |
| 字体 | Space Grotesk 标题 | 系统默认 |
| 工作区头 | 可点切 server | 蓝底「C」装饰 |
| 顶栏 | 薄、并进频道头 | `h-12` 白条 + 面包屑，和频道 `PageHeader` **双顶栏** |
| Agent 进度 | 消息流顶 `live-agent-activity-bar` | 顶栏中段 / 独立条 |
| 私有频道 | 锁图标，仍在 Channels 一段 | 单独「私有频道」section |
| Composer | 白底、硬边、可 As Task | 灰输入、无任务勾选入口 |
| 消息气泡 | 人/agent 同一排版，agent 仅头像/名字区分 | 基本接近，配色偏蓝灰 |

### 3.3 产品面差（第二批，不挡换皮）

| Raft | Slock |
|------|--------|
| Pinned 段 + 拖拽排序 | 无 |
| Saved | 无 |
| Computers 一级入口 | `/connect` 向导 |
| `#all` 内置全员频道 | `#general` + `#random` 种子 |
| 路由 `/s/{slug}/channel/{uuid}` | `/channels/:name` |
| 右栏线程面板 | 独立 `ThreadView` 换页 |
| 成员关系图 Graph | 无 |
| 频道行 live activity 点 | 无 |
| 通知中心与 Activity 分离（推 vs 拉） | Activity = 通知列表 |

路由和 `#all` **不要**为了像而改数据模型。视觉像 ≠ URL 像。

---

## 4. 推荐对齐原则

1. **抄 chrome，不抄品牌资产。** 色、阴影、字、间距、组件皮肤可以靠；Logo / 「Raft Quote Glyphs」/ 吉祥物像素人 / 文案 slogan 不靠。
2. **浅色是 Raft 的产品脸。** 第一批强制默认 light；dark 另开 token，别用现在的 `dark:bg-gray-800` 硬翻。
3. **蓝 → 黄。** 所有 `blue-600` 主行动、未读、焦点、rail 选中，改 brutal-yellow + ink 边。链接/info 可用 cyan，别再用蓝当品牌色。
4. **双顶栏必须拆掉。** `AppLayout` 的 `h-12` 与 `ChannelView` `PageHeader` 叠两层，这是和 Raft「频道即主列头」差距最大的结构问题，换皮时一起收。
5. **Chat pane 分段向 Raft 靠：Pinned（可空）+ Channels + Direct Messages。** 取消「私有频道」独立 section，锁图标留在行内（文档 Q7-B）。
6. **Computers / Saved / Help 第一批只占位或不做。** 用户要的是「界面靠近」，不是功能对标完整 Raft。

---

## 5. 分批（审查勾选）

### P0 — 换皮（看起来已经是 Raft 工作台）

不做新功能。

1. **Token 文件** `packages/web/src/styles/tokens.css`（或扩 `tailwind.config`）
   - 写入 §2.1 色 / 阴影 / 层
   - `primary` = brutal-yellow，`ink` = `#141111`
2. **默认主题改 light**；`initTheme()` 无 localStorage 时走 light
3. **引入 Space Grotesk + Space Mono**（`index.html` 或 CSS `@import`）
4. **全局边框 / 按钮 / 输入**
   - 边：`border-ink` 1px
   - 主按钮：黄底、黑字、硬阴影；hover 位移
   - 次按钮：白底黑边
   - 输入：白底、黑边、focus 黄环（不要蓝 ring）
5. **Rail + Pane 皮肤**
   - 白底、墨线分割
   - `app-rail-item` 选中：黄底或 inset 阴影
   - 未读角标：黄底黑字或纯黄点
   - section label uppercase + tracking
6. **拆双顶栏**
   - `AppLayout` 桌面不再画独立 `h-12`（标题交给各页自己的频道头）
   - `ChannelView` / `DmView` 头做成 Raft 式：`#name` + 成员数 + 设置，下面一条 `live-agent-activity-bar`（把现 `AgentProgressBar` 挪下来）
7. **Chat pane 合并公私频道**（锁图标保留）

验收：打开 `#代码项目`，未登录设计稿级别即可判断——白、黄、硬边、无蓝、无双顶栏、rail 选中是黄。

### P1 — chrome 细节（更像）

- Composer：硬边容器 + 「As Task」勾选（勾选走现有 `/api/tasks` 发送路径，若已有则接线，没有就只做 UI 勾并 POST 现接口）
- 消息行：去掉蓝链/蓝按钮残留；agent 名用 ink，在线点用 lime
- TaskBoard 列头：硬边卡片，状态色用 brutal 红/黄/青/lime，不要 Tailwind 默认蓝
- Activity 行：提及粉点；未读黄条
- 工作区头：方块字母 + 可下拉（单 server 也做成 Raft 的 switcher 皮，列表一项即可）
- Tooltip / Modal / Confirm：硬阴影

### P2 — 结构功能（可选，另开设计）

- Pinned 段 + 拖拽
- Saved
- Computers 一级（把 `/connect` 收进 pane）
- 右栏线程（不换页）
- 频道行 live-activity 点
- 移动底栏改 Home/Tasks/Members/Settings

P2 不在「界面靠近」必做范围。

---

## 6. 不做什么

- 不替换产品名/Logo 为 Raft
- 不引入「Raft Quote Glyphs」或他们的像素吉祥物
- 不改后端路由为 `/s/:slug/channel/:uuid`
- 不把 `#general` 强行改名为 `#all`（种子频道是数据问题）
- 不在第一批做完整 dark brutal 主题
- 不把 Admin / Metrics 塞进 rail（Raft 也是 Settings 里的 Workspace 组）

---

## 7. 建议的 token 落点（实施备忘）

```
packages/web/
  index.html                 + Space Grotesk / Space Mono
  src/styles/tokens.css      新建：:root 变量
  tailwind.config.js         映射 brutal / ink / cream
  src/stores/uiStore.ts      默认 theme light
  src/components/ui/Button.vue / Input.vue / Modal.vue / IconButton.vue
  src/components/layout/SidebarRail.vue / SidebarPane.vue / SidebarSection.vue
  src/components/layout/AppLayout.vue     去掉桌面双顶栏
  src/pages/ChannelView.vue / DmView.vue  频道头 + activity bar
  src/components/chat/MessageComposer.vue
  src/components/agent/AgentProgressBar.vue  位置
```

不新增 UI 框架。继续 Tailwind + 现组件。

---

## 8. ASCII 目标态（P0 完成后）

```
│■│ 聊天                    │ #代码项目          3  · ⚙
│🔍│                         │ ────────────────────────────────
│💬│ 频道                    │ 🟡 @coder  正在读 src/cli.ts
│⚡│  # general              │
│✅│  # 产品讨论             │  bugkiller  10:21
│👥│  🔒 product             │  把巡检间隔改成 2h
│  │  # 代码项目         •   │
│  │ 私信                    │  coder  10:22
│⚙│   alice                 │  好，我改 reminders…
│☺│
    白底 墨线 黄选中              单层频道头，无灰蓝顶栏
```

---

## 9. 请拍板

**V1.** 默认浅色？  
- A（推荐）：是，跟 Raft。  
- B：保持深色默认，只在 light 下用 brutal。

**V2.** 主色黄 `#FFD440` 是否可接受（品牌仍叫 Slock）？  
- A（推荐）：可，这是工作台脸，不是改名。  
- B：黄只做强调，主按钮仍用墨色填充。

**V3.** 双顶栏：桌面 `AppLayout` 头去掉，频道头自己扛？  
- A（推荐）：去掉。  
- B：保留一条极薄状态条（只放离线警告 + agent 进度）。

**V4.** Chat pane 公私合并？  
- A（推荐）：合并 + 锁图标。  
- B：保持两段。

**V5.** 第一批是否包含 Composer「As Task」勾选？  
- A：P0 只换皮，勾选放 P1。  
- B：P0 一起做。

默认按 V1A / V2A / V3A / V4A / V5A。通过后从 P0 token + 拆顶栏开工。

---

## 来源

- [Raft 应用](https://app.raft.build/s/bugkillers-test-server/channel/fcaef039-f4e6-446b-b8e2-304144a81e6f)
- [Raft 官网](https://raft.build)（「聊天就是工作空间」）
- [docs.raft.build/llms.txt](https://docs.raft.build/llms.txt)
- [Catch up in one place](https://docs.raft.build/catch-up-in-one-place.md)（Activity）
- [Search your raft](https://docs.raft.build/search-your-raft.md)（⌘K）
- [Channels](https://docs.raft.build/features/messaging/channels.md)
- [Activity](https://docs.raft.build/features/messaging/activity.md)
- [Members](https://docs.raft.build/features/server/members.md)
- 应用 CSS token / `layout.leftRail.*` i18n（2026-08-22 包 `index-EQxYM8hQ.css` / `index-WTraJnrd.js`）
