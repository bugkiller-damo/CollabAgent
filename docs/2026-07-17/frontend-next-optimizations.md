# Slock 前端下一波优化方向：返回导航与动画体验

> 日期：2026-07-17  
> 范围：`packages/web/src/` 的返回导航、页面转场、微交互、动画一致性  
> 目标：让页面返回更自然、状态变化更有节奏感，降低用户在复杂层级中的迷失感

---

## 一、当前状态速览

经过上一轮重构后，前端已具备统一的基础组件（`Button`、`Card`、`PageHeader`、`MessageComposer` 等）和清晰的页面层级。但在「返回导航」和「动画」两个维度仍有明显打磨空间：

| 维度 | 现状 | 问题 |
|------|------|------|
| 返回导航 | 仅 `ThreadView` 有面包屑返回频道；`TaskBoard`、`Admin` 子页、`Settings` 子页依赖侧边栏或顶部 tab | 深层页面（如 Agent 管理 → 编辑）没有就近返回，移动端尤其明显 |
| 页面转场 | 路由切换无过渡，页面瞬间切换 | 频道 ↔ 线程、频道 ↔ 任务看板 跳转显得生硬 |
| Modal/Dialog | `ConfirmDialog` 和多个 Modal 直接出现/消失 | 缺乏缩放/淡入淡出，打断感强 |
| Toast | 使用了 `animate-[slideIn_0.2s_ease-out]`，但全局 CSS 未定义 `slideIn` keyframes | 实际无动画 |
| 下拉面板 | `SearchBar`、`Sidebar` 人员选择器、emoji 选择器均无进入动画 | 突然出现，显得粗糙 |
| 消息列表 | 新消息进入无动画；同一人连续消息每次都显示头像+名字 | 信息密度低、动态感弱 |
| 移动端操作 | `MessageRow` 的复制/编辑/删除/表情按钮只在 hover 时显示 | 触摸设备上完全不可见 |
| 加载/空状态 | `Skeleton` 只有 pulse；`EmptyState` 静态出现 | 缺乏渐进式入场 |

---

## 二、优化方向

### 2.1 返回导航：让「回退」触手可及

#### A. 全局返回按钮策略

在以下场景提供显式返回：

- **子页面从属于某个父级时**：`ThreadView`（父级：频道）、`TaskBoard`（父级：频道，可选）、`Admin` 各子页（父级：管理后台）、`Settings` 各子页（父级：设置）。
- **弹窗/编辑模式**：`AgentManagement` 的编辑表单、`ChannelManagement` 的新建表单可折叠回原列表，并提供「取消/返回」。

实现方式：
- 扩展 `PageHeader` 增加 `backTo?: string` 属性，自动渲染返回箭头按钮。
- 按钮语义：`← 返回` 或 `← 返回 #general`，比面包屑更直观。

```tsx
// PageHeader 使用示例
<PageHeader
  title="Agent 管理"
  backTo="/admin"
  breadcrumb={[{ label: "管理后台", to: "/admin" }, { label: "Agent 管理" }]}
/>
```

#### B. 浏览器返回与路由状态

- 对 `ThreadView` 等临时浏览场景，使用标准 `useNavigate(-1)` 返回，而不是强制跳转到固定路径。
- 避免在路由切换时丢失滚动位置：可在 `AppLayout` 中记录并恢复各路由的滚动位置。

#### C. 移动端底部/顶部返回栏

桌面端侧边栏提供了上下文，但移动端侧边栏收起后，用户只能依赖汉堡菜单。建议：
- 在移动端 header 的页面标题左侧增加一个常驻的 `←` 返回按钮（当 `PageHeader` 有 `backTo` 时）。
- 或者，为移动端增加底部 Tab 栏（Home / DM / 任务 / 设置），减少返回频次。

---

### 2.2 页面转场动画

目标：让页面切换有「推进/返回」的空间感，但不炫技。

#### 方案对比

| 方案 | 优点 | 缺点 | 推荐度 |
|------|------|------|--------|
| 纯 CSS + react-router `location.key` | 零依赖、轻量 | 需要自行管理方向 | ⭐⭐⭐⭐ |
| `framer-motion` + `AnimatePresence` | API 优雅、方向易控 | +~40KB gzip | ⭐⭐⭐ |
| 自研 TransitionGroup | 完全可控 | 维护成本高 | ⭐⭐ |

