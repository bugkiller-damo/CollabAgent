# 方案 1-4 未做/待办事项汇总

**日期**: 2026-07-16
**背景**: 方案一（测试补齐）、方案二（MCP 化）、方案三（autostart + session resume）、方案四（`agent-runtime.ts` 拆分）四份设计文档已全部实现完毕（详见各文档末尾的"执行记录"）。这份文档把四份执行记录 + `08-hive-alignment-gap-analysis.md` 里散落的"未做/待验证/已知粗糙点"统一汇总，供后续排期参考。

---

## 一句话总览

四个方案的**代码本身**都已落地、`tsc` 干净、81 个自动化测试全部通过。原本有 3 项核心机制从未在真实 Claude Code + 真实服务器上跑过；其中 **MCP 信任对话框防御已于 2026-07-16 完成真机验证并通过**，**session resume 也已于 2026-07-16/17 真机验证过一轮，并且这次验证直接揪出并修复了一个真实 bug**（详见下方"1"）——消息在特定时序下会静默丢失，跟 resume 重试逻辑本身对不对是两回事，是一个更基础的漏洞。其余是范围内的已知取舍或明确延后到未来的能力缺口。

---

## 🔴 高风险 / 需要真机验证（建议优先做）

这几项的共同特点：代码逻辑本身经过仔细设计和（能做到的范围内的）测试，但**依赖 Claude Code 真实交互行为的某个假设，这次环境里没有真实 Claude Code + 真实服务器可以验证**。这类问题正是这次会话前半段 12 个 live bug 的共同来源。

### ~~1. MCP 信任对话框防御（方案二）~~ ✅ 已于 2026-07-16 真机验证通过
- **是什么**：`agent-runtime-spawn.ts` 给每个 agent workspace 写了 `.claude/settings.local.json`（`enableAllProjectMcpServers: true`），目的是跳过 Claude Code 首次发现新 `.mcp.json` 时弹出的"是否信任这个项目的 MCP server"确认对话框。
- **验证方式**：用户实测了一次真实的 `@716测试机` 消息分发，事后直接读取这次运行的真实 session transcript（`~/.claude/projects/<mangled>/5bb0b20b-....jsonl`）核实：
  - transcript 里的工具调用名是 `mcp__slock__send_message`（Claude Code 对 MCP 工具的标准命名 `mcp__<server>__<tool>`），不是 Bash 调 CLI——证明 `.mcp.json` 被成功发现并连接，agent 也确实优先选用了 MCP 工具。
  - 全文搜 "trust"/"approve"/"mcp server" 无命中，时间线正常，没有异常长停顿。
  - 日志本身也显示整个回合正常收尾，消息确实发出去了。
- **结论**：防御按预期生效，`agent-runtime-terms-dialog.ts` 目前不需要再加对应分支。详见 `12-mcp-server-plan.md` 里补充的"真机验证通过"记录。

### 1. Session resume 的 `--resume` 消费路径（方案三）—— ⚠️ 真机验证已做，且揪出并修复了一个真实 bug
- **是什么**：`SLOCK_SESSION_RESUME=1` 时，spawn 会带上 `--resume <上次的 sessionId>`。
- **2026-07-16/17 验证结果**：用户按 `13-autostart-session-resume-plan.md` 里的步骤，手工把 `daemon-state.json` 里的 `lastSessionId` 改成假 UUID、打开 `SLOCK_SESSION_RESUME=1` 实测。发现 Claude Code 遇到假 `--resume` 确实会失败退出（`exit=1`），**但失败得比原来 3 秒的宽限期检测更慢**——真正退出发生在 daemon 已经打出"message dispatched"日志之后。这暴露了一个比"resume 重试对不对"更基础的漏洞：`attemptSpawn` 返回到 bootstrap 真正写入之间有一段没人守着的窗口，PTY 在这段窗口里死掉的话，bootstrap 消息会被写进一个空壳 PTY，静默消失，没有任何重试或提示。
- **已修复**：在 bootstrap 真正写入之前，加了一道存活检测——如果 run 已经死了且是一次没重试过的 resume 尝试，清空坏掉的 sessionId 并整个重新 spawn 一次（不带 `--resume`）来补投递原始消息；如果死因跟 resume 无关，至少会打一条清晰的错误日志，而不是完全沉默。新增的回归测试用 fake PTY 精确复现了这个时序。详见 `13-autostart-session-resume-plan.md` 的"真机验证记录"一节。
- **仍然不知道的部分**：Claude Code 遇到坏 `--resume` 时打印的**原始文字**是什么样的——这次验证是从退出码和时序反推出"失败了"这个事实，没有人工确认过屏幕上具体显示的错误信息。不影响当前修复的正确性（修复只依赖"run 是否还活着"这个可观察事实），但如果之后想做更精细的错误分类，需要专门看一次 `SLOCK_VERBOSE_PTY=1` 的原始输出。

