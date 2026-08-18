# Buzz vs Slock · daemon/Agent 运行时优劣对比分析

> 日期：2026-08-18
> 方法：graph 子 agent 探查（部分超时/沙箱失败后）+ 主线直接精读两侧源码
> Buzz 侧范围：`crates/buzz-agent`（headless agent 本体）、`crates/buzz-acp`（进程池/队列/中继/观察）、`crates/buzz-dev-mcp`（开发工具面）、`crates/sprig`（三合一发布形态）
> Slock 侧范围：`packages/daemon`（supervisor / daemon-core / agent-runtime* / MCP server / CLI / credentials）

## 0. 定位差异（理解优劣的前提）

| | Buzz | Slock |
|---|---|---|
| agent 形态 | **headless**：buzz-agent 是 stdio JSON-RPC（ACP wire）进程，LLM 进程内直驱 | **TUI**：PTY 里跑 claude CLI 交互界面 |
| 协作模型 | 自托管 nostr 工作区，事件驱动 | AI 原生团队平台，WS 派发 + 人类围观 |
| 观察面 | 开发者向遥测（observer 帧） | **用户向终端画面**（浏览器实时围观 PTY 帧 + 历史落盘） |
| 发布形态 | sprig 单二进制（harness+agent+dev-mcp 三合一，独立 tag） | pnpm 包（dev 为主；O10 生产路径挂起中） |

定位决定形态：slock 要「人类能围观 agent 的终端画面」，PTY 是目前唯一来源；buzz 面向
自动化工作区，headless 是最优解。以下优劣均在这个前提下读。

## 1. 分维度对比

### 1.1 输入通道与回合边界（差距最大的一维）

| | Buzz | Slock |
|---|---|---|
| 消息投递 | `session/prompt` JSON-RPC，`Vec<ContentBlock>` 结构化 | PTY 键盘模拟：提示符轮询 → bracketed paste → paste-ack 等待 → Enter（post-start-input-writer） |
| 回合边界 | `StopReason` 协议级精确（EndTurn/Cancelled/MaxTokens/MaxTurnRequests/Refusal） | 屏幕启发式：busy 标记 + ❯ 检测 + 静默兜底（turn-tracker + 4 个 live bug 修复史） |
| 弹窗 | 不存在（无 TUI） | terms/权限弹窗检测 + 自动应答（terms-dialog；O12 白名单后权限弹窗 fail-closed） |

**Buzz 压倒性占优**。slock 这条链路是 4/12 bug 的根源区，且随 claude 每个版本的
UI 文案变动而脆弱。slock 已有 `PersistentClaude`（stream-json stdin）备选路径，
差距可收敛——见 §3。

### 1.2 忙碌门控与中断语义

| | Buzz | Slock |
|---|---|---|
| 忙碌时新消息 | `ControlSignal::Steer`——**不取消当前回合**，经 `_goose/unstable/session/steer` 或跨适配器 `_session/steering` 把消息注入进行中的回合；失败降级 cancel+merge（重排合并重提示，prompt 措辞两条路径同源构造防漂移） | 排队缓冲（`agent:delivery-queued`），空闲后按序投递；无「进行中注入」 |
| 取消/打断 | Cancel / Interrupt / Rotate / SwitchModel 四语义 + `CancelDrainTimeout`（取消未按期完成=进程中毒重建，触发批次按 CancelReason 决定重排或丢弃，绝不误报硬超时） | stop = 杀进程重启（粒度粗）；无打断合并语义 |
| 队列 | EventQueue：per-channel 队列 + in-flight 截止自动过期 + 指数退避重试（jitter）+ MAX_RETRIES 死信 + dedup 模式 + 批量合并重提示 | 无队列抽象（消息即派即忘；忙碌缓冲为单队列） |

**Buzz 占优**，尤其 steer 注入与死信/重试纪律。slock 的「排队等空闲」简单可靠但
放弃了「打断/补充进行中的工作」这一协作场景。

### 1.3 进程与状态管理

| | Buzz | Slock |
|---|---|---|
| 池化 | AgentPool/OwnedAgent：per-channel 槽位、会话失效/重建、模型切换即换新会话 | 每 agent 一个常驻 PTY，runId 登记（live-run-registry） |
| 状态机 | SessionState + ChannelDeliveryState + 配送状态细分 | 4 态（uninit/idle/starting/working/stopped）+ 时序保护链（exit-coordinator） |
| 重启 | poison 检测重建；sprig 单二进制自带监督 | supervisor 独立进程 watch + killTree + 计划重启标记 |
| 会话恢复 | session 失效即新会话（状态在 nostr 事件里，天然可重建） | `--resume` + jsonl mtime 捕获 + 宽限期重试（保住 TUI 上下文） |

