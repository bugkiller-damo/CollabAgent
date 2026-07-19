# CollabAgent 文档

按日期归档。最新进展在 `2026-07-19/`。

- **[2026-07-19/](2026-07-19/)** — 正式设计文档（以当前实现为准）
  - `01-智能体协作体系详细设计.md` — daemon 模块架构 / 五态状态机 / @mention 协作流 / 生命周期 / 终端观察 / Claude Code 集成 / 权限模型 / 设计不变量
  - `02-数据架构设计.md` — 22 张表结构明细 / ER 关系 / 索引设计 / 缓存层 / 附件存储 / daemon .slock/ 本地持久化
  - `03-接口设计.md` — REST 全端点 / Internal Agent API / WebSocket 三方协议 / MCP 17 工具 / 认证矩阵
  - `04-汇报-开发进度讨论（2026-07-20）.md` — 周一开发组**设计文档评审会**材料：三份文档走读要点 / 评审问题 / 规格分歧拍板 / 会议预期产出
  - `05-演进规划.md` — 规划方向（非现状）：E1 多 CLI（CliDriver 抽象）/ E2 多平台（Unix 层）/ E3 daemon 服务端化（多 daemon → 托管 → 远程调度）
- **[2026-06-01/](2026-06-01/)** — 进展
  - `完成记录.md` — 当日增量：接入向导 / 邀请链接 / 管理后台 / metrics 仪表盘 / daemon 收尾 + 相对 05-30 的状态对照 + 后续可优化方向（22 条）
  - **汇报材料**（向领导/同事分享用）：
    - `汇报-一页纸（领导版）.md` — 定位+进度+差异化+路线，可直接贴群/邮件
    - `汇报-Demo脚本.md` — 现场演示分步脚本 + 问答/翻车预案
    - `汇报-Slides大纲.md` — 10–12 页汇报大纲
    - `功能概览（同事版）.md` — 面向非技术读者的功能概览（最新版，取代 05-30 版）
- **[2026-07-14/](2026-07-14/)** — 最新完成情况（回退后）
  - `项目完成情况报告.md` — 截至当前的完整项目完成度（渗透内容已全部移除，纯 CollabAgent 协作平台状态 + 技术债务 + 路线图）
  - `phase1-optimization-plan.md` — Phase 1 实施计划
  - `phase1-implementation-report.md` — Phase 1 实施报告
- **[2026-07-08/](2026-07-08/)** — 平台改造分析
  - `代码库功能分析与升级优化方向.md` — 代码库深度分析（架构/数据流/技术债/20+ 优化方向）
  - `当前进度总结与后续路线图.md` — Phase 0+1+2 改造总结（49 测试/28 API/22 表 + 后续 P0-P4 路线）
  - `架构设计评审.md` — 安全渗透测试平台架构设计
- **[2026-05-30/](2026-05-30/)** — 权威基准
  - `完成度分析与Slock优化空间.md` — **从这里开始**：完成度 + 对标 Slock 的优化空间与路线（部分条目已被 06-01 推进，见当日对照表）
  - `项目完成情况与优化方向（开发版）.md` — 偏开发的完成情况快照
  - `功能概览（同事版）.md` — 偏功能的概览（非技术读者）
  - `Agent-Daemon-完成情况与改造计划.md` — Agent/daemon 运行时设计与计划
- **[2026-05-29/](2026-05-29/)** — 规划存档
  - `功能优化规划/` — 用户体验/界面/消息/频道/稳定性/安全 优化规划（01-06）
  - `功能模块/` — 认证/消息/频道线程/任务提醒/文件附件 模块文档（01-05）
- **[2026-05-25/](2026-05-25/)** — Slock 逆向参考
  - `slock-architecture.md`、`slock-protocol-analysis.md`
- **[2026-07-14/](2026-07-14/)** — 追加分析
  - `frontend-ux-analysis.md` — 前端 UI 可优化方向分析报告
  - `sprint-a-implementation-report.md` — Sprint A 实施报告（404/死依赖/Toast/themeStore）
  - `sprint-b-implementation-report.md` — Sprint B 实施报告（消息删除/Reactions/Thread实时/DmView）
  - `sprint-c-implementation-report.md` — Sprint C 实施报告（AuthGuard/readCsrf/highlight.js/AbortController）
  - `server-analysis.md` — Server 端可优化方向分析报告（代码质量/性能/安全/测试/可运维性）
  - `sprint-1-implementation-report.md` — Sprint 1 实施报告（auth 拆分/authenticate 统一/静态 import/优雅关闭/健康检查）
  - `sprint-2-implementation-report.md` — Sprint 2 实施报告（agents 拆分/orgs 抽取/channel 公共 lib/查询片段）
  - `sprint-3-implementation-report.md` — Sprint 3 实施报告（config 集中/限流中间件/refresh 轮换/WS 心跳/上传校验）
  - `sprint-4-implementation-report.md` — Sprint 4 实施报告（86 测试全覆盖，10 文件，+70 用例）
  - `sprint-6-implementation-report.md` — Sprint 6 部分（消息编辑历史/Swagger 文档/Config 集中化）

> 早期重复的完成度报告、UX 优化、Slock 复刻计划等文档已于 2026-05-30 清理（git 历史可追溯）。