### 2. 服务端 scoped runtime token 的历史遗留权衡（早于本轮四个方案，仍然生效）
- **是什么**：来自 `08-hive-alignment-gap-analysis.md` 记录的 bug 7——daemon 目前把完整的账号级 `apiKey` 当作 `SLOCK_AGENT_TOKEN` 注入子进程环境（P1 后已经换成了 scoped 的 `sk_agent_...` token，见 `09-server-agent-auth-gap-analysis.md`，**这条实际上已经解决**，这里放进来是提醒一下：如果之后又在什么地方回退到共享 apiKey 的写法，要意识到这是个已知的安全边界问题，不要重新引入）。
- **现状**：P1 已完成 scoped token 机制并接入 MCP/CLI 两条通道，这条风险目前处于"已缓解"状态，不再是本轮遗留项，仅作为历史记录留存，防止未来改动时误退回旧方案。

---

## 🟡 已知但接受的粗糙点（不阻塞，值得留意）

### 方案二（MCP 化）
- **附件没有 MCP 化**：`send_message` 工具没有 `attachmentIds` 参数，上传附件仍然只能走 `slock attachment upload` CLI，发消息时要么用 CLI 带 `--attachment-id`，要么用 MCP 但发不了附件。如果要补，需要给 `send_message` 加参数 + 单独做一个 `upload_attachment` 工具（要处理 `multipart/form-data`，目前 `callSlock` 是 JSON-only 实现）。
- **`list_reminders`/`cancel_reminder`（低频档）没有 MCP 化**：按设计文档自己的优先级分层，这两个继续走 CLI，是刻意的范围缩减，不是遗漏。
- **并发首次 spawn 的打包竞态没有专门测试**：`bundleSlockMcpServer()` 用了 memoized promise，理论上多个 agent 同时首次 spawn 时应该都拿到同一个 in-flight promise，不会重复打包，但没有写并发测试钉死这一点。

### 方案三（autostart + session resume）
- **Autostart 的系统提示语气矛盾**：autostart 触发时注入的"不用主动发言"指令，和系统提示默认框架"你被 @ 了，请回复"同时出现在同一次 bootstrap 里，语气上有点矛盾。如果真机测试发现 agent 在 autostart 之后经常误发不必要的消息，需要回来给 `system-prompt.ts` 加一个专门的 autostart 分支。
- **方案 B（`agents` 表加 `autostart: boolean` 字段）没有做**：设计文档明确说这个留给"有明确产品需求（比如某个 agent 需要 24 小时常驻监听）时再做"，需要服务端配合加字段 + 管理界面。
- **`vitest.config.ts` 的 `fileParallelism: false` 只在这台开发机上验证过**：这是为了解决一个测试套件并发导致的偶发超时问题加的，没有在其他机器/CI 环境验证是否还需要、或者有没有更精细的调度方式（比如限制 worker 数而不是完全关掉并行）。

### 方案四（`agent-runtime.ts` 拆分）
- **`resolveClaudeBinary`/`resolveCmdShimTarget`/`PTY_COMMAND` 还留在 `agent-runtime.ts` 顶层**：没有按原计划拆到独立的 `command-resolver-claude.ts` 或合并进现有 `command-resolver.ts`。这几个函数不依赖任何运行时状态，风险最低，随时可以单独当一个小任务处理。
- **新拆出来的模块没有补充针对性的纯单元测试**（比如单独测 `agent-runtime-terms-dialog.ts` 的 `isClaudeAcceptDialog`）：现有的集成测试（`round-end.integration.test.ts` 等）通过 fake-agent-manager 间接覆盖到了这些模块的行为，覆盖率没有下降，但如果之后要在某个模块内部做更细粒度的改动，针对性的单元测试会更容易定位问题。

### 方案一（测试补齐）
- **`doDispatch` 的 `PersistentClaude`/`claudePrint` 兜底路径（`usePty=false` 时）没有测试**：这条路径本身在整个会话里也没有被实机验证过，优先级较低（默认走 PTY 模式，这条是历史兜底路径）。
- **`installTermsAcceptHandler` 检测到真实 Accept-Permissions 对话框、发送 "2"+回车这条分支没有单独测试**：可以后续补一个对应 fixture。

---

## ⚪ 明确延后 / 非本轮范围（早于四个方案就记录在案）

以下几项来自 `08-hive-alignment-gap-analysis.md`，四个方案都没有覆盖，且原文明确标注"非本轮范围"：

- **多 CLI 支持**（`command-presets.ts`/`agent-stdin-writer.ts` 目前虽然写了预设表，但 `agent-runtime.ts` 仍然硬编码 Claude-only 的启动参数）——是否支持 codex/gemini/opencode 需要产品侧决策。
- **`daemon-core.ts` 硬编码 `agentId`**（`00000000-0000-0000-0000-000000000001`，安全模型文档 S-04 项）。
- **daemon 向服务端上报自身状态**（`03-state-machine.md §9` 设计过，未实现）。
- **WS 连接超时 + 消息体 zod 校验**（`05-security-model.md §8` 设计过，未实现）。

---

## 建议的下一步

1. **🔴 里两项核心机制都已经过真机验证**：MCP 信任对话框防御直接通过；session resume 验证时发现了一个真实 bug（消息静默丢失）并已修复。如果还想更进一步，可以再跑一次同样的假 sessionId 测试，确认这次修复后 agent 真的收到并回复了那条触发消息（之前那次因为 bug 没收到回复）。
2. 🟡 里的粗糙点不阻塞正常使用，可以按实际遇到的痛感（比如真的观察到 autostart 发了不该发的消息）再回来处理，不需要抢跑。
3. ⚪ 里的几项建议等有明确产品需求时再排期，不建议现在花时间做。
