# 待做任务清单

> 创建日期：2026-07-14 | 基于 Phase 1 完成后的剩余路线图筛选
> 状态：已确认暂缓，留待后续推进

---

## 一、当前进度

### ✅ 已完成

| # | 任务 | 完成日期 |
|---|---|---|
| 1 | 通知中心（@mention 推送 / WS 实时 / 铃铛面板） | 2026-07-14 |
| 2 | 中文搜索分词（pg_jieba + GIN 索引 + 容错降级） | 2026-07-14 |
| 3 | httpOnly Cookie 硬化（移除 Bearer JWT 路径） | 2026-07-14 |
| 4 | Daemon 健壮性（超时 kill / 1MB 缓冲 / 清理死选项） | 2026-07-14 |
| 5 | **Metrics 时序持久化**（metrics_samples 表 + 60s 采样 + 历史趋势 API） | 2026-07-14 |
| 6 | **Agent 头像字段**（avatar_url 连线 + 前端条件渲染 + 表单输入） | 2026-07-14 |
| 7 | **Web bundle code-split**（React.lazy → 27 个 chunk，首屏减少 68%） | 2026-07-14 |
| 8 | **schema.ts 对齐迁移脚本**（补齐 11 张表 + 列漂移修复） | 2026-07-14 |
| 9 | **Sprint A: 404 页面**（NotFoundPage + 路由 catch-all） | 2026-07-14 |
| 10 | **Sprint A: 死依赖清理**（@dnd-kit, react-virtuoso，-45KB） | 2026-07-14 |
| 11 | **Sprint A: Toast 通知系统**（toastStore + ToastContainer，替换 7 处 alert()） | 2026-07-14 |
| 12 | **Sprint A: themeStore 合并**（删除重复，统一到 uiStore） | 2026-07-14 |

### ⏸️ 暂缓任务（已确认暂缓，留待后续推进）

### 🥈 Daemon npm 发布

**优先级**：🟡 P2 — 暂缓
**关联路线图**：Phase 2 - 1

**目标**：把 daemon 打包成独立 npm 包，用户无需 clone monorepo，一行命令接入。

**价值**：
- 兑现"一行命令接入"的产品承诺
- 配合接入向导完成完整的 OOBE
- CI / 测试部署更方便

**所需步骤**：
1. 选定包名（`@collabagent/daemon` 或 `@collabagent/slock`）
2. 选定构建工具（`tsup` / `pkg` / `esbuild`）
3. 配置 `package.json` `bin` 字段 + 入口点
4. 处理依赖打包策略（built-in vs bundled）
5. 配置 CI 发布工作流（`npm publish` + provenance）
6. 验证 `npx @collabagent/slock daemon` 全流程

**预估工作量**：小～中（1-2 天）

---

### 🥈 邀请链接安全加固

**优先级**：🟡 P2 — 暂缓
**关联路线图**：Phase 2 - 2

**目前状态**：邀请链接端点是公开的、无频率限制，理论上可枚举。

**目标**：
- 添加频率限制（每 IP 每窗口 N 次）
- 可选的绑定邮箱校验（邀请时指定邮箱，注册时验证）
- 邀请链接过期时间配置

**预估工作量**：小（0.5-1 天）

---

## 三、关联文档

- [`项目完成情况报告.md`](项目完成情况报告.md) — Phase 1 完成后的最新项目状态
- [`phase1-implementation-report.md`](phase1-implementation-report.md) — Phase 1 四项实现详情
- [`phase1-optimization-plan.md`](phase1-optimization-plan.md) — Phase 1 规划方案

---

*下次推进时从上述待做任务中选择优先级最高的开始。*
