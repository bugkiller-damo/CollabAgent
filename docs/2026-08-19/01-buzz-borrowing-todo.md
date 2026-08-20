# Slock 待办清单（对标 Buzz 功能设计借鉴）

> 日期：2026-08-19
> 状态基线：O1–O20 工程优化 **已全部落地**（见 git log `8b2c36f`…`6e3fe53`）；
> daemon 改造 A1/A2/B1/C1 **已全部落地**（commit `1b3764d`/`034def1`/`27dfd49`/`83b526c`）。
> 本文聚焦**下一步功能设计借鉴**（Buzz 的产品级能力）+ 既有遗留事项收尾。
> 衔接文档：`2026-08-16/02-buzz-vs-slock-optimization-plan.md`（O 系列）、
> `2026-08-18/02-buzz-vs-slock-daemon-analysis.md`（daemon 对比）、`2026-08-18/03`（改造方案）。

---

## 0. 一句话结论

工程与运行时差距已基本抹平；**剩余差距在产品能力面**——Buzz 把工作流、Forge、
社区主权、远程 agent、mesh 算力做成了「协议级一等公民」，而 slock 仍停留在
「频道 + 任务 + 提醒」的聊天壳。以下按优先级排列可借鉴项。

---

## 1. 高优先 · 产品能力借鉴（直接对齐 Buzz 愿景）

### T1【🔴 高】YAML-as-Code 工作流引擎（对标 `buzz-workflow`）
- **来源**：Buzz `crates/buzz-workflow` + VISION.md 的 ⚡ Workflows 面（触发器→步骤→审批门→Trace）。
- **slock 现状**：仅"消息一键转任务"+"提醒调度"，无自动化编排；agent 主动巡检/发起仍是空档（功能概览标注"规划中"）。
- **借鉴点**：
  1. 触发器（定时/webhook/消息/反应）→ 条件（evalexpr）→ 步骤（agent 调用/通知/状态变更）；
  2. **审批门**——高风险动作需人类 👍 才执行（与现有审计事件天然契合）；
  3. Trace 可回放（复用 O2 events 哈希链）。
- **验收**：一条"每周汇总频道 → agent 起草 → 人类审批 → 发出"workflow 可定义、可触发、可审计。
- **预估**：大 | 依赖：O2 events（已落地）。

### T2【🔴 高】agent 自主巡检 / 定时主动发起（对标 `VISION_REMOTE_AGENTS` + reminders 升级）✅ 已落地 2026-08-19
- **落地**：migration `012_patrol_jobs.sql`(kind/instructions/paused/沉默计数);scheduler
  护栏(沉默判定/空转自动暂停/outcome 回写);daemon patrol prompt 分流;`slock patrol`
  CLI 命令组;管理后台 Agent 卡片「巡检」面板。测试:daemon 6 + server 9+8 全绿。
- **遗留**：scheduler tick 行为(沉默判定→自动暂停)靠手动 E2E 剧本覆盖(02 文档 §5 L3);
  标准 cron 语法/时区未做(白名单 repeat 够用)。
- **来源**：Buzz 远程 agent「无人在场也能干、沉默自回收」+ slock 功能概览"更主动的自己巡检/发起还在规划"。
- **slock 现状**：agent 被 @ / 私信 / 到点提醒才动；reminder 已是 schedule 雏形（`FOR UPDATE SKIP LOCKED` 认领）。
- **借鉴点**：把 reminder 推广为 agent cron（"每 2h 检查 X""到点巡检频道"），产出走派发队列（A1 已落地）自动投递；自不活跃自回收（idle-reclaimer 已有雏形）。
- **验收**：agent 能按 cron 自主发消息/推进任务，无人对话时自动休眠。
- **预估**：中 | 依赖：reminder scheduler、A1 队列、idle-reclaimer。

### T8【🔴 高】频道经理自动分诊——无 @ 消息经理接活/派单（2026-08-19 讨论增补）
- **来源**：T2 讨论中暴露的事件触发缺口——T2 是「到点自己来」，频道里「有事立刻来」
  需要事件触发；对齐 Buzz 远程 agent 团队「经理路由」愿景。
