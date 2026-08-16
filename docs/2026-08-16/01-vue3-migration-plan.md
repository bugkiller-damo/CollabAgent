# Vue3 重写迁移计划

> 日期：2026-08-16 ｜ 分支：`feature/web-vue3` ｜ 基线：`packages/web`（React 19，80 文件）
> 驱动原因：非技术原因要求前端技术栈 React → Vue3（同期 Redis → Valkey 已完成，commit 07fda38）

---

## 1. 策略：monorepo 并行包（新旧共存，可回退）

- 新建 `packages/web-vue`（Vue 3.5 + Vite 6 + vue-router 4 + pinia 2 + Tailwind 3），旧 `packages/web` **原样保留**作为可运行参照实现，验收通过前不动它。
- server / daemon / shared **零改动**；API、WS 协议、`@collabagent/shared` 类型原样复用。
- dev 端口 5174（旧版 5173），proxy 规则与旧版一致；server 端 `@fastify/static` 指向哪个 dist 只是部署期配置。
- 全部页面迁移验收后，再删除 `packages/web` 并将 web-vue 改名收尾（本文档 Phase E）。

## 2. 现状盘点摘要（来自只读盘点 worker 的全量报告）

- **规模**：20 个页面 / ~50 组件 / 10 个 zustand store + wsSender / 单文件 API 层（apiClient + 16 个端点模块）/ 2 个 hook / 1 个 lib（formatTime）。
- **路由**：15 条 Route。`/login`、`/register` 公开；其余由 `AuthGuard` 包裹；`/`、`/tasks`、`/channel/:id`、`/dm/:id` 等由 `AppLayout` 包裹（AppLayout 承载 WS 连接与全局消息分发）；`/settings/*`、`/admin/*` 为嵌套布局路由（`/` 与 `/settings` 有 index redirect）。
- **认证**：httpOnly Cookie + `X-CSRF-Token` 双提交（`apiClient` 统一处理；个别直接 fetch 处手动带）。
- **WS 中枢**：`AppLayout.tsx:112-179` —— `useWebSocket` onMessage 大 switch 分发到 notification/terminal/agent/message 各 store + toast；断线状态映射到 uiStore；`wsSender.ts` 全局发送器。
- **useWebSocket**：ping→pong 自动应答、70s 入站看门狗强制重连、1s→30s 指数退避。
- **markdown**：`MarkdownContent.tsx` = react-markdown + remark-gfm + rehype-highlight + 自定义 `a[target=_blank]`；消费点 MessageRow/ThreadView/SearchBar。
- **虚拟列表**：`VirtualMessageList.tsx` useVirtualizer（estimateSize 72、overscan 10）；`ChannelView` 以 `VIRTUAL_THRESHOLD=100` 决定启用。
- **主题**：`darkMode:"class"`，CSS 变量主题（`index.css` 全框架无关，已逐字节迁移）；theme 初始化在 main.tsx 与 uiStore 两处（迁移时合并为一处）。
- **轮询/防抖**：ConnectWizard 3s、OnboardingChecklist 8s、AgentManagement 5s、MetricsDashboard 3s；SearchBar 300ms、终端 resize 300ms。

### 盘点发现的坑（迁移时逐条对账）

1. `TaskBoard.tsx` **不用 taskStore**，且状态更新端点与 taskStore 不一致（`/api/tasks/update-status` vs `/api/tasks/:number/status`）——迁移前以实际网络请求为准核一次。
2. `messageStore`/`taskStore` 与部分页面存在「store 与直调 API 双轨」——以 store 为准收敛，直调处补 store 调用。
3. 死代码不迁移：`GuestGuard`（导出未用）、`components/message/MentionPopover.tsx`（无引用）。
4. `@collabagent/shared` 的 schema 未展开盘点，基础层迁移时先读它。

## 3. 依赖映射（已定）

| React | Vue3 | 说明 |
|--------|------|------|
| react-router-dom 7 | vue-router 4 | AuthGuard→`router.beforeEach`（查 authStore）；AppLayout 改为布局父路由 |
| zustand 5 | pinia 2 | store 1:1 对应；跨 store 调用直接 import 目标 store；`getState()` → setup 语法中直接读 |
| react-markdown 链 | markdown-it + **DOMPurify** + highlight.js | ⚠️ react-markdown 默认不渲染裸 HTML；markdown-it 需 `html:false` 且输出必须 `DOMPurify.sanitize`；表格/代码高亮通过 preset + hljs 高亮回调 |
| @tanstack/react-virtual | @tanstack/vue-virtual | API 同构，estimateSize/overscan/getItemKey 参数照搬 |
| highlight.js 样式 | 同 | `github-dark.css` 在 main.ts import |
| Tailwind / index.css | 原样 | 已迁移 |