大致互抵：buzz 的池化/失效语义更系统；slock 的常驻 PTY + resume 保住了「同一个
agent 持续人格」的体验（buzz 每次新会话反而丢失 TUI 上下文——但 buzz 本来就没有
TUI 上下文要保）。

### 1.4 工具面与权限

| | Buzz | Slock |
|---|---|---|
| 平台工具 | agent 内经 MCP registry 调外部 MCP；内置 `load_skill` 等 in-process 工具 | slock MCP server 17 工具（消息/任务/派发/提醒/附件）+ CLI 兜底 |
| 开发工具 | buzz-dev-mcp 7 工具（shell/read_file/str_replace/rg/tree/todo/view_image），输出截断+artifact 落盘、描述文案引导 LLM 用对工具 | 依赖 claude 内建工具（O12 白名单收敛） |
| 权限 | MCP 子进程 `env_clear()` + PASSTHROUGH 白名单；私钥 0600 keyfile 写后删 env | O11 token 文件化（0600）+ O12 工具白名单 |
| 审计 | 工具调用生命周期事件逐个 emit（pending/in_progress/completed/failed over wire）+ buzz-audit 哈希链 | 平台操作走 server 审计事件（O2）；agent 本地工具调用无独立审计流 |

buzz 的 env 默认清空纪律与工具调用审计流更严；slock 的平台工具面（17 个领域
工具）远厚于 buzz-dev-mcp 的通用开发面——**两者工具层解决的是不同问题**，
slock 的平台工具是协作协议的实体，buzz 的是开发环境的壳。

### 1.5 观察与遥测

| | Buzz | Slock |
|---|---|---|
| 机制 | ObserverEvent 结构化帧：seq/timestamp/kind/agent_index/channel_id/session_id/turn_id/payload + replay buffer + broadcast 订阅 | PTY 帧经 WS 推浏览器（terminal:frame，引用计数按需传输）+ 每 run 历史落盘 |
| 受众 | 开发者/运维 | **终端用户**（围观 agent 工作画面是产品功能） |

各有所长。buzz 的遥测是结构化、可机读的（对 agent 复盘友好）；slock 的画面流
对人类友好且「无人观看零开销」的引用计数设计比 buzz 还细。若 slock 迁
headless，需要用 buzz 式结构化帧重建等价的用户向观察能力。

### 1.6 工程纪律

| | Buzz | Slock |
|---|---|---|
| 语言/类型 | Rust，强类型穷尽枚举（行为语义全在类型里：TimeoutKind/CancelReason/SteerError…） | TS，接口 + 注释承载语义 |
| 文档化 | 关键决策写在类型 doc comment（含「为什么不」） | 中文注释同风格（踩坑史翔实），设计文档外置 docs/ |
| 测试 | conformance crate + 分层 CI | daemon 97 vitest（含真子进程 MCP/PTY 集成） |

互有千秋；buzz 的「语义入类型」在重构安全性上占优，slock 的测试资产在同规模
TS 项目里属上乘。

## 2. 结论：各自最该向对方学什么

**Slock 该拿（按性价比排序）**：
1. **headless 输入通道**（PersistentClaude 补观察遥测后转正）——一次性消掉
   §1.1 整组 workaround（O13 已标删除条件）。
2. **EventQueue 式派发队列**：per-channel in-flight + 退避重试 + 死信，替代
   「即派即忘 + 忙碌缓冲」（可独立于 headless 化先行）。
3. **Steer 语义**：进行中回合的消息注入（远期；依赖结构化通道）。
4. **MCP 子进程 env 默认清空 + 显式转发**（O11 的下一档收紧）。

**Slock 已有、Buzz 可借鉴**：
1. 用户向实时终端围观（引用计数按需传输）——buzz 的 observer 目前只服务开发者。
2. 常驻会话 + `--resume` 保住 agent 持续上下文（buzz 会话即抛即弃）。
3. 平台级 17 个领域 MCP 工具 + 审计事件链（O2）的厚度。

## 3. 与优化路线的衔接

- O13 文档（`docs/2026-08-18/01-pty-keyboard-vs-structured-channels.md`）已给出
  headless 化的删除条件与路线；本分析补上队列/中断/审计三维的差距细节。
- 新增候选（进 backlog，未排期）：
  - **B1** EventQueue 式派发队列（per-channel in-flight + 退避重试 + 死信）
  - **B2** MCP 子进程 env 清空+白名单（对齐 buzz `env_clear` 纪律）
  - **B3** agent 工具调用生命周期事件流（pending→completed）进审计（O2 的 agent 侧补充）