- **slock 现状**：无 @ 消息不唤醒任何 agent（`messages.ts` 只在 `content.includes("@")`
  时算 mentionAgents）；但经理（`is_manager`）、派单工具（`dispatch_task`+forceDeliverTo）、
  A1 合并、防自环已全部就位。
- **借鉴点**：human 顶层消息 + 无 agent 被唤醒 + 频道开关开 → server 单选经理随
  `agent:deliver` 下发 `triageAgents` → daemon 分诊 prompt（自己回 / dispatch 派单 /
  沉默三选一）；频道级 opt-in 开关控 token 成本。
- **验收**：开开关的频道发无 @ 求助 → 经理自动醒：直接回或派给 worker，worker 回报闭环；
  闲聊沉默；连发多条只醒一次（A1 合并）。
- **预估**：小（2~3 天）| 依赖：A1 ✅ / dispatch ✅ / 沉默协议模式（与 T2 共享）。
- **设计文档**：`2026-08-19/03-t8-manager-triage-design.md`。

### T3【🟡 中】任务/工作项协议化（对标 `VISION_ACTIVITY` 活动馈送 + Projects）
- **来源**：Buzz「动词+对象+结果」卡片式 agent 活动馈送 + Tasks 审批。
- **slock 现状**：TaskBoard 看板 + dispatch↔看板同步已有，但任务只是状态字段，无结构化"活动卡"。
- **借鉴点**：agent 的每个动作产出标准活动卡（做了什么/结果如何/证据链接），供人类一屏监督；任务完成/审批进审计链。
- **验收**：agent 工作全程在活动馈送中可回放，不靠进频道翻消息。

### T4【🟡 中】结构化观察帧即产品（对标 Buzz observer，承接 B1）
- **来源**：Buzz ObserverEvent 结构化遥测；slock B1 已落地观察帧面板（`27dfd49`）。
- **借鉴点**：把 B1 观察帧从"开发调试面板"升级为**用户向「agent 在干什么」卡片流**（对齐 VISION_ACTIVITY 的委托监督窗口），而非裸露终端帧。
- **验收**：非技术用户能从观察面板读懂 agent 进度，无需看终端。

---

## 2. 中优先 · 平台化借鉴（视产品方向取舍）

### T5【🟡 中】Forge / 代码协作面（对标 `VISION_PROJECTS` Nostr 原生 forge）
- **来源**：Buzz「分支即频道 + 补丁 NIP-34 + 审批门 + merge 协调」。
- **slock 现状**：无 git/代码协作概念。
- **决策点**：⚠️ **需先确认 slock 是否要进 Forge 领域**——这与"安全渗透测试系统"主赛道可能不同向。若不进，标记 Won't Do。
- **若借鉴**：最小集 = repo 抽象 + 分支绑定频道 + 代码 review 走 agent。
- **预估**：大 | 状态：**待产品决策**。

### T6【🟡 中】主权部署 / URL 即社区（对标 `VISION_SOVEREIGN`）
- **来源**：Buzz「一个域名一个项目，relay 即工作区」。
- **slock 现状**：O3 已落地请求级租户解析 + server 级 RBAC（单租户豁免）。
- **借鉴点**：把租户边界上提到 host（`team-a.slock.com` vs `team-b.slock.com`），O3 已具备条件，仅需 host→server 解析 + 跨社区零泄漏断言测试。
- **验收**：两个 host 各自社区数据互不串号（复用 Buzz multi-tenant 思路）。

### T7【🟢 低】mesh 算力 / huddle 语音（对标 `VISION_MESH` / huddle）
- **来源**：Buzz 成员闲置 GPU 池化 + 语音房。
- **slock 现状**：无。属远期差异化，与主赛道弱相关。
- **状态**：**冻结**，除非产品明确要做。

---

## 3. 既有遗留事项收尾（来自 03 方案补记，非 Buzz 借鉴）

