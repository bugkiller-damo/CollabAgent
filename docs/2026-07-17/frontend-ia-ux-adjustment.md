# Slock 前端页面层级与 UI 一致性调整方案

> 日期：2026-07-17  
> 范围：`packages/web/src/` 页面结构、导航层级、通用组件、视觉一致性  
> 目标：让页面层级对用户更友好，降低认知负荷，统一跨页面体验

---

## 一、现状诊断

### 1.1 信息架构：侧边栏功能平铺，层级模糊

当前 `Sidebar.tsx` 把「频道」「功能」「私信」「系统入口」四类信息堆叠在同一列，缺乏视觉分组：

- 顶部只有一个品牌标题，没有 workspace/组织层级。
- 「任务看板」「接入 Agent」「管理后台」「设置」「退出登录」全部挤在底部或混在列表里。
- 使用 emoji（📋、🔌、🛠️、⚙️）作为图标，风格与品牌标题不一致，显得临时。
- 未读徽章只出现在频道，缺少对「@ 提及」「系统通知」的入口强化。

### 1.2 页面标题：每个页面各自实现，缺乏统一入口标识

| 页面 | 标题实现 | 问题 |
|------|----------|------|
| `ChannelView` | 内联 `h2 + description + 按钮` | 与 `DmView`、`TaskBoard` 样式不同 |
| `DmView` | 头像 + h2 + handle | 头像尺寸、字体粗细与 ChannelView 不一致 |
| `TaskBoard` | h2 + 下拉选择 + 输入框 | 缺少当前位置的面包屑/返回 |
| `ThreadView` | h2 "Thread" + in #channel | 英文标题，与中文界面脱节 |
| `AdminPanel` | 顶部 tab + 根页卡片 | tab 与卡片重复，根页缺乏dashboard感 |
| `SettingsLayout` | 左侧菜单 | 菜单无图标、active 样式在深/浅主题下不一致 |

### 1.3 视觉一致性：调色板与组件风格碎片化

- 背景色深浅不统一：`bg-gray-50`、`bg-gray-100`、`bg-gray-200` 在不同页面混用。
- 卡片圆角不统一：有 `rounded`、`rounded-lg`，同一页面内也有差异。
- 按钮样式重复：几乎每个页面都手写 `bg-blue-600 text-white px-4 py-2 rounded`。
- 输入框样式重复：`inputCls` 在 `ConnectWizard`、`DmView` 等文件里各自定义。
- 深色模式：`SettingsLayout` 的菜单写死 `dark:bg-gray-900` 背景，在浅色主题下 still 使用 `text-white`，导致对比异常。

### 1.4 交互体验：缺少统一的状态反馈与空状态

- 空状态 `EmptyState` 已被提取，但部分页面仍内联手写（如 `DmView` 的 error 页面）。
- 移动端 header 只有汉堡按钮，没有显示当前页面标题，用户切页后不知道在哪。
- `AppLayout` header 里 `SearchBar` + `NotificationBell` 缺少间距规范。
- 消息输入框在 `ChannelView`、`DmView`、`ThreadView` 三个地方重复实现，行为略有差异。

---

## 二、调整目标

1. **清晰的信息架构**：把侧边栏分为「工作区」「协作对象」「系统」三层。
2. **统一的页面头部**：每个页面使用 `<PageHeader>`，统一标题、面包屑、操作区。
3. **一致的视觉语言**：提取 `<Button>`、`<Input>`、`<Card>`、`<Avatar>` 等基础组件。
4. **强化页面层级**：通过面包屑、返回按钮、tab 分组让用户知道「在哪」和「能去哪」。
5. **减少 emoji 图标**：使用简洁的 SVG 图标（或文字+色块）替代 emoji，保持专业感。
6. **移动端友好**：header 显示当前页面标题，侧边栏分组更易于触摸。

---

## 三、信息架构重组

### 3.1 侧边栏分组（新）

```
┌─ Sidebar ─────────────────────┐
│  CollabAgent                    │  ← 点击可展开 workspace 切换（预留）
│  ─────────────────────────────  │
│  📁 频道                        │  ← 当前加入的频道列表
│    # general                    │
│    # dev                        │
│    + 新建频道                   │
│  ─────────────────────────────  │
│  💬 私信                        │  ← DM 列表
│    @agent-one                   │
│    @human-two                   │
│    + 新私信                     │
│  ─────────────────────────────  │
│  🧩 应用                        │  ← 功能入口
│    任务看板                     │
│    接入 Agent                   │
│  ─────────────────────────────  │
│  ⚙️ 管理                        │  ← 系统入口
│    管理后台                     │
│    设置                         │
│    退出登录                     │
└─────────────────────────────────┘
```

### 3.2 顶部 Header（新）

```
┌─ Top Header ──────────────────┐
│  ☰  当前页面标题 / 面包屑    [🔍] [🔔] [👤]  │
└─────────────────────────────────┘
```

