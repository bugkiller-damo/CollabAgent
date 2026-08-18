# PTY 键盘链路 vs 结构化通道——O13 代码面收敛对照

> 日期：2026-08-18
> 对应优化项：`docs/2026-08-16/02-buzz-vs-slock-optimization-plan.md` O13（🟢 低）
> Buzz 对照基线：`D:\code\buzz`（crates/buzz-agent、buzz-acp、buzz-dev-mcp）

## 0. 一句话结论

slock 的**平台高频操作已 100% 走 MCP**（17 工具），PTY 键盘模拟只剩「往 claude TUI
输入框写消息」这一条无法被 MCP 替代的通道，及其衍生的三组时序/检测启发式。
每个 workaround 已补「何时可删」注释（grep `何时可删（O13）`）。中期方向与 buzz
一致：**agent 运行时 headless 化**（stream-json 持久会话或 ACP 类 stdio JSON-RPC），
PTY 降为降级路径——前置是补上结构化观察遥测替代终端截屏。

## 1. Buzz 的做法（调研纪要）

### 1.1 buzz-agent：agent 不是 TUI，是 stdio JSON-RPC 进程

- `crates/buzz-agent/src/wire.rs`：wire 协议就是 JSON-RPC——`initialize` /
  `session/new` / `session/prompt` / `session/cancel` / `session/steer` /
  `session/set_model`，`Inbound::Request/Notification` 枚举。
- `crates/buzz-agent/src/lib.rs`：`App { cfg, llm, sessions, mcp }`——LLM 在进程内
  直接驱动（`Llm`），工具经 `McpRegistry` 调用，**全链路无一处 PTY**。
  用户消息 = `session/prompt` 的 `Vec<ContentBlock>`（"tool-calls-as-output +
  可审计"：一切皆是结构化事件流）。
- 附带发现：lib.rs 里 `WINDOWS_SHELL_RESOLUTION_ENV` 明确列出「转发给 MCP 子进程
  的白名单 env」——buzz 的子进程 env 是**默认清空 + 显式转发**，比 slock 的
  `{...process.env, ...}` 全量继承更严（slock 侧 O11 已剥离 token，全量继承的
  进一步收敛留作后续项）。

### 1.2 buzz-acp：pool 化管理多个 agent 进程

- `crates/buzz-acp/src/pool.rs`：`AgentPool` / `OwnedAgent` / `PromptOutcome` /
  `TimeoutKind`——agent 进程的池化、排队、超时、取消都是结构化语义。
- `queue.rs`（EventQueue/CancelReason）+ `relay.rs`（HarnessRelay）：平台事件
  （nostr kind：STREAM_MESSAGE / REMINDER / WORKFLOW_APPROVAL…）排队后按序投递给
  agent 的 prompt 通道。
- `observer.rs`：观察遥测走 `OBSERVER_FRAME_TELEMETRY` 结构化帧——**不是**终端
  截屏。这正是 slock 终端观察面板（消费 PTY 渲染帧）迁移结构化前缺的最后一块。

### 1.3 buzz-dev-mcp：最小开发工具面

`crates/buzz-dev-mcp/src/`（7 个工具，每个文件的描述都在引导 LLM 用对工具）：

| 工具 | 语义 | 设计细节 |
|---|---|---|
| `shell` | 跑 shell 命令（每调用独立进程） | 输出尾部截断 ~8KB 给 LLM，完整前 10MB 落 artifact 文件；timeout 默认 120s 封顶 600s |
| `read_file` | 读文件（带行号、offset/limit 窗口） | 描述明说 "Prefer over cat/head/tail" |
| `str_replace` | 原子查找替换（返回 unified diff） | "Prefer over sed/awk" |
| `rg` / `tree` | 检索/目录树 | 以 multicall symlink 形式上 PATH（shim） |
| `todo` | 待办管理 | |
| `view_image` | 多模态看图（缩放/转码/限额） | |

- `shim.rs`：session 级 0700 临时目录 + multicall symlink；**私钥写 0600 keyfile
  后从 env 删除**——与 slock O11 的 token 文件化是同构手法（交叉验证方向正确）。

## 2. slock 通道现状对照

### 2.1 平台操作（agent → server）——已全部结构化

| 操作类 | MCP 工具 | 备注 |
|---|---|---|
| 发消息 | `send_message` | 高频 No.1 |
| 读消息 | `read_history` / `check_messages` / `search_messages` | |
| 附件 | `upload_attachment` | |
| 任务 | `list/create/claim/update_status/unclaim/report_task` | 看板全操作 |
| 派发 | `dispatch_task` / `list_dispatches` / `cancel_dispatch` | |
| 提醒 | `schedule/list/cancel_reminder` | |

MCP 覆盖不了的平台低频操作（profile/integrations 等）走 `slock` CLI 兜底——
这是设计内的长期并存，不是债务。

### 2.2 剩余 PTY 键盘路径（server/用户 → agent 输入框）

| 路径 | 模块 | 性质 | 删除条件摘要 |
|---|---|---|---|
| 提示符就绪轮询 + bracketed paste + paste-ack + Enter 时序 | `post-start-input-writer.ts` | workaround（4/12 bug 链根源区） | 输入通道结构化（stream-json/ACP），且观察遥测替代 PTY 帧 |
| Terms/权限弹窗检测 + 自动应答 | `agent-runtime-terms-dialog.ts` | workaround | claude 提供非交互预接受，或 TUI 退役 |
| 回合结束检测（busy 标记 + ❯ 启发式） | `agent-runtime-turn-tracker.ts` + `agent-runtime.ts` 静默兜底 | workaround | stream-json 的 `result` 事件即精确回合边界 |
| sessionId 捕获（扫 jsonl 目录最新 mtime） | `agent-sessions.ts` | workaround | stream-json init 事件自带 session_id（one-shot/PersistentClaude 已在用） |
| 六类系统消息信封 | `agent-stdin-dispatcher.ts` | **非** workaround | 通道结构化后只换 writer，格式保留 |

## 3. 中期路线（方向记录，不在本轮施工）

1. **PersistentClaude 补齐**：本仓已有 `SLOCK_PERSISTENT_CLAUDE=1` 的 stream-json
   持久会话路径（stdin 写 JSON-RPC、无键盘模拟、`result` 事件精确回合边界、
   init 事件自带 sessionId）。它缺的是**观察能力**——终端观察面板消费 PTY 帧。
   补齐方式：把 stream-json 输出事件渲染成观察帧（对照 buzz observer 遥测）。
2. 此后 PTY 模式降级为「需要真 TUI 调试时的 fallback」，上文四组 workaround
   随默认路径切换自然死亡。
3. 更远的形态即 buzz-agent 本体：agent 进程内直驱 LLM + MCP 工具注册表，
   无 CLI 壳——那是平台级重写，仅作方向锚点。

## 4. 验收对照

- [x] MCP 工具覆盖高频操作（17 工具，见 §2.1）
- [x] 每个 PTY workaround 补「何时可删」注释（grep `何时可删（O13）`，共 5 处）
- [x] PTY 键盘路径明确为「消息输入唯一剩余通道 + 降级路径」定位（§2.2/§3）