| # | 事项 | 说明 | 建议 |
|---|---|---|---|
| L1 | A2 env 白名单**默认值翻正** | 当前默认 warn-only；翻正=默认收紧，`SLOCK_ENV_INHERIT=1` 降级 | `SLOCK_ENV_WHITELIST=1` 跑一段时间无工具链断裂后翻正 |
| L2 | **Steer 语义**（进行中回合注入） | 回复守卫已验证回合边界注入；真 steer 依赖 claude stream-json 能力 | 远期，先验证 claude CLI 能力再立项 |
| L3 | **PTY 模式整体退役** | 4 个 workaround 的最终删除条件 | headless 长期稳定后评估 |
| L4 | agent 引导层加固 | 系统提示加「网络命令必须带 `--max-time`」（curl 挂死=回合挂死源） | 随手可做，低风险 |
| L5 | 已知边界调优 | 超长生成 >300s 被不活跃超时误杀（`SLOCK_PERSISTENT_TURN_MS` 暂设 600000）；grok 中转下 WebFetch 不可用；**T2 E2E 新增**：persistent 路径闲置回收疑似未覆盖（40min+ 未回收）、续期会话沉默播报惯性、reclaim 默认实为 30min | 按需调参，文档已记 |

---

## 4. 待办汇总表（可勾选）

| # | 任务 | 优先级 | 预估 | 依赖 | 状态 |
|---|---|---|---|---|---|
| T1 | YAML 工作流引擎 + 审批门 + Trace | 🔴 高 | 大 | O2 events ✅ | ☐ |
| T2 | agent 自主巡检 / cron 主动发起 | 🔴 高 | 中 | A1 ✅ / scheduler ✅ | ✅ 2026-08-19 |
| T8 | 频道经理自动分诊（无 @ 接活/派单） | 🔴 高 | 小 | A1 ✅ / dispatch ✅ | ☐ |
| T3 | 任务活动馈送（动词+对象+结果卡） | 🟡 中 | 中 | O2 events ✅ | ☐ |
| T4 | 观察帧升级为产品级活动面板 | 🟡 中 | 中 | B1 ✅ | ☐ |
| T5 | Forge / 代码协作面（**待产品决策**） | 🟡 中 | 大 | — | 🔶 待定 |
| T6 | URL 即社区 / 主权部署 | 🟡 中 | 中 | O3 ✅ | ☐ |
| T7 | mesh 算力 / huddle | 🟢 低 | 大 | — | 🧊 冻结 |
| L1 | env 白名单默认值翻正 | 🟡 中 | 小 | — | ☐ |
| L2 | Steer 语义 | 🟢 低 | 待验证 | claude 能力 | ☐ |
| L3 | PTY 模式退役 | 🟢 低 | 中 | headless 稳定 | ☐ |
| L4 | 网络命令 `--max-time` 引导加固 | 🟢 低 | 随手 | — | ☐ |
| L5 | 已知边界调优 | 🟢 低 | 小 | — | ☐ |

---

## 5. 建议落地顺序

**近期（1–2 周，产品增益最大）**：T2 自主巡检 → T8 经理分诊 → T3 活动馈送 → T4 观察面板产品化。
> 理由：T2/T8 是 agent 主动性的两条腿（定时触发 + 事件触发），共享沉默协议与 A1/dispatch
> 底座、代码面不冲突；落地后「把消息丢进频道，AI 团队自己接单分工交付」闭环成型。
> T3/T4 再把这个闭环变得可监督。四者共用已落地的 O2 events + A1 队列 + B1 观察帧，
> 不碰产品形态风险。

**中期（视赛道）**：T1 工作流引擎（审批门是差异化关键）→ T6 URL 即社区。
**待决策**：T5 Forge（先确认是否进代码协作赛道）。
**冻结**：T7 mesh/huddle。
**随手**：L4；**滚动**：L1/L2/L3/L5。

---

## 附 · 不应照搬 Buzz 的部分（避免过度设计）

- **8-session 并发池 / JSON-RPC steer-cancel**：slock 偏"人类围观 PTY"，headless 已够用。
- **Nostr 事件签名 / kind 分发 / Redis gossip**：slock 关系模型 + Map/earlyBuffer 已够，无需换成 Nostr 协议。
- **branch-as-channel / 30621 项目分组**：slock 无 repo 概念（除非 T5 立项）。
- **完整 mobile/桌面端**：slock 单 web 端定位清晰，不盲目扩端。
