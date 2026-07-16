# 前端 UI 可优化方向分析报告

> 分析日期：2026-07-14 | 基于 `packages/web/src/` 全量代码通读
> 范围：用户视角功能完整性、UI/UX 设计结构、工程质量

---

## 一、总览

前端共 **18 个页面组件** + **9 个 Zustand store** + **~25 个 UI 组件**。整体架构清晰（React 19 + Vite 6 + TailwindCSS + Zustand），
经过 A/B/C/D 四轮迭代后，功能完整性和工程质量已大幅提升。

### 当前做得好的

| 方面 | 评述 |
|---|---|
| 路由级 code-split | `React.lazy()` + `<Suspense>`，首屏加载已优化（27 个 chunk） |
| Store 架构 | Zustand + selector 模式统一、一致 |
| 消息虚拟滚动 | `@tanstack/react-virtual` 支撑大规模消息列表 |
| WebSocket 重连 | 指数退避（1s→30s）+ 70s 看门狗 |
| 暗色主题 | 完整的 Tailwind `dark:` 策略支持 |
| Metrics 仪表盘 | sparkline + count-up 动画，最精致的页面 |
| 组件复用 | `EmptyState` / `ConfirmDialog` / `PasswordStrength` / `Skeleton` 等可复用组件 |

---

## 二、功能性问题（已全部修复）

### ~~🔴 Bug 1: channelStore joinedChannels 追踪失效~~ ✅ 已确认不存在

经核查当前代码已使用 `new Set(s.joinedChannels)` 正确模式，不存在 spread of Set bug。

### ~~🔴 Bug 2: Reactions 发送后不刷新~~ ✅ 已修复

**修复内容**（Sprint B）：
- `messageStore.addReaction` / `removeReaction` 调 API 后调用 `applyReaction` 乐观更新
- 后端新增 `DELETE /api/messages/:messageId/reactions/:emoji` 端点
- UI 中 reactions chips 即时显示，6 个 emoji 选择器（👍❤️😂🎉🤔👀）

### ~~🔴 Bug 3: Thread 消息用两把 key 存，有重复~~ ✅ 已修复

**修复内容**（Sprint B）：
- `ThreadView` 订阅 `useMessageStore` thread key
- WS 推送的 thread 消息自动合并到本地 replies

---

## 三、用户视角功能缺口

### 🟥 高优先级 ✅ 全部完成

| # | 缺失功能 | 状态 |
|---|---|---|
| 1 | **404 页面** | ✅ NotFoundPage + 路由 catch-all（Sprint A） |
| 2 | **消息搜索** | ✅ SearchBar 组件（300ms 防抖 + 结果下拉 + 跳转高亮） |
| 3 | **消息删除** | ✅ DELETE 端点 + 二次确认 + WS 同步 |
| 4 | **DM 功能** | ✅ 部分升级：@mention + 文件拖拽上传 + MessageRow 复用 |
| 5 | **Toast/通知提示** | ✅ toastStore + ToastContainer（替换全部 18 处 alert） |
| 6 | **通知设置页** | ✅ 5 种通知类型开关（localStorage 持久化） |
| 7 | **集成设置页** | ✅ 令牌管理（创建/列表/撤销 + 后端 API） |
| 8 | **Emoji 选择器** | ✅ 6 emoji 面板 + reactions chips 展示 |

### 🟨 中优先级

| # | 缺失功能 | 用户感受 |
|---|---|---|
| 9 | **Thread 实时更新** | 必须手动刷新看新回复 |
| 10 | **打字指示** | 不知道对方/Agent 正在输入 |
| 11 | **消息分组** | 同一人连续消息每次都显示头像+时间 |
| 12 | **频道搜索/过滤** | 频道多了难以找到 |
| 13 | **Desktop 通知（系统级）** | 切到其他 tab 后收到消息无推送 |
| 14 | **音频通知声音** | 没有任何新消息声音提示 |
| 15 | **快捷键** | 没有 `/` 聚焦输入框、`Esc` 关闭弹窗等 |
| 16 | **频道 Topic 展示** | 频道描述只在设置里，聊天顶部看不到 |
| 17 | **邀请链接复制** | 已生成但无复制按钮 |
| 18 | **任务到期日和指派人** | TaskBoard 只有简单标题+状态 |
| 19 | **文件/图片浏览器** | 没有 `/files` 统一查看所有附件 |
| 20 | **已 Pin 消息视图** | 无法标记和查看置顶消息 |

---

## 四、设计结构问题

### 4.1 Store 重叠与不一致

| 问题 | 详情 | 状态 |
|---|---|---|
| **themeStore 重复** | `uiStore` 和 `themeStore` 都管理主题 | ✅ themeStore 已删除，统一 uiStore（Sprint A） |
| **notificationStore 未导出** | 不在 barrel export 中 | ⏸️ 低优先级 |
| **authStore 无 loading** | 登录/注册无 isLoading | ⏸️ 低优先级 |
| **channelStore 静默失败** | `.catch(() => {})` 吞错误 | ✅ 改为 toast.error（Sprint A） |

### 4.2 API Client 薄弱

| 问题 | 影响 | 状态 |
|---|---|---|
| 无 abort controller | 组件卸载后请求继续 | ✅ apiGet/Post/Patch 支持 `signal` 参数 |
| 无 retry | 网络抖动直接抛错 | ⏸️ 低优先级 |
| 无离线检测 | 不检查 `navigator.onLine` | ⏸️ 低优先级 |
| `uploadAttachment` 游离 | CSRF 逻辑重复 | ⏸️ 低优先级 |

### 4.3 代码重复