## 4. 通用迁移约定（所有 worker 必须遵守）

1. **组合式 API + `<script setup lang="ts">`**，不使用 Options API。
2. `useEffect(..., [])` → `onMounted`；清理函数 → `onUnmounted`；`useEffect` 依赖 → `watch`。
3. `useState` → `ref`/`reactive`；`useMemo` → `computed`；props/emits 显式声明。
4. 轮询统一封装 `usePolling(fn, ms)` composable（`onUnmounted` 自动 clearInterval）。
5. className 字符串模板原样保留 Tailwind 类，不改视觉。
6. API 层 `src/api/index.ts` 为框架无关 TS，近乎逐行移植（fetch/cookie/CSRF 逻辑不变）。
7. 每页迁移完成 = `pnpm --filter @collabagent/web-vue typecheck && build` 双绿 + 与 React 版同路由功能对照。
8. 不改 packages/web、packages/server、packages/daemon 的任何文件。

## 5. 阶段划分与进度

> 状态更新时间：2026-08-16 17:30 ｜ 主体迁移（Phase A–F + 路由接线）已全部完成并验证。

- **Phase A 脚手架** ✅（commit `5c39def`，17 文件，typecheck/build 双绿，占位路由）
- **Phase B 基础层** ✅（commit `e59b48e`）`src/api/index.ts`、`src/lib/formatTime.ts`+`passwordStrength.ts`、10 个 pinia store + `wsSender`、`useWebSocket`/`useMentionSuggest`/`usePolling` composable、theme 初始化
- **Phase C 通用 UI 组件层** ✅（commit `40b4d9a`，23 文件：ui/ + layout/ + chat/ + skeleton/ 等）
- **Phase D 应用壳层 + 聊天组件族** ✅（commit `44d5a88` + `b7cd3f2` + `1463906`）AppLayout(WS 分发)、Sidebar、MarkdownContent(markdown-it+DOMPurify)、MessageRow、VirtualMessageList(vue-virtual)、等
- **Phase E 其余组件 + admin/settings 页族** ✅（commit `2986404` + `59f918f` + `344d829`）agent 面板族、MentionPopover、Channel 面板族、5 个 admin 页面、5 个 settings 页面、ConnectWizard
- **Phase F 核心页面 + 路由接线** ✅（commit `b5fc9d9` + `48435cb` + `4f21250` + `1756635` + `c0c2240`）MessageComposer、AuthGuard、ChannelView、DmView、ThreadView、TaskBoard；路由表从占位页全部切换到真实组件（AuthGuard/AppLayout 嵌套守卫，lazy chunk）
- **Phase G 收尾** ✅（2026-08-17）：server 静态托管 SPA（`WEB_DIST_DIR` 可配，dist 存在才注册，fallback 排除 API/WS/文件前缀）；旧 `packages/web` 已删除、`web-vue` 已改名 `web`（lockfile 无 React 依赖残留）；Dockerfile 生产镜像并入前端构建与 `web-dist`；CI web-build 单包；竞赛材料（presentation-plan.md / gen-pptx.js / sharing 汇报文档）技术栈措辞更新为 Vue 3（Zustand→Pinia）

### 迁移完成度核对（2026-08-16）

- 页面：**19/19**（`packages/web/src/pages` 全部有 Vue 对应，`Skeleton` 归入 `skeleton/` 子目录属组织差异）
- 组件：**~50/~50**（全部覆盖；`hooks/` → `composables/`、`api/client.ts` → `api/index.ts` 为惯例改名）
- store/composable/lib：**全部覆盖**
- 验证：`vue-tsc --noEmit` 干净 + `vite build` 447 模块 exit 0

## 6. 验证基线

- 门禁：`pnpm --filter @collabagent/web-vue typecheck && pnpm --filter @collabagent/web-vue build`
- 对照：旧版 `pnpm --filter @collabagent/web dev`（5173）与新版（5174）同时起，逐路由人工对照
- server 测试不受前端迁移影响（113/113 基线保持）
