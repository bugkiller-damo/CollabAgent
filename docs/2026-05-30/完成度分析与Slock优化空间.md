# CollabAgent 完成度分析与 Slock 优化空间

> 更新日期：2026-05-30　｜　对象：开发与决策　｜　基准：当前 `D:\code\slock` 代码实况
> 本文是当前权威的完成度与优化分析，取代此前散落的多份完成度/规划文档。

---

## 一、一句话现状

CollabAgent 已经是一个**可用的、Agent 原生的团队协作平台**：人与 Agent 在同一套频道/线程/任务/私信里协作，Agent 由本机 daemon 驱动、用 `slock` CLI 自主收发。核心协作面（消息、频道、线程、任务、提醒、附件、私信、Agent 运行时、组织可见性、基础安全）**已闭环**；与真 Slock 的差距集中在「自主生命周期、第三方集成深度、多租户/可观测性/测试与部署的工程成熟度」。

---

## 二、完成度总览

| 模块 | 状态 | 说明 |
|---|---|---|
| 认证 / 账户 | ✅ 完成 | 注册登录、JWT、httpOnly Cookie + CSRF、登录设备列表、改密、注销/导出、登录限流 |
| 频道 | ✅ 完成 | 公开/私有、成员与角色、邀请/移除、归档、删除（级联） |
| 消息 / 线程 | ✅ 完成 | 发送/历史/编辑、线程回复、@提及、全文搜索、回复数 |
| 任务看板 | ✅ 完成 | 频道内任务、认领/状态流转、拖拽看板、人与 Agent 都能操作 |
| 提醒 | ✅ 完成 | 定时/重复/snooze、到点唤醒 Agent、调度器多实例安全、事件日志 |
| 附件 | ✅ 完成 | 本地磁盘存储、10MB 上限、图片预览、人/Agent 均可上传（预留 MinIO） |
| 私信 DM | ✅ 完成 | 人↔人 / 人↔Agent / Agent↔Agent，成员定向投递，Agent 无需 @ 自动回复 |
| Agent 运行时 / daemon | ✅ 完成 | 本机 daemon、持久 Claude 进程、自主 CLI、System Prompt 注入、持久记忆、服务化+自重启+文件 watch |
| 组织 / 可见性 | ✅ 完成 | servers=组织、个人组织、成员邀请、Agent 按组织可见 |
| 实时 (WebSocket) | ✅ 完成 | 频道定向投递；私有/DM 仅成员；浏览器 WS 现走 cookie 鉴权 |
| 安全 / 工程化 | ✅ 基本完成 | httpOnly+CSRF、私有泄露面收口、统一 schema、调度器并发安全 |
| 自动化测试 / CI | ✅ 完成 | vitest 黑盒集成测试（auth/DM/tasks/health）+ GitHub Actions（typecheck+migrate+起服务+跑测试） |
| 可观测性 | ✅ 完成 | 结构化日志+请求ID、统一错误处理、`GET /api/metrics`（计数器/内存/在线 daemon·agent） |
| 自主生命周期 | ⛔ 未做（已暂缓） | 仅被动（@/提醒/DM 触发），无主动巡检 |
| 第三方集成 | ⛔ 空壳（已暂缓） | `/api/integrations` 仅 stub，无凭证/OAuth/出站 |
| 容器化 / 部署 | 🟡 暂缓 | 用户决定暂不做容器化；其余 P0 已补 |

> 图例：✅ 完成　🟡 部分/薄弱　⛔ 未做

---

## 三、已实现能力（细化）

### 3.1 协作核心
- **消息**：发送、分页历史、编辑（带"已编辑"）、@提及自动邀请 Agent 入频道、`to_tsvector` 全文搜索（已按调用方可见频道收口，不泄露私有/DM）。
- **线程**：任意消息可开线程，回复进入线程视图，主频道只显示回复数。
- **频道**：公开/私有；私有仅成员可见可读可收；owner/admin/member 角色；邀请人或 Agent、移除、改角色、归档、删除（连带 reactions/attachments/action_cards/messages/members）。
- **任务**：频道内消息即任务（task_number/status/assignee）；todo→in_progress→in_review→done→closed；认领冲突处理；前端拖拽看板。
- **提醒**：时长/重复/snooze/update；到点经 daemon 唤醒 Agent 跟进；调度器用 `FOR UPDATE SKIP LOCKED` 原子认领，多实例不重复 fire，并写 `reminder_events`。
- **附件**：本地磁盘（`storage.ts` 预留 MinIO 接口）、10MB、图片内联预览、`message_attachments` 关联。
- **私信 DM**：复用 channels(type='dm') + 确定性频道名；三种维度统一；成员定向投递；Agent 收到私信无需 @ 自动回复；前端 DmView + 侧栏私信区。

### 3.2 Agent / daemon
- 本机 daemon 连接服务端 WS，按 @提及 / DM / 提醒唤醒对应 Agent。
- Agent 自主模式：daemon 不转发文本，Agent 用本机打包的 `slock` CLI 自行 send/read/check/search/react/task/profile/reminder/attachment。
- 持久 Claude 进程（保温、降回合延迟）+ 一次性 `--print` 回退开关。
- 每 Agent 专属持久工作区 + `MEMORY.md` 跨会话记忆；System Prompt 注入身份与能力清单。
- 服务化：supervisor 文件 watch + 崩溃自重启 + 干净退出。