#### 推荐实现：纯 CSS fade + slide

利用 React Router 的 `useLocation()` 获取 `key`，给 `<Outlet />` 包裹一层：

```tsx
// AppLayout.tsx
const location = useLocation();
<div className="relative flex-1 overflow-hidden">
  <div key={location.key} className="page-enter">
    <Outlet />
  </div>
</div>
```

配合 CSS：

```css
.page-enter {
  animation: pageIn 0.2s ease-out;
}
@keyframes pageIn {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
```

- 频道 → 线程：可加入轻微的「从右向左滑入」暗示层级深入。
- 返回时：可监听 `popstate` 事件反转方向，或统一使用淡入避免方向错乱。

---

### 2.3 Modal / Dialog / 下拉面板动画

#### A. ConfirmDialog

增加 backdrop 淡入 + 内容缩放进入：

```css
.modal-backdrop { animation: fadeIn 0.15s ease-out; }
.modal-content { animation: scaleIn 0.15s ease-out; }
@keyframes scaleIn {
  from { opacity: 0; transform: scale(0.96) translateY(8px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}
```

#### B. SearchBar 下拉结果

从顶部轻微淡入下滑：

```css
.search-panel { animation: slideDown 0.15s ease-out; }
```

#### C. Sidebar 人员选择器、emoji 选择器、CreateChannelModal

统一使用 `origin-top` scale 动画，避免从 `0` 到 `1` 的突兀感。

---

### 2.4 Toast 动画修复

当前 `Toast.tsx:27` 使用 `animate-[slideIn_0.2s_ease-out]`，但 `index.css` 没有定义 `@keyframes slideIn`。需要：

1. 在 `index.css` 补充 keyframes：

```css
@keyframes slideInRight {
  from { opacity: 0; transform: translateX(100%); }
  to { opacity: 1; transform: translateX(0); }
}
@keyframes fadeOut {
  from { opacity: 1; transform: translateX(0); }
  to { opacity: 0; transform: translateX(20%); }
}
```

2. 给 Toast 增加退出动画：由于 Zustand 直接移除 DOM，退出动画需要「先标记为 exiting，延迟卸载」。可扩展 `toastStore` 增加 `exit` 状态，或在组件内用本地 state 管理。

3. 堆叠 Toast 的入场间隔：多个 Toast 连续出现时，依次延迟 60ms 进入，避免拥挤。

---

### 2.5 消息列表动画

#### A. 新消息进入

非虚拟列表模式下，新消息从底部滑入：

```css
@keyframes messageIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
```

注意：虚拟列表模式下不宜对每条消息加动画，会干扰 `react-virtual` 的高度测量。可仅对「刚发送的 pending 消息」或「最后一条新消息」加动画。

#### B. 同一人消息合并

连续同发送者消息在 5 分钟内只显示一次头像和时间，减少视觉噪音：

```tsx
const shouldCompact = prev && prev.senderId === msg.senderId && timeDiffMin < 5;
```

#### C. 消息操作按钮在移动端可见

`MessageRow` 当前使用 `opacity-0 group-hover:opacity-100`，在触摸设备上完全无法触发。建议：
- 默认常驻显示（或点击消息后显示）。
- 折叠到「⋯」更多菜单中，避免一行按钮过多。

---

### 2.6 微交互与反馈

#### A. 按钮点击反馈

为所有按钮增加 `:active:scale-[0.98]` 或 `:active:bg-*-700`，让点击有按下去的感觉。

#### B. 输入框聚焦

统一使用 `ring-2 ring-blue-500/30` 替代当前仅改变 border color，聚焦更明显。

#### C. 状态变化

- `ConnectionStatus` 的在线/离线切换增加颜色过渡 `transition-colors duration-300`。
- `AgentStatusBar` 的 Agent 状态变化使用 pulse 或 color transition。
- `OnboardingChecklist` 的步骤完成时增加 ✓ 缩放动画。

#### D. 空状态入场

`EmptyState` 增加轻微的 scale + fade 入场动画，避免页面加载后空白区域突然出现。

---

### 2.7 加载与骨架屏

- 给 `Skeleton` 增加 shimmer（扫光）效果，替代单调的 pulse：