- 桌面端左侧标题区显示当前页面名称 + 可选面包屑。
- 搜索、通知、用户头像/菜单放在右侧。

### 3.3 Admin 管理后台

- 保留左侧二级导航（Agent / 频道 / 成员 / 指标）。
- 根路径 `/admin` 改为「管理概览」dashboard，展示 4 个入口卡片 + 关键统计数字。
- 子页面顶部使用 `<PageHeader title="Agent 管理" breadcrumb={['管理后台', 'Agent 管理']} />`。

### 3.4 设置页面

- 左侧菜单改为图标 + 文字，统一 active 样式（浅色下用 `bg-gray-200 text-gray-900`，深色下用 `bg-gray-700 text-white`）。
- 子页面顶部使用 `<PageHeader title="个人资料" />`。

---

## 四、组件拆分计划

| 新组件 | 位置 | 职责 |
|--------|------|------|
| `PageHeader` | `components/layout/PageHeader.tsx` | 统一页面标题、面包屑、操作按钮、返回按钮 |
| `Breadcrumb` | `components/layout/Breadcrumb.tsx` | 路径面包屑，支持点击跳转 |
| `IconButton` | `components/ui/IconButton.tsx` | 图标按钮，统一 hover/active/disabled |
| `Button` | `components/ui/Button.tsx` | 基础按钮，支持 variant/size/loading |
| `Input` | `components/ui/Input.tsx` | 基础输入框，深色模式一致 |
| `Card` | `components/ui/Card.tsx` | 卡片容器，统一背景/圆角/阴影 |
| `Avatar` | `components/ui/Avatar.tsx` | 头像，支持图片/首字母/在线状态点 |
| `MessageComposer` | `components/chat/MessageComposer.tsx` | 统一消息输入框（@mention、附件、拖拽、快捷键） |
| `SidebarSection` | `components/layout/SidebarSection.tsx` | 侧边栏分组标题 + 子项 |
| `NavItem` | `components/layout/NavItem.tsx` | 侧边栏/设置菜单项，统一 active/hover |

---

## 五、页面级改动清单

### 5.1 全局

- `App.tsx`：保持路由结构，删除 `SettingsPlaceholder` 死代码。
- `AppLayout.tsx`：header 增加当前页面标题/面包屑渲染；整合 `AgentThinkingBanner` 与离线提示。
- `index.css`：补充 CSS 变量或 Tailwind 插件，统一卡片/按钮 token（如 `--surface`、`--border`）。

### 5.2 Sidebar

- 用 `<SidebarSection>` 替换平铺结构。
- 底部操作区整合到「系统」分组。
- 使用 SVG 图标（通过内联 `<svg>` 或 `lucide-react`）替代 emoji。
- 未读徽章扩展到私信条目。

### 5.3 ChannelView

- 顶部改用 `<PageHeader>`：左侧 `#channelName` + description，右侧「成员」「设置」「看板」图标按钮。
- 消息输入区改用 `<MessageComposer>`。
- 成员面板、设置弹窗保持现有触发方式。

### 5.4 DmView

- 顶部改用 `<PageHeader>`：左侧 `<Avatar>` + 名称 + handle，右侧显示 Agent 标签。
- 消息输入区改用 `<MessageComposer>`。

### 5.5 TaskBoard

- 顶部改用 `<PageHeader>`：标题「任务看板」+ 频道选择器 + 新建任务按钮。
- 增加返回当前频道的面包屑链接。
- 看板列标题使用统一卡片样式。

### 5.6 ThreadView

- 顶部标题改为中文「线程」，使用 `<PageHeader>` + 面包屑返回频道。
- 父消息与回复的分隔线使用更清晰的「N 条回复」标签。
- 回复输入区改用 `<MessageComposer>`。

### 5.7 AdminPanel / 子页面

- 根页改为 dashboard：4 张入口卡片 + 关键数字（Agent 在线数、频道数、成员数、今日消息数）。
- 子页面使用 `<PageHeader>` + 面包屑。
- `AgentManagement` 表单使用 `<Card>` + `<Input>`。

### 5.8 SettingsLayout / 子页面

- 左侧菜单使用 `<NavItem>` + 图标。
- 子页面使用 `<PageHeader>`。
- 修复深色模式 active 样式。

### 5.9 ConnectWizard

- 已经是步骤向导，结构较好。
- 统一输入框使用 `<Input>`，按钮使用 `<Button>`。
- 成功后的「进入频道」改为 `<Button as={Link}>`。

### 5.10 LoginPage / RegisterPage

- 使用 `<Card>` 包装表单。
- 输入框、按钮使用统一组件。
- 修复登录按钮文字在深色模式下对比度不足（当前 `text-gray-900 dark:text-white` 在 `bg-blue-600` 上深色下变为白色，正常；但 hover 后 `bg-blue-500` 仍可读）。

---

## 六、设计 token 建议

在 `tailwind.config.js` 中不新增插件的前提下，约定以下 Tailwind 组合：

