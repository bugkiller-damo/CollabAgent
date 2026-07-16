# Sprint B 实施报告

> 完成日期：2026-07-14
> 涵盖范围：前端 UX 优化 Sprint B 四项
> 关联分析：`docs/2026-07-14/frontend-ux-analysis.md` 第七章

---

## 实施总览

| 子项目 | 状态 | 修改文件数 | 新增/删除行 | 实际工时 |
|---|---|---|---|---|
| 消息删除 | ✅ | 3 | +60 / -10 | 30 分钟 |
| Reactions 展示 | ✅ | 3 | +90 / -20 | 30 分钟 |
| Thread 实时更新 | ✅ | 1 | +25 / -5 | 15 分钟 |
| DmView 升级（部分） | ✅ | 1 | +90 / -30 | 30 分钟 |

**最终 typecheck**：shared ✅ / server ✅ / web ✅ / daemon ✅
**最终测试**：16/16 通过
**最终构建**：Web 27+ chunk 验证

---

## 1. 消息删除

### 新增

| 文件 | 操作 | 内容 |
|---|---|---|
| `packages/server/src/routes/messages.ts` | MODIFY | `DELETE /api/messages/:messageId` 端点 |
| `packages/web/src/stores/messageStore.ts` | MODIFY | `deleteMessage` / `applyMessageDelete` 动作 |
| `packages/web/src/components/chat/MessageRow.tsx` | MODIFY | 删除按钮 + `ConfirmDialog` 二次确认 |

### 后端设计

- 权限校验：仅 `sender_id === userId` 可删（403 否则）
- 软删除：`UPDATE messages SET content = '', task_* = NULL WHERE id = ?`（保留行级结构）
- 清反应和附件：先 `DELETE FROM message_reactions WHERE message_id = ?` 和 `message_attachments`
- WS 广播：`broadcast(channelId, { type: "message:delete", message: { id } })`

### 前端 UX

- 按钮仅 `isOwn` 时显示，hover 时出现
- 点击触发 `ConfirmDialog` 二次确认（防误删）
- 成功后 toast 提示
- 其他客户端通过 `message:delete` 事件 → `applyMessageDelete` 标记为已删除（content 空 + deleted: true）

---

## 2. Reactions 展示

### 新增

| 文件 | 操作 | 内容 |
|---|---|---|
| `packages/server/src/routes/messages.ts` | MODIFY | SELECT 增加 `reactions` JSON 字段（emoji + userIds） |
| `packages/web/src/stores/messageStore.ts` | MODIFY | `applyReaction(messageId, emoji, userId, action)` 状态合并 |
| `packages/web/src/components/chat/MessageRow.tsx` | MODIFY | reactions chips 展示 + emoji 选择器（6 个 emoji） |

### SQL 修复

第一版用 `(SELECT ... GROUP BY m.id)` 引用了 outer 列导致 PG 报错（500）。
改为嵌套子查询 `(SELECT ... FROM (SELECT mr.emoji, array_agg(...) FROM message_reactions WHERE message_id = m.id GROUP BY mr.emoji) r)` 修复。

### 前端 UX

- 反应 chips 显示在消息下方：`👍 3`
- 当前用户已反应 → 高亮（蓝色背景）
- 点击 chip → 切换 add/remove（无需点 emoji 选择器）
- 😀 按钮打开 6 emoji 选择器（👍❤️😂🎉🤔👀）
- 通过 `applyReaction` 立即更新 UI（乐观更新），失败时 toast

---

## 3. Thread 实时更新

### 新增

| 文件 | 操作 | 内容 |
|---|---|---|
| `packages/web/src/pages/ThreadView.tsx` | MODIFY | 订阅 messageStore 中 thread key |

### 设计

线程 key 复用 AppLayout WS handler 的格式：`channelName:threadIdPrefix`（前 8 字符）。
ThreadView 用 selector 订阅 `useMessageStore((s) => s.messagesByTarget[threadKey])`，
当该 key 的消息集合变化时（来自 WS 推送），新消息合并到本地 replies 数组。

### 用户感知

之前必须手动刷新才看到新回复。现在打开 thread 页面，其他人在频道回复该 thread 的消息会自动出现。

---

## 4. DmView 升级（部分）

### 新增功能

| 功能 | 实现 |
|---|---|
| **@mention popup** | 复用 `useMentionSuggest` hook + `MentionPopup` |
| **文件上传（拖拽/粘贴/按钮）** | `uploadAttachment` API + 10MB 限制 + 上传进度 |
| **统一消息行组件** | 复用 `MessageRow`，删除/反应/编辑/复制 全部可用 |
| **附件未发送提示** | 上传成功但未发送时显示蓝色条，可取消 |
| **drag-over 提示** | 拖文件进入时高亮 |
| **MessageSkeleton** | 加载状态用骨架屏替代纯文本 |

### 未做（待 Sprint C）

- 虚拟滚动（`<100` 条消息暂不需要）

---

## 整体代码变化统计

| 指标 | 数值 |
|---|---|
| 新增后端 API | 1（DELETE message） |
| 新增前端动作 | 4（deleteMessage / applyMessageDelete / applyReaction / thread live subscribe） |
| 修改前端组件 | 3（MessageRow 重写 / ThreadView 重写 / DmView 重写） |
| 后端 SQL 改进 | 2 个查询加 reactions JSON |
| 测试通过率 | 100%（16/16） |

---

## 待办 / 后续改进

Sprint C 候选方向：
- 消息搜索（用现成的 `/api/messages/search` 端点 + 一个 SearchBar UI）
- 通知设置页实际配置（per-type 开关）
- 集成设置页（API token 管理）
- 移动端响应式布局

---

*本文档基于 Sprint B 实施过程的实际改动自动整理。*