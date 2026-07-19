# Slock Daemon 完成情况 × Hive 对照分析（2026-07-17）

> 范围：`packages/daemon/src/`（约 6000 行）对照 `D:\code\hive-main\src\server\` agent 子系统  
> 前置文档：`docs/2026-07-16/08-hive-alignment-gap-analysis.md`（接线缺口）、`15-remaining-gaps-summary.md`（遗留汇总）  
> 本文回答三个问题：① daemon 现在完成了什么；② 与 hive 比还差什么；③ slock 能否充分发挥 Claude Code 的能力。

---

## 一、当前完成情况（代码验证，非 goal-progress 自述）

### 1.1 已完成的可靠性链路（Phase 1-6 + 后续三轮联调）

| 能力 | 实现 | 状态 |
|------|------|------|
| PTY 进程托管 | `agent-manager.ts` + node-pty，进程组逐级终止 | ✅ 接入 |
| 四态状态机 | uninit/idle/starting/working/stopped + STUCK 检测（90s 阈值可调） | ✅ 接入（2026-07-17 补 idle→working 迁移） |
| 退出清理链 | onExit → token 撤销（匹配时）→ registry/runId/进程表清理 → 状态回 idle | ✅ 接入（Task 2.9） |
| Run 持久化 + 崩溃恢复 | JSON run store + `markUnfinishedRunsStale()` 启动时清理僵尸状态 | ✅ 接入（Task 2.10） |
| 重启摘要注入 | 有历史 run 时 bootstrap 附带 `formatRestartSummary()` | ✅ 接入 |
| Idle 回收 | 60s 无活动优雅关闭（触发走完整退出链） | ✅ 接入（Task 2.11） |
| Autostart | daemon 重启后自动拉起崩溃前活跃的 agent | ✅ 接入 |
| Session 捕获 + resume | 捕获常开；`--resume` 需 `SLOCK_SESSION_RESUME=1`，失败自动无 resume 重试一次 | ✅ 真机验证过一轮（修出一个消息静默丢失 bug） |
| Scoped runtime token | `sk_agent_*` 按 spawn 签发，PTY 退出吊销，替代共享账号 apiKey | ✅ 真机验证（Claude 直接用它调 slock 成功） |
| MCP 工具通道 | `.mcp.json` + `enableAllProjectMcpServers`，11 个结构化工具 | ✅ 真机验证（transcript 确认 `mcp__slock__send_message`） |
| 信任对话框防御 | terms-accept handler + bootstrap 写入等待 | ✅ 真机验证 |
| 回合结束检测 | `@xterm/headless` 终端状态跟踪器（screenText + busyObserved 不变量） | ✅ 结构性方案（替代了 4 次正则补丁） |
| 大段粘贴提交 | bracketed paste + ack 等待 + 延迟回车 | ✅（bug 12 后真正生效） |
| 经理派发 | 频道经理 → worker 的 dispatch/report/cancel 合同 + MCP 工具 | ✅（2026-07-17 特性） |
| @提及唤醒过滤 | server 预过滤 `mentionAgents`，无权 agent 不起 PTY | ✅（2026-07-17） |
| 中文 agent 名 | 候选集子串匹配，含边界判断 | ✅（2026-07-17） |
| 持久工作区 + MEMORY.md | 每 agent 专属 workspace，系统提示教读写 MEMORY.md | ✅ 接入 |

### 1.2 联调历程说明

daemon 经历过 12 个实机 bug 的完整联调（详见 `08-hive-alignment-gap-analysis.md` §6-§7），其中最有价值的结构性产出是：**回合结束检测从"正则扫描累积字节流"升级为"@xterm/headless 终端模拟器 + 忙碌→空闲转变不变量"**—— hive 靠 agent 主动上报绕开了这个问题，slock 用终端模拟器正面解决了它。目前这条链路是稳定的（连续多轮 1-4 分钟长回合正确收尾）。

---

## 二、与 Hive 的能力对照

### 2.1 已对齐甚至更好的部分

| 维度 | Hive | Slock | 评价 |
|------|------|-------|------|
| 进程管理 | node-pty + 进程组终止 | 同 | 持平 |
| Token 生命周期 | `revokeIfMatches` 防重启竞态 | 同逻辑已接入退出链 | 持平 |
| 崩溃恢复 | `markUnfinishedRunsStale` | 同语义（JSON store） | 持平（hive 用 SQLite，slock 用 JSON，规模内无差） |
| 重启上下文 | restart-policy 二选一注入 | restart-summary 追加注入 | 持平（slock 无 resume 冲突，简化合理） |
| 回合结束判定 | agent 工具调用主动上报 | 终端模拟器状态跟踪 | **路线不同，slock 更通用**（不依赖 agent 配合，任何 CLI 行为都能观察），但 hive 的方式天然免疫 UI 渲染变体 |
| 平台工具通道 | team CLI（stdin/positional） | MCP 工具（11 个）+ slock CLI 兜底 | **slock 更现代**：结构化 JSON Schema 调用，无 shell 转义问题；hive 的 `team report --stdin <<'EOF'` 方案是在 shell 约束下的 workaround |
| 记忆机制 | tasks-file（任务文件） | MEMORY.md + 专属 workspace | 取向不同：hive 重任务追踪，slock 重长期上下文 |
| 派发体系 | orchestrator → worker（team send/report/status/cancel + dispatch ledger） | 频道经理 → worker（dispatch_task/report_task/cancel_dispatch + DB 持久化） | 功能等价，slock 多了 Web 端可视化（消息合同标记） |
| 命令解析 | 不用 shell:true，手动 PATH/PATHEXT | 同（command-resolver.ts） | 持平 |

### 2.2 Hive 有而 Slock 没有

| 能力 | Hive 实现 | 价值 | 补齐难度 |
|------|-----------|------|----------|
| **实时终端观察** | `terminal-ws-server.ts`：`/ws/terminal/:runId/io` 双向流 + `control` 控制通道；`terminal-state-mirror.ts` 用 @xterm/headless + SerializeAddon 维护 10000 行 scrollback 镜像，新观众连上发 `restore` 快照；多观众 fanout + 背压暂停 | 高 —— 调试 agent 行为、理解"它在干什么"的最直接手段；slock 的 screenText 已经在 daemon 内部存在（但 scrollback: 0 只留当前帧），只差暴露 | 中：PTY output bus 已有，终端镜像要加大 scrollback + 加 WS 转发 + 前端 xterm.js |
| **防失忆机制（reminder tail）** | `hive-team-guidance.ts`：每条流向 orchestrator/worker 的消息**尾部**附加 `<hive-system-reminder>` XML 块（身份 + 当前可用动作 + 禁止事项）；注释明确说明设计理由——静态前缀会被当 banner 噪声过滤，尾部位置（recency）+ 动作菜单最有效；另有 `.hive/PROTOCOL.md` 自愈文件供丢上下文后 `cat` | 高 —— 直接针对 CLI 内部 `/compact`/auto-summarize 导致 agent 忘记启动指令的问题。slock 只在 spawn 时注入一次系统提示，开 session resume 后长会话同样会稀释 | 低-中：postStartWriter 写入用户消息时在尾部拼一段精简协议提醒即可，hive 已验证该模式 |
| **多 CLI 支持** | `command-preset-defaults.ts`：claude/codex/opencode/gemini 四套预设（各自 resume 参数 + session 捕获模式 + yolo 参数 + 输入 profile）；支持用户自定义 preset | 中 —— 不绑定单一供应商 | 中：slock 的 `command-presets.ts` 孤岛还在，`agent-runtime.ts` 仍硬编码 `CLAUDE_YOLO_ARGS`；需产品决策是否投入 |
| **Worker 末行输出可观测** | `worker-output-tracker.ts` + `team-list-enrichment.ts`：团队列表里每个 worker 展示 `last_pty_line`（最后一行实时输出），无 UI 观众也维护镜像 | 中 —— 一眼看出 agent 最新动态，比状态点信息量大得多 | 低：slock 的 screenText 取最后一行即可，接入 AgentStatusBar |
| **Session 绑定校验** | 捕获 sessionId 时用 `workspace_id + agent_id` marker 匹配 jsonl 内容，确保抓到的是本 agent 的 session（防止多 agent 同 cwd 抢 id）；resume 前做 session 文件存在性校验 | 低-中 —— slock 每 agent 独立 workspace 目录，encoded_cwd 天然隔离，风险已较低 | 低（可选） |
| **文件浏览/沙箱** | `fs-browse.ts`/`fs-sandbox.ts`/`fs-pick-folder.ts`：UI 侧浏览 workspace 文件 + 原生选目录对话框 + git 探测 | 低-中 | 低 |
| **Workspace shell 终端** | `workspace-shell-runtime.ts`：每个 workspace 可开一个普通 shell 终端 | 低 | 低-中 |
| **角色模板 + Agent 市场** | `role-templates.ts`（coder/reviewer/tester 预置角色）+ `marketplace-store.ts`（浏览/添加预置 agent） | 低-中 —— 降低创建 agent 的门槛 | 中 |
| **任务文件监听** | `tasks-file-watcher.ts`：orchestrator 维护 TASKS.md，watcher 同步到 UI | 低 —— slock 的任务走 DB + 看板页，已覆盖 | 不需要 |

### 2.3 Slock 有而 Hive 没有

- **Web 全功能客户端**：频道/DM/线程/看板/通知/设置/管理后台（hive 更偏终端工具）
- **DM 私信**（agent 与人类一对一）
- **通知系统**（@提及/任务指派/提醒 + Web 通知中心）
- **附件上传/下载**（带访问控制）
- **多组织（个人私有空间 + 共享 server）与邀请制**
- **提醒调度器**（FOR UPDATE SKIP LOCKED 多实例安全的 reminder 系统）

---

## 三、能否充分发挥 Claude Code 的能力？

### 3.1 核心链路：已能发挥 ✅

| Claude Code 能力 | Slock 利用情况 |
|------------------|----------------|
| 完整 TUI 交互 | node-pty 全双工，bracketed paste 大段输入 |
| 免权限值守 | `--dangerously-skip-permissions` + `--permission-mode=bypassPermissions`（无人值守必要） |
| MCP 工具扩展 | 项目级 `.mcp.json` 自动发现 + 信任对话框预豁免，11 个平台工具 |
| 会话连续性 | sessionId 捕获 → `--resume` 恢复（opt-in，失败自动降级重试） |
| 长期记忆 | 每 agent 持久 workspace + MEMORY.md 引导 |
| 系统提示注入 | 角色/频道上下文/经理身份/可派发对象 动态注入 bootstrap |
| 子代理限制 | `--disallowedTools=Task` 禁用（防嵌套 spawn，有意为之） |
| 回合生命周期 | 忙碌→空闲转变检测，可靠的单回合边界 |

### 3.2 发现的能力缺口（影响"完美发挥"）

#### G1 — Agent 的模型配置完全没有生效 🔴

Web 端/DB 里每个 agent 都有 `runtime_profile.model`（sonnet/opus/haiku 可选），但 daemon spawn 时 **`CLAUDE_YOLO_ARGS` 从不带 `--model`**，全库 grep 确认 daemon 没有任何地方读 `runtime_profile`。用户在管理后台选的模型是摆设。

**修复**：spawn 时从 agent 记录读 model，拼 `--model <name>` 进启动参数。

#### G2 — 没有用 CLAUDE.md 这个更自然的记忆通道 🟡

Claude Code 每会话自动读 cwd 的 `CLAUDE.md`，slock 却每轮把系统提示塞进 bootstrap 消息（几千字符的 paste）。缺点：
- 每轮重复传输 ~3.5KB 提示文本（日志里可见 `wrote bracketed paste (3358 chars)`）；
- bootstrap 是一次性注入，长会话中被新内容稀释；
- CLAUDE.md 是 Claude Code 的官方约定通道，优先级和持久性都更好。

**修复**：把静态部分（身份/规则/工具说明）写进 workspace 的 `CLAUDE.md`（spawn 时刷新），bootstrap 只带动态部分（本次消息、频道上下文、重启摘要）。

#### G3 — 人类无法实时观察 agent 终端 🟡

hive 的 `terminal-ws-server` + `terminal-state-mirror`（@xterm/headless + SerializeAddon，10000 行 scrollback，新观众发 restore 快照）允许在 UI 实时观看 agent 终端。debug "agent 为什么卡住/在干什么" 目前只能翻 daemon 日志的 STUCK 警告片段。slock 内部已有 screenText（但 scrollback: 0 只留当前帧，做观众快照需要加大），暴露成本低。

**修复**：终端镜像 scrollback 加大 → daemon 加 WS 转发（或 server 中继）→ 前端嵌 xterm.js 只读视图。

#### G4 — 防失忆机制缺失（hive reminder tail 模式）🟡

slock 只在 spawn 时注入一次系统提示（bootstrap paste）。开启 session resume 后，长会话中 Claude Code 的 `/compact`/auto-summarize 会压缩掉早期上下文——agent 可能忘记"必须用 send_message 工具回复、直接打字不会发出去"这个核心协议，表现为"思考了但没发出消息"。hive 验证过的解法：每条流向 agent 的消息**尾部**附加一段精简的 XML 提醒（身份 + 当前可用动作），利用 recency 位置对抗压缩；另配 PROTOCOL.md 自愈文件。

**修复**：postStartWriter 写入用户消息时在尾部拼一段 `<slock-reminder>`（一两行，含 send_message target 提示），成本极低，直接照搬 hive 验证过的模式。

#### G5 — 多 CLI 仍是硬编码 Claude 🟡（产品决策项）

`command-presets.ts` 孤岛文件还在，`agent-runtime.ts` 硬编码 `CLAUDE_YOLO_ARGS`。hive 已验证 codex/opencode/gemini 的 preset 模式可行（各自 resume 参数/yolo 参数/session 捕获模式）。文档记录为"需产品决策"，暂不属于缺陷。

#### G6 — MCP 工具覆盖面 🟡

11 个高频工具已 MCP 化，但以下仍走 CLI（bash 工具 + PTY 键盘模拟，正是历史上 bug 4/12 的高危链路）：
- 读历史/查新消息/搜索（`message read/check/search`）
- 附件（`send_message` 无 attachmentIds 参数，上传只能 CLI）
- 列出/取消提醒、加表情、看成员、profile

**修复**：优先补 `read_history`/`check_messages`（agent 每轮都可能用），附件上传需 multipart 支持。

#### G7 — daemon → server 状态上报缺失 🟡

`03-state-machine.md §9` 设计过：daemon 把 agent 状态转换上报 server，Web 端 `AgentStatusBar` 目前只能靠 daemon ready/断开 和 agent:status 零散消息推算，经常与实际不符（比如 STUCK 时 UI 无感知）。低成本改进版：照搬 hive 的 `last_pty_line`——AgentStatusBar 每个 agent 展示最后一行终端输出（screenText 已有，取最后一行即可）。

#### G8 — 已知遗留（早前文档记录，仍有效）

- `daemon-core.ts:22` 硬编码 `agentId = "00000000-...-0001"`（S-04，阻塞多 daemon 实例）；
- WS 消息无 zod 校验（`05-security-model.md §8`）；
- 跨平台（Linux/macOS）暂缓（用户已决策）；
- relay 模式（`generateRelaySystemPrompt`）存在但自主模式是默认，未暴露选择。

---

## 四、建议优先级

### 立即做（小改动，直接补能力）

| # | 事项 | 工作量 |
|---|------|--------|
| 1 | **G1：spawn 传 `--model`**，让 agent 模型配置生效 | 30 分钟 |
| 2 | **G2：静态系统提示改走 CLAUDE.md**，bootstrap 只带动态内容 | 半天 |
| 3 | **G4：消息尾部 `<slock-reminder>` 防失忆**（照搬 hive reminder tail 模式） | 1-2 小时 |
| 4 | **G6 先行项：MCP 补 `read_history`/`check_messages`** | 2 小时 |

### 近期做（体验提升明显）

| # | 事项 | 工作量 |
|---|------|--------|
| 5 | **G3：agent 终端实时观察**（终端镜像加 scrollback + daemon WS 转发 + 前端 xterm.js） | 1-2 天 |
| 6 | **G7 轻量版：AgentStatusBar 展示 last_pty_line**（照搬 hive 模式） | 2 小时 |
| 7 | **G6 剩余：MCP 附件上传/提醒管理/搜索** | 半天 |

### 决策后做

- G5 多 CLI（codex/gemini/opencode preset 接线）
- 多 daemon 实例（先解 S-04 硬编码 agentId）
- relay 模式开关暴露
- Agent 市场 / 角色模板（降低创建门槛）

---

## 六、「立即做」实施记录（2026-07-17）

### 已完成（G1/G2/G4/G6 先行项，全部 4 项）

| # | 修复 | 文件 |
|---|------|------|
| G1 | **`--model` 接线**：注册时捕获 `runtime_profile.model`（loadExistingAgents 走 `/api/agents?mine=1` 的 model 字段；agent:start 走 config.runtime_profile），`SpawnPtyForAgentDeps` 新增 `getAgentModel`，spawn 参数拼 `--model <name>`（含字符白名单校验防注入）。管理后台的模型选择从此生效 | `agent-runtime.ts`、`daemon-core.ts`、`agent-runtime-spawn.ts` |
| G4 | **防失忆 reminder tail**：`dispatchToAgent` 收口处给每条流向 agent 的消息尾部追加 `<slock-reminder>`（身份 + "回复只能用 send_message 工具，直接打字不会发出" + 读 MEMORY.md），照搬 hive reminder tail 模式对抗 /compact 压缩，覆盖首次 spawn 和 PTY 复用两条写入路径 | `agent-runtime-dispatch.ts` |
| G2 | **系统提示改走 CLAUDE.md**：静态系统提示写入工作区 `CLAUDE.md`（Claude Code 每会话自动从 cwd 加载，含 --resume 场景），bootstrap paste 从 ~3.5KB 缩到「身份 + 动态内容 + 去读 CLAUDE.md 的指针」，更抗压缩且省传输 | `agent-runtime-spawn.ts` |
| G6 先行 | **MCP 补 3 个工具**：`read_history`（读历史）、`check_messages`（增量查收，对接 /receive 游标）、`search_messages`（关键词搜索），agent 每轮高频读取操作不再走 PTY 键盘模拟的 CLI 链路；系统提示同步更新优先级说明 | `mcp/slock-mcp-server.ts`、`system-prompt.ts` |

### 验证

- `pnpm exec tsc --noEmit`（daemon）✅ 通过
- **daemon 测试：11 个测试文件、81 个用例全部通过**（含 mcp-server 子进程实测：14 个工具注册齐全）

### 待真机验证

- G1：`--model` 需要一次真实 spawn 确认 Claude Code 接受别名（sonnet/opus/haiku）。校验逻辑只允许 `[a-z0-9._-]`，非法值静默降级为不传。
- G2：CLAUDE.md 自动加载是 Claude Code 标准行为，但本环境的版本未实测；bootstrap 里保留了"请先读一遍 CLAUDE.md"的指针作为兜底。

### 顺带发现（未改动，待决策）

`dispatchToAgent` 的并发去重逻辑是「in-flight 时 await 后直接 return」——**并发到达的第二条消息会被静默丢弃**（日志打的却是 "chaining"）。真正串行排队（inFlight.then(doDispatch)）能顺带消除 bug 8/9 那类重叠写入竞态，但会改变"一轮思考答两条"的现有行为语义，需要专门评估后再改。

---

## 七、真机验证记录与二轮修复（2026-07-17）

### 验证结果（用户实测 @悬疑小说家）

| 验证点 | 结果 |
|--------|------|
| G1 `--model sonnet` | ✅ 首次 spawn 日志出现 `spawning with --model sonnet` |
| G2 CLAUDE.md | ✅ bootstrap 从 ~3.5KB 缩到 748 字符，回合正常完成 |
| G4 reminder tail | ✅ `<slock-reminder>` 出现在 agent 屏幕上，回复正常发出 |
| G6 MCP 工具 | ✅ agent 第一轮 `called slock`（MCP 通道）完成回复 |

### 实测暴露的 4 个问题与修复

1. **模型变更不生效（G1 实现 bug）**：管理后台 PATCH agent 后 server 推送的 `agent:start` 把 model 放在 `config.model`（非 `config.runtime_profile.model`），提取逻辑漏掉该位置；且重新注册时整体覆盖 agentInfo，把已捕获的模型抹掉。**修复**：三位置兜底提取（agent.model / config.model / config.runtime_profile.model）+ `registerAgent` 改为合并语义（`??` 保留旧值）。改 haiku 后重新 spawn 即可生效。
2. **`Invalid state transition: idle → idle` 噪音**：退出清理链对已是 idle 的 agent 做同态迁移触发警告。**修复**：状态机对 `from === to` 直接放行。
3. **`slock CLI 不在 bash PATH 中`**：Windows 上 Claude Code 的 Bash 走 git-bash，不解析 PATHEXT，敲 `slock` 找不到 `slock.bat`（agent 自己摸到全路径才调通，还记进了 MEMORY.md）。**修复**：`setup-slock-wrapper` 额外生成无扩展名的 POSIX 脚本 `.slock/slock`，bash 可直接命中。
4. **idle 回收 60s 太激进**：实测 78s 被回收，第二个问题吃完整冷启动。**修复**：默认放宽到 300s，`SLOCK_IDLE_RECLAIM_MS` 可调。

### 验证

- `pnpm exec tsc --noEmit` ✅ 通过
- daemon 测试：11 个文件、81 个用例全部通过

---

## 八、G3 终端实时观察实施记录（2026-07-17）

### 设计

不引入 xterm.js：复用 daemon 侧已有的终端模拟器（@xterm/headless），按 400ms 节拍把**渲染好的当前屏**（screenText）整帧推给浏览器，`<pre>` 整帧替换显示，效果等同真实终端画面且天然免疫 TUI 重绘/控制序列问题。按需开启（watch/unwatch + server 引用计数），无人观看时零开销。

```
浏览器 watch ─→ server（引用计数，首个观众）─→ daemon 开始 400ms 推帧
浏览器 ←─ server 定向转发（只发该 agent 的观众）←─ daemon terminal:frame
浏览器 unwatch/断线 ─→ server 减引用（归零）─→ daemon 停止推帧
```

### 已完成

| 层 | 改动 | 文件 |
|----|------|------|
| server | `terminalWatchers`（userId→agentName→socket 集合）引用计数；浏览器 `terminal:watch/unwatch` 消息处理 + 断线清理；daemon `terminal:frame` 定向转发（只发观众，不广播） | `server/src/ws/handler.ts` |
| daemon | `terminal:watch/unwatch` 处理：400ms 节拍读 `run.screenText`，帧内容无变化不推；agent 未运行推 `offline` 状态；stop 时清理全部定时器 | `daemon/src/daemon-core.ts` |
| web | `terminalStore`（帧按 agentName 存储）、`wsSender`（全局 WS 发送器）、AppLayout 消息路由 + sender 注入、`AgentTerminalModal`（深色终端面板 + 状态徽章 + 打开 watch/关闭 unwatch）、AgentManagement 在线 agent 行新增「终端」按钮、Modal 组件支持 widthClass | `web/src/stores/terminalStore.ts`、`wsSender.ts`、`components/layout/AppLayout.tsx`、`components/agent/AgentTerminalModal.tsx`、`pages/admin/AgentManagement.tsx`、`components/ui/Modal.tsx` |

### 验证

- `pnpm exec tsc --noEmit`（server + daemon + web）✅ 通过
- server 测试：12 文件 111 用例全过；daemon 测试：11 文件 81 用例全过；web build ✅

### 待真机验证

打开 Agent 管理 → 在线 agent 点「终端」，应看到与 daemon 日志一致的实时画面（0.4s 刷新）；关闭弹窗后 daemon 日志不再推帧。

### 后续可选增强

- 原始输出流 + xterm.js（彩色/光标级还原，需引入依赖）
- 终端镜像 scrollback（新观众能看到历史屏而非仅当前帧）
- 控制通道（hive 的 control channel：resize/stop/输入干预）

---

## 九、G3 v2：观察入口融入聊天流 + 内容可回看（2026-07-17）

> 实测反馈：① 观察不方便——要先在频道提问、再切到管理页点终端；② 内容没法保留——PTY 被回收后什么都看不到。

### 已完成

| 痛点 | 方案 | 文件 |
|------|------|------|
| 观察入口 | 终端查看改为**右侧常驻面板**（可边聊边看），三处入口：频道页 header 终端按钮（默认选正在工作的 agent）、侧边栏 Agent 状态栏点击、Agent 管理「终端」按钮；旧模态弹窗删除 | `web/src/components/agent/AgentTerminalPanel.tsx`、`AppLayout.tsx`、`ChannelView.tsx`、`AgentStatusBar.tsx`、`AgentManagement.tsx`、`uiStore.ts`（terminalAgent 状态） |
| 历史回看（运行中） | 终端镜像 scrollback 0→1000 行，新增 `getHistoryText()`；观众打开面板时 daemon 先补发最近历史屏（`terminal:history`），再进入实时帧 | `daemon/src/terminal-state.ts`、`agent-manager-support.ts`（historyText 快照字段）、`daemon-core.ts` |
| 历史回看（已回收） | run 退出时在退出清理链 removeRun 之前把终端文本落盘 `.slock/terminal-logs/<agent>.log`（分隔头 + 512KB 上限截断）；面板「历史日志」页随时拉取（server 中继 `terminal:history` 请求/响应） | `daemon/src/terminal-log.ts`、`agent-runtime-exit.ts`、`daemon-core.ts`、`server/src/ws/handler.ts` |

### 验证

- `pnpm exec tsc --noEmit`（daemon + server + web）✅ 通过
- daemon 测试：11 文件 81 用例全过（fake-agent-manager 同步补 historyText）
- web build ✅

### 面板使用方式

频道页 header 点终端图标（或侧边栏点任意 agent）→ 右侧打开面板：
- **实时画面**页：0.4s 刷新的当前屏，打开时先补发历史帧；
- **历史日志**页：落盘的历次 run 画面（含 agent 已被回收之后），可手动刷新。

---

## 十、实测发现的工作区命名碰撞等 3 个问题（2026-07-18）

> 用户在终端面板实测时发现：工作区路径显示为 `.slock/workspaces/_____`——
> 目录名清洗把非 ASCII 全替换成 `_`，**等长中文名 agent 共用同一工作区**。

### 已完成

| 问题 | 修复 | 文件 |
|------|------|------|
| 🔴 **工作区/日志/提示文件名碰撞**：`悬疑小说家`（5 汉字）→ `_____`，与任何 5 字中文名 agent 共享 MEMORY.md/CLAUDE.md/.mcp.json | 新增 `agent-dir-name.ts`：ASCII 名原样保留；有信息丢失时追加由全部码点决定的 6 位短哈希（`悬疑小说家` → `_____-121vh8`，`推理小说家` → `_____-1diy2r`，确定性不碰撞）；三处使用点统一接入（createWorkspaceDir / writeSystemPromptFile / terminal-log）；旧命名工作区的 MEMORY.md 自动复制迁移 | `agent-dir-name.ts`、`agent-startup.ts`、`terminal-log.ts` |
| 🟡 idle 回收显示为 "error" | exit=129（SIGTERM，idle 回收正常终止）在恢复摘要里显示为 `reclaimed(回收)`，不再让 agent 误以为历史上一串失败 | `restart-summary.ts` |
| 🟡 摘要计数误导 | 「处理 4 条消息」（近 5 次 run 累计）读起来像本次会话 2 秒处理 4 条，拆成「本次已处理 N 条；近 5 次累计 M 条」 | `restart-summary.ts` |

### 验证

- `pnpm exec tsc --noEmit` ✅；daemon 测试 11 文件 81 用例全过
- 哈希唯一性实测：`悬疑小说家`/`推理小说家`/`716测试机`/`secbot` 四个名字产出四个不同目录名

---

## 十一、autostart 误触发与静默回合 STUCK 修复（2026-07-18）

> 用户实测：重启 daemon 后还没提问，agent 就自动启动工作了；且 `@悬疑小说家` STUCK 90s（busyObserved=false）。

### 原因链

1. **autostart 按设计触发**：上次 daemon 停止时 2 个 run 处于 starting/running（日志 `Marked 2 unfinished run(s) as stale`），方案 A 把它们当崩溃恢复拉起。
2. **为什么有 stale 记录**：supervisor 的 `child.kill()` 在 Windows 上是 TerminateProcess，Node 的 SIGTERM handler 根本收不到；且 `daemon.stop()`/`stopAll()` 本来就不把 run 记录标为 exited。本次会话里代码改动触发的几次 watch 热重启，每次都留下 stale 记录 → 每次重启都 autostart。
3. **次级 bug**：autostart 注入的是「安静等待」消息，agent 安静读完文件就停，**从不出现 `esc to interrupt` 忙碌帧** → `busyObserved` 永远 false → round-end 按 busy→idle 不变量永不触发 → STUCK 到被 idle 回收 → 又留 stale → 循环。

### 已完成

| 修复 | 文件 |
|------|------|
| **静默兜底回合结束**：working + pending + 20s 无输出（`SLOCK_QUIESCE_MS` 可调）+ 当前屏有提示符 → 判回合结束。Claude 真思考时屏幕持续有 spinner 输出，不会静默 20s，不误判；专门兜住安静完成/无忙碌帧的回合。新增 `lastOutputAtByAgent` 跟踪（spawn 输出订阅更新，stuck 扫描器消费） | `agent-runtime.ts`、`agent-runtime-spawn.ts` |
| **计划内重启不 autostart**：`.slock/planned-restart` 标记文件——supervisor watch 重启前写入、daemon 优雅 stop 也写入；daemon 启动看到标记 → 跳过 autostart 并删除标记。真实崩溃（无标记）仍按方案 A 自动恢复 | `supervisor.ts`、`daemon-core.ts` |

### 验证

- `pnpm exec tsc --noEmit` ✅；daemon 测试 11 文件 81 用例全过（autostart 测试不受影响）

---

## 十二、G6 剩余 MCP 工具 + G7 last_pty_line 状态栏（2026-07-19）

### G6 剩余（MCP 附件 + 提醒管理）

| 工具 | 说明 |
|------|------|
| `send_message` 加 `attachmentIds` 参数 | 随消息附带附件（对接已有 /send 的 attachmentIds） |
| `upload_attachment` | 本地文件 → multipart 上传（新增 `callSlockUpload`，JSON-only 的 callSlock 不支持 multipart；fetch FormData 自动带 boundary） |
| `list_reminders` | 列出提醒（scheduled/all 过滤） |
| `cancel_reminder` | 取消提醒（DELETE） |

MCP 工具总数 14 → **17**。系统提示同步更新优先级（附件/提醒全部优先 MCP，CLI 只剩加表情/看服务器/看成员/资料等长尾操作）。测试更新为 17 工具断言。

### G7 last_pty_line 状态栏（照搬 hive 模式）

| 层 | 改动 |
|----|------|
| daemon | 新增 `startStatusReporter`：每 3s 轮询所有已注册 agent 的「状态 + 最后一行终端输出」，有变化才上报 `agent:status`（带 agentName + detail=lastLine）；`IAgentRuntime` 新增 `listAgentNames()` |
| server | WS daemon 分支 `agent:status` 从仅 console.log 改为 `sendToUser` 转发浏览器 |
| web | AppLayout 按 agentName 写入 agentStore；AgentStatusBar 每个 agent 行下方显示最后一行终端输出（截断 + title 悬浮全文），状态标签改为实时状态（工作中/启动中/空闲/离线） |

### 验证

- `pnpm exec tsc --noEmit`（daemon + server + web）✅
- server 测试 12 文件 111 用例全过；daemon 测试 11 文件 81 用例全过；web build ✅

### 效果

侧边栏 Agent 状态栏现在实时显示每个 agent 的最后一行终端输出（如 `✻ Crunched for 34s`、`❯ [Pasted text #1]`），无需打开终端面板就能感知 agent 在干什么；点行即打开终端面板看全屏。

---

## 十三、scrollback 视口 bug 修复（2026-07-19）

> 用户实测：终端面板只显示 slock 系统消息（启动画面），看不到 agent 的思考过程。

**根因**：G3 v2 把终端镜像 scrollback 从 0 改为 1000 后，`getScreenText()` 仍按 `getLine(0..rows)` 读取——此时缓冲区前段是历史行，读到的是**会话最开头的启动画面**并永远定格。终端面板、回合结束检测、postStartWriter 就绪判断共用这一个 screenText，全部受影响（welcome 屏 ≡ 空闲屏，busyObserved 永远 false）。

**修复**：`getScreenText()` 改为从 `buffer.baseY`（视口起点）读取。新增 `test/terminal-state.test.ts` 回归：输出超过一屏后 getScreenText 必须返回当前视口（含最新行、不含首行历史），getHistoryText 仍覆盖 scrollback。

**验证**：`tsc` ✅；daemon 测试 12 文件 83 用例全过（含 2 个新视口回归用例）。

**教训**：xterm buffer 语义变化（scrollback 0→N）会改变 getLine 索引含义——改终端缓冲区配置时，所有读取点都要重新审视。

---

## 十四、终端面板交互优化（2026-07-19）

> 用户反馈：面板宽度写死、字号不可调，长行看不全。

### 已完成（`web/src/components/agent/AgentTerminalPanel.tsx`）

- **可拖拽调宽**：面板左边缘拖拽把手，300–1000px 连续可调，宽度存 localStorage 记忆。
- **字号可调**：页签栏右侧 A-/A+（10–20px），同样记忆。
- 长行通过横向滚动查看（`whitespace-pre` + `overflow-auto`），加宽面板即可完整显示 80 列。

### 后续可选

- PTY 尺寸协商（hive control channel 的 resize）：面板把 cols/rows 同步给 daemon 调整 PTY 尺寸，让画面按比例重排，而不只是滚动。

（✅ 已于 2026-07-19 实现，见下节）

---

## 十五、PTY 尺寸协商（真改比例，2026-07-19）

### 链路

```
面板拖拽/字号变化 → 按可视区算 cols/rows（防抖 300ms）
  → terminal:resize → server 中继 → daemon
  → 记住偏好尺寸（下次 spawn 直接用）+ 对运行中的 PTY resizeRun
  → node-pty resize + 终端镜像 resize → Claude Code 收 SIGWINCH 重排画面
```

### 已完成

| 层 | 改动 | 文件 |
|----|------|------|
| web | 面板按 `fontSize×0.6`（字宽）和 `fontSize×1.5`（行高）从可视区算 cols/rows，防抖 300ms 发送；拖拽过程只发最终值 | `AgentTerminalPanel.tsx` |
| server | 浏览器 `terminal:resize` 消息转发给 daemon | `ws/handler.ts` |
| daemon | `terminal:resize` 处理：clamp 20-400×5-100，`setPreferredTermSize` 记忆 + `resizeRun` 实时调整；`IAgentRuntime` 新增偏好尺寸存储，spawn 时优先按偏好尺寸启动 | `daemon-core.ts`、`agent-runtime.ts`、`agent-runtime-spawn.ts` |

### 验证

- `tsc`（daemon + server + web）✅；daemon 测试 12 文件 83 用例全过；web build ✅
- 复用既有基建：`agent-manager.resizeRun`（node-pty resize + 终端镜像 resize 一体）原本就已实现，本次只接消息链路

---

## 五、结论

**slock 目前已经能稳定、可靠地发挥 Claude Code 的核心能力**——进程托管、无人值守、MCP 结构化工具、会话恢复、长期记忆、回合边界检测这条主链路经过 12 个实机 bug 的联调收敛，已经超出"能用"达到"可靠"。与 hive 对照，基础可靠性机制（token 生命周期/崩溃恢复/重启上下文）已全部对齐，MCP 工具通道比 hive 的 team CLI 更现代，平台层（Web 客户端/DM/通知/提醒/多组织）超出 hive。

真正的差距不在"能不能跑"，而在三处能力浪费：**模型配置不生效（G1）、系统提示没用 CLAUDE.md 官方通道（G2）、人类看不见 agent 的终端（G3）**。前两个是几十分钟到半天的改动，第三个是 1-2 天的功能。多 CLI 和多 daemon 属于产品决策项，不属于缺陷。

---

*本文基于 daemon 源码（6000 行）、既有联调文档、hive-main 对应模块逐一核对生成。*