```css
@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
.skeleton-shimmer {
  background: linear-gradient(90deg, var(--bg-tertiary) 25%, var(--bg-secondary) 50%, var(--bg-tertiary) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}
```

- 页面首次加载时，让骨架屏有 stagger 延迟，模拟内容渐进加载。

---

### 2.8 移动端专项

- 侧边栏展开/收起已有 `transition-transform`，但可加入 `ease-[cubic-bezier(0.16,1,0.3,1)]` 让手感更自然。
- 移动端页面切换建议使用「从右滑入」暗示层级，返回时从左侧滑出。
- 增加底部安全区适配 `pb-safe`（iOS 刘海屏）。

---

## 三、推荐实施优先级

### P0 — 立即做（低成本高感知）

1. 修复 Toast `slideIn` keyframes 缺失。
2. 给 `ConfirmDialog` 增加进入动画。
3. 扩展 `PageHeader` 支持 `backTo`，为 `ThreadView`、`Admin` 子页、`Settings` 子页添加返回按钮。
4. 修复 `MessageRow` 操作按钮在移动端不可见的问题。

### P1 — 近期做（体验提升明显）

5. 给 `SearchBar`、`Sidebar` 下拉、`CreateChannelModal` 增加进入动画。
6. 页面切换统一 fade / slide 转场。
7. 新消息进入动画（非虚拟列表）。
8. 按钮/输入框统一微交互（active scale、focus ring）。

### P2 — 排期做（锦上添花）

9. 消息分组（连续同发送者合并）。
10. Skeleton shimmer 效果。
11. 路由滚动位置恢复。
12. Toast 退出动画 + 堆叠延迟。

---

## 四、实施策略建议

- **不引入新依赖**：纯 CSS/Tailwind + 少量 React state 即可实现大部分效果，避免增加 bundle 体积。
- **统一动画 token**：在 `tailwind.config.js` 或 `index.css` 中定义标准 duration/easing：
  - 快速反馈：150ms
  - 面板/弹窗：200ms
  - 页面转场：250ms
  - 缓动：`cubic-bezier(0.16, 1, 0.3, 1)`（自然减速）
- **尊重 `prefers-reduced-motion`**：对大幅位移动画使用 `@media (prefers-reduced-motion: reduce) { animation: none; }`。
- **动画不应阻塞交互**：所有动画使用 `transform` / `opacity`，避免触发 layout/paint。

---

*本方案聚焦于「返回导航」和「动画体验」，可与上一轮「页面层级 + 视觉一致性」形成互补。*

---

## 五、实施记录（2026-07-17）

### 已完成（P0 + 部分 P1）

1. **返回按钮**
   - 扩展 `PageHeader` 支持 `backTo` 属性，在标题左侧渲染返回箭头。
   - 为 `ThreadView`、`TaskBoard`、`Admin` 四个子页、`Settings` 四个子页添加 `backTo`。

2. **Modal 统一与动画**
   - 新增 `components/ui/Modal.tsx`：封装遮罩淡入淡出 + 内容缩放进入/退出 + Esc 关闭 + 点击遮罩关闭。
   - `ConfirmDialog`、`CreateChannelModal`、`ChannelSettingsModal` 统一使用 `Modal`。

3. **Toast 动画修复**
   - 在 `index.css` 定义 `slideInRight`、`fadeIn`、`scaleIn`、`slideInUp`、`fadeOut`、`scaleOut`、`shimmer` 等 keyframes。
   - `Toast.tsx` 改用 `animate-slide-in-right`（之前引用了不存在的 `slideIn`）。

4. **页面切换过渡**
   - `AppLayout` 中给 `<Outlet />` 包裹 `key={location.key}` + `animate-fade-in`，让路由切换有淡入效果。

5. **移动端消息操作可见**
   - `MessageRow` 的复制/编辑/删除/表情按钮在 `lg` 以下屏幕默认显示，桌面端保持 hover 显示。
   - emoji picker 增加 `animate-scale-in`。

6. **下拉面板动画**
   - `SearchBar` 搜索结果/空状态面板增加 `animate-slide-in-up`。
   - `Sidebar` 私信人员选择器增加 `animate-scale-in`。

7. **微交互**
   - `Button` 增加 `active:scale-[0.98]` 点击反馈。
   - `Input`、`Textarea` 增加 `focus:ring-2 focus:ring-blue-500/30`。
   - `PendingRow` 发送中消息增加 `animate-slide-in-up`。

