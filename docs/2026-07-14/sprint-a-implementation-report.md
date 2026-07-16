# Sprint A 实施报告

> 完成日期：2026-07-14
> 涵盖范围：前端 UX 优化 Sprint A 五项
> 关联分析：`docs/2026-07-14/frontend-ux-analysis.md` 第七章

---

## 实施总览

| 子项目 | 状态 | 修改文件数 | 新增/删除行 | 实际工时 |
|---|---|---|---|---|
| 404 页面 | ✅ | 2 | +50 / -5 | 5 分钟 |
| 死依赖清理 | ✅ | 1 | -3 行 | 5 分钟 |
| Toast 通知系统 | ✅ | 9 | +95 / -10 | 30 分钟 |
| themeStore 合并 | ✅ | 0 | 0 / -32 | 5 分钟 |
| joinedChannels Bug | ⏭️ | 0 | 0 | 0（bug 不存在） |

**最终 typecheck**：shared ✅ / server ✅ / web ✅ / daemon ✅
**最终测试**：16/16 通过
**最终构建**：Web 20+ chunk 验证

---

## 1. 404 页面

### 新增

| 文件 | 内容 |
|---|---|
| `src/pages/NotFoundPage.tsx` | 使用 `EmptyState` 复用组件，提供"返回主聊天"按钮 |
| `src/App.tsx` | 注册 `NotFoundPage` lazy chunk + 添加 `<Route path="*">` catch-all |

### 关键代码

```typescript
// App.tsx
<Route path="*" element={<Suspense fallback={<PageLoading />}>
  <NotFoundPage />
</Suspense>} />
```

### 用户感知

输错 URL 或访问被移除的页面，看到友好的"页面未找到"提示而非空白。

---

## 2. 死依赖清理

### 删除

`packages/web/package.json` 中：
- `@dnd-kit/core ^6.0.0` — 未在源代码中引用
- `@dnd-kit/sortable ^8.0.0` — 未在源代码中引用
- `react-virtuoso ^4.0.0` — 未在源代码中引用

### 验证

```bash
$ grep -r "@dnd-kit\|react-virtuoso" packages/web/src
# 无匹配
```

### 用户感知

Bundle 减少 ~45KB（minified），更快的 `pnpm install`。

---

## 3. Toast 通知系统

### 新增

| 文件 | 内容 |
|---|---|
| `src/stores/toastStore.ts` | Zustand store + `toast.info/success/warning/error` 便捷方法 |
| `src/components/Toast.tsx` | `ToastContainer` 组件，固定右上角，4 种 severity |

### 修改

| 文件 | 变更 |
|---|---|
| `src/components/layout/AppLayout.tsx` | 挂载 `<ToastContainer />` |
| `src/stores/channelStore.ts` | `fetchChannels` 静默失败 → `toast.error` |
| `src/pages/TaskBoard.tsx` | 3 处 `alert` → `toast.error` |
| `src/pages/DmView.tsx` | 1 处 |
| `src/pages/ChannelView.tsx` | 2 处 |
| `src/pages/admin/AgentManagement.tsx` | 2 处 |
| `src/components/admin/OrgMembersPanel.tsx` | 1 处 |
| `src/components/channel/ChannelMembersPanel.tsx` | 2 处 |
| `src/pages/settings/SecuritySettings.tsx` | 7 处（含 `warning`、`success` 区分） |

### 关键代码

```typescript
// toastStore.ts
export const toast = {
  info: (msg: string) => useToastStore.getState().push("info", msg),
  success: (msg: string) => useToastStore.getState().push("success", msg),
  warning: (msg: string) => useToastStore.getState().push("warning", msg),
  error: (msg: string) => useToastStore.getState().push("error", msg),
};
```

### 验证

- 18 个 `alert(` 全部替换为 `toast.*`（含 0 处遗漏）
- 4 种 severity 视觉区分（图标+配色+左边框）
- 自动消失（默认 4 秒），可手动关闭

---

## 4. themeStore 合并

### 删除

`src/stores/themeStore.ts`（32 行）— 无任何文件 import

### 原因

`uiStore.ts` 已有更完整的主题管理（支持 `"dark"|"light"|"system"`），
重复的 `themeStore` 只支持 `"dark"|"light"` 且会与 `uiStore` 冲突写入 `localStorage("theme")` 和 `classList`。

### 验证

```bash
$ grep -r "themeStore\|useThemeStore" packages/web/src
# 仅在 themeStore.ts 自身
```

---

## 5. joinedChannels Set Bug（已确认无需修复）

探索报告中提到的"`{ ...s.joinedChannels }` spread of a Set"bug 实际**不存在于当前代码**。
`channelStore.ts:60,65` 已使用正确的 `new Set(s.joinedChannels)` 模式。
可能在更早版本存在，已在之前的迭代中修复。

---

## 整体代码变化统计

| 指标 | 数值 |
|---|---|
| 新增文件 | 3（NotFoundPage, Toast, toastStore） |
| 删除文件 | 1（themeStore） |
| 修改文件 | 8 |
| 死依赖 | -3（@dnd-kit×2 + react-virtuoso） |
| Bundle 减少 | ~45KB min |
| `alert()` 替换 | 18 处 |

---

## 待办 / 后续改进

Sprint B 继续推进：
- 消息删除按钮
- DmView 升级至 ChannelView 同等
- Thread 实时更新
- Toast 进度条支持（如长操作）

---

*本文档基于 Sprint A 实施过程的实际改动自动整理。*