| Token | 浅色 | 深色 | 用途 |
|-------|------|------|------|
| surface | `bg-white` | `dark:bg-gray-900` | 页面背景 |
| surface-elevated | `bg-gray-50` | `dark:bg-gray-800` | 卡片/面板背景 |
| surface-hover | `hover:bg-gray-100` | `dark:hover:bg-gray-700` | 列表 hover |
| border | `border-gray-200` | `dark:border-gray-700` | 分割线/边框 |
| text-primary | `text-gray-900` | `dark:text-white` | 主文字 |
| text-secondary | `text-gray-500` | `dark:text-gray-400` | 次文字 |
| accent | `bg-blue-600` | `dark:bg-blue-600` | 主按钮 |
| danger | `text-red-500` | `dark:text-red-400` | 危险操作 |

---

## 七、实施顺序

1. **阶段 1：基础组件**（影响小，收益高）
   - 创建 `Button`、`Input`、`Card`、`Avatar`、`PageHeader`、`Breadcrumb`、`NavItem`。
2. **阶段 2：布局骨架**
   - 重构 `Sidebar` 分组 + `AppLayout` header。
3. **阶段 3：页面头部统一**
   - 为 `ChannelView`、`DmView`、`TaskBoard`、`ThreadView`、`AdminPanel`、`SettingsLayout` 引入 `PageHeader`。
4. **阶段 4：输入框统一**
   - 用 `MessageComposer` 替换 ChannelView / DmView / ThreadView 的输入区。
5. **阶段 5：细节打磨**
   - 清理 emoji、统一圆角、修复深色模式、补齐空状态。

---

## 八、验证标准

- `npx tsc --noEmit -p packages/web/tsconfig.json` 通过。
- 所有页面在浅色/深色主题下无明显对比异常。
- 侧边栏在桌面端和移动端（<=1024px）均可正常展开/收起。
- 页面标题在移动端 header 正确显示。
- 不引入新的运行时依赖。

---

*本方案优先解决「页面层级不友好」和「视觉一致性」问题，功能增强（如打字指示、消息分组）不在本次范围内。*

---

## 九、实施记录（2026-07-17）

### 已完成

1. **新增基础组件**（`packages/web/src/components/ui/` 与 `components/layout/`）
   - `Button` / `IconButton`：统一主/次/幽灵/危险样式与 loading 状态。
   - `Input` / `Textarea`：统一输入框深/浅主题。
   - `Card`：统一卡片容器。
   - `Avatar`：统一头像 + 在线状态点。
   - `PageHeader` / `Breadcrumb`：统一页面标题、面包屑、操作区。
   - `NavItem` / `SidebarSection`：统一导航项与侧边栏分组。
   - `MessageComposer`：统一消息输入（@mention、附件、拖拽、粘贴、快捷键）。

2. **布局重构**
   - `Sidebar` 改为「频道 / 私信 / 应用 / 系统」四层分组；用 SVG 图标替代 emoji；保留未读徽章。
   - `AppLayout` header 在移动端显示当前页面标题/副标题，桌面端显示路径；增加用户头像入口。
   - `main.tsx` 移除重复的主题初始化逻辑。

3. **页面头部统一**
   - `ChannelView`、`DmView`、`TaskBoard`、`ThreadView`、`AdminPanel` 及各子页面、`SettingsLayout` 子页面均接入 `PageHeader`。
   - `ThreadView` 标题改为中文「线程」并增加返回面包屑。
   - `AdminPanel` 根页改为「管理概览」dashboard，顶部使用 `NavItem` tab。

4. **输入区统一**
   - `ChannelView`、`DmView`、`ThreadView` 均使用 `MessageComposer`。
   - `ChannelView` 保留全局拖拽上传，通过受控 attachments 与 `MessageComposer` 协同。
   - `DmView` 修复滚动到底部的「近底部判断」，避免阅读历史时被自动拽走。

5. **认证页统一**
   - `LoginPage`、`RegisterPage`、`ForgotPasswordPage` 使用 `Card` / `Input` / `Button`。
   - 登录/注册增加 loading 状态。

6. **深色模式修复**
   - `SettingsLayout` 左侧菜单改为深/浅自适应。
   - 各页面统一使用 `dark:` 前缀，无硬编码深色背景在浅色主题下失效的问题。

7. **其他**
   - `App.tsx` 删除 `SettingsPlaceholder` 死代码。
   - `EmptyState` 按钮样式微调和圆角统一。

### 验证结果

- `pnpm exec tsc --noEmit` ✅ 通过。
- `pnpm run build` ✅ 通过。
- 未引入新的运行时依赖。

### 未在本次处理（后续可继续）

- 消息分组（连续同发送者合并）。
- 打字指示、桌面通知、音效。
- 频道搜索/过滤、全局文件浏览器、Pin 消息。
- `ThreadView` 回复复用 `MessageRow`（涉及数据结构对齐）。
- 完整的无障碍（aria-live、focus 管理、 prefers-reduced-motion）。