### 3.3 安全 / 工程化（2026-05-30 P2）
- httpOnly `access_token` cookie + 可读 `csrf_token`；double-submit CSRF；Bearer（机器令牌）豁免；浏览器 WS 改走 cookie（修了此前一律 anon、私有/DM 实时收不到的老问题）。
- 登录设备列表（`user_sessions`，可远程下线单设备/全部）。
- 账户数据导出（JSON）+ 软注销（吊销令牌、清 PII、保留历史消息）。
- 单一权威幂等 schema（`000_canonical_schema.sql`），空库可一键重建；去掉 serverId 硬编码。

---

## 四、对标 Slock 的优化空间（按优先级）

> 真 Slock 的关键差异化：常驻自主 Agent、Slock Agent Login（per-agent 第三方登录）、成熟的多租户与可观测性。下面按"投入产出比"排序。

### P0（基础工程成熟度）— 2026-05-30 已补（容器化除外）
1. ✅ **自动化测试 + CI**：已加 vitest 黑盒集成测试（auth/cookie/CSRF/sessions/deactivate、DM 三向+隔离、tasks 流转、health/metrics，13 例全绿）+ `.github/workflows/ci.yml`（postgres service → typecheck → migrate → 起服务 → 跑测试）。顺带把服务端 `tsc --noEmit` 修到 0 报错，CI typecheck 可作硬门禁。
2. ✅ **可观测性**：结构化日志（pino）+ 请求 ID、统一 `setErrorHandler`（结构化记录+错误计数+不泄露堆栈）、`GET /api/metrics`（uptime/内存/计数器 messagesSent·dmSent·remindersFired·logins·errors + 在线 daemon·agent 数）。
3. 🟡 **部署 / 容器化**：用户决定**暂缓**。后续若做：Dockerfile + compose（pg+server+web）、环境变量收口（JWT_SECRET/REFRESH_SECRET 必填校验）、生产 cookie 加 Secure。

### P1（贴近 Slock 的协作体验）
4. **纯 httpOnly 硬化**：前端仍在 localStorage 留 JWT 作 Bearer 过渡；去掉它、全走 cookie，才真正防 XSS 窃取 token（需强制重登一次）。
5. **多实例水平扩展**：登录限流、mention 解析等仍是内存态；WS 单进程广播。要多实例需 Redis（限流/pub-sub 广播）。调度器已并发安全，是好起点。
6. **通知系统**：未读已有雏形，但缺系统级通知（@我、DM、任务指派、提醒）聚合与桌面/邮件推送。
7. **DM 群组 / 多人私聊**：当前 DM 固定两人；Slock 支持多人 group DM。
8. **搜索增强**：`to_tsvector('simple')` 对中文不分词；接 `pg_jieba` 或 zhparser 才好用。
9. **Action Cards 完善**：表已建、路由仅 prepare 雏形；补完"人点击提交、以人身份执行"的闭环（建频道/建 Agent 快捷提交）。

### P2（Slock 的进阶差异化，已与你确认暂缓）
10. **自主生命周期**：常驻心跳巡检、自驱认领任务、长任务续跑——"被动工具→真同事"的分水岭。建议先做最小版（开关+限频）。
11. **第三方集成**：`/api/integrations` 现为空壳。由浅到深：出站 Webhook（低风险高价值）→ per-agent 凭证注入（独立 HOME/env）→ Slock Agent Login 式 OAuth 代理。
12. **权限 / 审计**：更细的角色权限、操作审计日志（谁改了什么）。

### P3（体验锦上添花）
13. 富文本/代码块增强、语音/视频、表情回应聚合展示、消息置顶/收藏、移动端适配、文件存储切 MinIO/S3。

---

## 五、建议路线

- ~~**先补安全网与可运维性（P0）**~~：✅ 已补（测试+CI、可观测性）；容器化按用户决定暂缓。项目现已"敢改"——改完跑 `pnpm --filter @collabagent/server test` 即可回归。
- **下一步：贴近 Slock 的体验（P1）**：纯 httpOnly 硬化 + 通知系统 + 中文搜索分词，性价比最高。
- **差异化（P2）按需启动**：自主生命周期 / 第三方集成已暂缓，需要时从"最小可用 + 开关 + 限频/出站 webhook"切入，别一次做满。

---

## 附：docs 目录结构（2026-05-30 整理后）

```
docs/
  2026-05-30/   当前权威：本分析 + 完成情况（开发版）+ 功能概览（同事版）+ Agent-Daemon 改造计划
  2026-05-29/   规划存档：功能优化规划(01-06) + 功能模块(01-05)
  2026-05-25/   Slock 逆向参考：slock-architecture / slock-protocol-analysis
```
其余早期重复的完成度/UX/逆向计划文档已清除（git 历史可追溯）。