8. **无障碍**
   - `index.css` 增加 `@media (prefers-reduced-motion: reduce)`，关闭所有动画与过渡。

### 验证结果

- `pnpm exec tsc --noEmit` ✅ 通过
- `pnpm run build` ✅ 通过
- 未引入新的运行时依赖

### 未实施（可后续继续）

- 新消息进入动画（虚拟列表场景较复杂）。
- 路由滚动位置恢复。

---

## 八、补充实施记录（2026-07-17 第四轮）

### 已完成

1. **侧边栏频道分组：公开 / 私有**
   - 侧边栏频道列表拆成两组：「频道」（公开）与「私有频道」（有私有频道时才显示）。
   - 私有频道条目用琥珀色锁形 SVG 图标替代 `#` 符号，一眼可辨。
   - 未读徽章逻辑不变。
   - 字段兼容：server 返回 `type`，shared 类型声明叫 `visibility`，两处都判。

2. **频道页标题私有标识**
   - `ChannelView` 的 `PageHeader` 在私有频道时标题前显示锁形图标。
   - `AppLayout` 顶部标题栏在私有频道时标题后追加锁形图标。

### 验证结果

- `pnpm exec tsc --noEmit` ✅ 通过
- `pnpm run build` ✅ 通过
- 未引入新的运行时依赖


---

## 七、补充实施记录（2026-07-17 第三轮）

### 已完成

1. **侧边栏底部布局重构**
   - 新增 `components/layout/UserProfileFooter.tsx`：在侧边栏最底部显示当前用户头像、显示名、handle，点击展开菜单包含「设置」「主题切换」「退出登录」。
   - 把原本散落在「系统」分组里的主题切换和退出登录移入用户资料菜单，让侧边栏底部更紧凑、左下角不再空白。
   - 在「系统」分组中保留「管理后台」并把「接入 Agent」从「应用」移到「系统」，让应用分组更聚焦。

2. **AgentStatusBar 改进**
   - 没有 Agent 时不再返回 null，而是显示引导文案「暂无 Agent，去「接入 Agent」创建一个」。
   - 每个 Agent 行增加头像和在线/离线标签，hover 有背景反馈。

### 验证结果

- `pnpm exec tsc --noEmit` ✅ 通过
- `pnpm run build` ✅ 通过
- 未引入新的运行时依赖


---

## 六、补充实施记录（2026-07-17 第二轮）

### 已完成

1. **图标按钮 Tooltip**
   - 新增 `components/ui/Tooltip.tsx` 与 `components/ui/IconButton.tsx` 的 `tooltip` 属性。
   - 为文件上传、成员、频道设置、任务看板、菜单、创建频道、发起私信等图标按钮添加 tooltip。

2. **消息分组（连续同发送者合并）**
   - `MessageRow` 新增 `prevMsg` 参数，当与上一条为同一发送者且时间差 < 5 分钟时进入 compact 模式：隐藏头像、姓名、时间戳，左侧留白对齐。
   - `ChannelView`、`DmView`、虚拟列表 `VirtualMessageList` 均传入前一条消息。

3. **Toast 退场动画 + 堆叠延迟**
   - `toastStore` 增加 `exiting` 状态，`dismiss` 时先标记退出，动画结束后再移除 DOM。
   - `Toast.tsx` 根据 `exiting` 切换 `animate-fade-out` / `animate-slide-in-right`。
   - 多个 Toast 依次延迟 60ms 进入，避免拥挤。

4. **Skeleton shimmer**
   - `Skeleton` 组件默认使用 `animate-shimmer` 扫光效果，保留 `animate-pulse` 降级选项。

5. **移动端底部 Tab 栏**
   - 新增 `components/layout/MobileTabBar.tsx`：频道 / 私信 / 任务 / 设置 四个入口。
   - 在 `AppLayout` 中嵌入，`lg:hidden` 仅移动端显示；主内容区增加 `pb-16 lg:pb-0` 避免遮挡。
   - `index.css` 增加 `.pb-safe` 适配 iOS 底部安全区。

### 验证结果

- `pnpm exec tsc --noEmit` ✅ 通过
- `pnpm run build` ✅ 通过
- 未引入新的运行时依赖