| 位置 | 原因 | 状态 |
|---|---|---|
| `AuthGuard` 定义两次 | `components/auth/` + `App.tsx` 内联 | ✅ 删 inline 版本（Sprint C） |
| `readCsrf()` 重复 | 3 处独立实现 | ✅ 合并到 `api/client.ts`（Sprint C） |
| `GuestGuard` 死代码 | 导出但从未使用 | ⏸️ 可清理 |

### 4.4 死依赖 ✅ 已清理

| 包 | 操作 | Sprint |
|---|---|---|
| `@dnd-kit/core` + `@dnd-kit/sortable` | ✅ 已删除 | Sprint A |
| `react-virtuoso` | ✅ 已删除 | Sprint A |

---

## 五、性能优化方向

### 5.1 highlight.js CSS 全局加载 ✅ 已移至入口

**位置**：`components/chat/MarkdownContent.tsx:4` → 已移到 `main.tsx`

**修复**（Sprint C）：highlight.js CSS 从按需组件级加载改为入口级加载，确保所有页面可用且 bundle 正确 deduplicate。

### 5.2 VirtualMessageList 固定高度导致滚动抖动 ⏭️ 代码正确

**位置**：`components/chat/VirtualMessageList.tsx`

`estimateSize: () => 72` + `ref={virtualizer.measureElement}` 是 TanStack Virtual 的标准模式。
`estimateSize` 是首次估算，渲染后 `measureElement` 会捕获实际 DOM 高度覆盖估算值，代码正确。

### 5.3 Store selector 粒度过粗

```typescript
// 返回整个 Map → 任何频道有新消息都重渲染
useMessageStore((s) => s.messagesByTarget)
```
应使用更精细的 selector：
```typescript
useMessageStore((s) => s.messagesByTarget[channelKey])
```
目前 `ChannelView` 已使用 `(s) => s.messagesByTarget[target]` 模式。✅

### 5.4 冗余 API 调用

- ~~每发一条消息后调用 `fetchHistory()`（ChannelView:73,110）~~ — 仍存在，可优化
- ~~`OnboardingChecklist` 和 `ConnectWizard` 同时轮询 `/api/daemon/status`~~ — 仍存在，低影响

---

## 六、无障碍 (Accessibility) 分析

| 维度 | 现状 | 评分 |
|---|---|---|
| `aria-label` | 仅 NotificationBell 有（`aria-label="通知"`） | 🔴 几乎缺失 |
| `aria-live` 区域 | 完全没有 | 🔴 |
| `role` 属性 | 消息列表无 `role="list"` | 🔴 |
| 键盘导航 | 基本可用但 `Esc` 关弹窗缺失 | 🟡 |
| Focus 管理 | 弹窗关闭后焦点不回到触发按钮 | 🟡 |
| `lang` 属性 | `<html>` 无 `lang` | 🟡 |
| `prefers-reduced-motion` | 无动画减弱支持 | 🟡 |
| 色弱对比 | `text-gray-400` on `bg-gray-100` 可能不够 | 🟡 |

---

## 七、优化优先级建议

### Sprint A — 低投入高感知（1-2 天） ✅ 已完成 2026-07-14

| 任务 | 状态 | 实施报告 |
|---|---|---|
| 修复 `joinedChannels` Set bug | ⏭️ bug 不存在 | — |
| 添加 404 页面 | ✅ | NotFoundPage + 路由 catch-all |
| 清除死依赖（@dnd-kit, react-virtuoso） | ✅ | -45KB min |
| channelStore 静默失败加 toast 提示 | ✅ | toastStore + ToastContainer |
| 删除 `themeStore` 归并到 `uiStore` | ✅ | 删 32 行重复代码 |

### Sprint B — 核心体验提升（3-5 天） ✅ 已完成 2026-07-14

| 任务 | 状态 | 实施报告 |
|---|---|---|
| 消息删除按钮 | ✅ | DELETE 端点 + 二次确认 + WS 广播 |
| DmView 升级至 ChannelView 同等 | ✅ 部分 | @mention + 文件上传 + 拖拽 + MessageRow 复用 |
| Thread 实时更新（WS 监听 thread 键） | ✅ | 订阅 messageStore thread key |
| 替换 alert() | ✅（Sprint A 已做） | toastStore + 18 处替换 |

### Sprint C — 工程成熟度（按需推进） ✅ 已完成 2026-07-14

| 任务 | 状态 |
|---|---|
| `apiClient` 加 AbortSignal 参数 | ✅ apiGet/apiPost/apiPatch 支持 `signal` |
| `AuthGuard` 去重、`readCsrf()` 合并 | ✅ 删 inline AuthGuard + 3→1 归并 |
| VirtualMessageList 动态高度测量 | ⏭️ 代码已正确 |
| highlight.js CSS 按需加载 | ✅ 移到 `main.tsx` 入口级 |

### Sprint D — 新增功能（2026-07-14）

| 任务 | 状态 | 说明 |
|---|---|---|
| 消息搜索 | ✅ | SearchBar 组件 + 后端 `simple` 全文搜索 + 结果跳转高亮 |
| 通知设置页 | ✅ | 5 种通知类型开关（localStorage），替换占位页 |
| 集成设置页 | ✅ | 令牌创建/列表/撤销，后端新增 `GET/DELETE /api/profile/tokens` |
| 移动端响应式 | ✅ | 侧边栏滑动式覆盖 + 汉堡按钮 + 遮罩层 |
| 时间格式优化 | ✅ | 智能 formatTime：刚刚/X分钟前/HH:MM/昨天/月日/年份 |
| AuthGuard 去重 | ✅ | Sprint C + 搜索 SQL 修复 |

---

## 八、关联文档

- [`项目完成情况报告.md`](项目完成情况报告.md) — 总体项目状态
- [`todo-pending.md`](todo-pending.md) — 待做任务追踪

---

*本文档基于代码库完整通读自动生成，建议每轮优化后更新。*
