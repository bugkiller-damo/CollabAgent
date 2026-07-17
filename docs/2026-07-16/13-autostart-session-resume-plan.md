# 方案三：补齐 autostart + session resume

**日期**: 2026-07-16
**背景**: 对应 Hive 已验证过的两个可靠性设计，slock 这边模块都写好了（`agent-sessions.ts`/`command-presets.ts`），但从没接入调用链

---

## 3.1 Session Resume

### 现状

`agent-sessions.ts` 提供 `captureSessionId(cliName, workspaceDir)`（扫描 `.claude/projects/` 目录找最新修改的 session 文件）和 `command-presets.ts` 的 `renderResumeArgs(preset, sessionId)`（把 `{session_id}` 占位符替换进 `--resume {session_id}` 模板）——两个都写好了，但 `agent-runtime.ts` 里从没调用过。现在每次 PTY 重新 spawn（daemon 重启后、或者 idle-reclaim 之后），Claude Code 都是全新 session，之前的对话上下文只能靠 `restart-summary.ts` 的文字摘要带过去（已经接了，Task 2.10），不是真正的会话恢复。

`types/index.ts` 的 `AgentRuntimeState` 已经预留了字段：`lastSessionId: string | null; lastSessionUpdatedAt: number | null`——说明这条路径本来就是规划过的，只是没接完。

### 设计

**捕获时机**：`spawnPtyForAgent` 里 bootstrap 消息写入之后（`termsAcceptDone` resolve、`postStartWriter` 调用之后），延迟几秒（给 Claude Code 时间在磁盘上创建 session 文件）调用一次 `captureSessionId("claude", workspace)`，拿到的 sessionId 存进 `runStore`（`agent-run-store.ts` 已有 `saveRuntimeState`/`loadRuntimeState`，直接复用，不需要新表）。

```ts
// spawnPtyForAgent 内，postStartWriter 调用之后
setTimeout(() => {
  const sessionId = captureSessionId("claude", workspace);
  if (sessionId && runStore) {
    runStore.saveRuntimeState({
      agentId, agentName, status: "working",
      lastTransitionAt: Date.now(), totalRuns: /* 累加 */,
      currentRunId: snapshot.runId,
      lastSessionId: sessionId, lastSessionUpdatedAt: Date.now(),
    });
  }
}, 5000); // 给 Claude Code 落盘的时间；具体延迟需要实测调整
```

**恢复时机**：`spawnPtyForAgent` 组装 `CLAUDE_YOLO_ARGS` 的地方，如果 `runStore?.loadRuntimeState()` 里有这个 agent 的 `lastSessionId`，追加 `renderResumeArgs(getCommandPreset("claude"), lastSessionId)` 的参数（即 `--resume <sessionId>`）。

**降级处理**：Claude Code 的 `--resume` 遇到不存在/损坏的 session id 会怎么表现（报错退出？还是忽略降级成新 session？）需要先实测确认——如果是报错退出，daemon 这边要能识别这种启动失败并自动降级成不带 `--resume` 重新尝试一次，不能让"resume 失败"变成"agent 再也起不来"。这是这个方案里**风险最高、最需要先用小范围实测验证**的一环。

**跟 restart-summary 的关系**：如果 resume 成功（Claude Code 真的恢复了上次的对话上下文），`restart-summary.ts` 那段"最近运行摘要"文字可能就不需要再注入了（agent 自己就记得），需要重新设计触发条件——大概是"resume 成功就不注入摘要，resume 失败/没有 session 才注入摘要"，两者互斥，不是同时生效。

---

## 3.2 Autostart

### 现状

`daemon-core.ts` 的 `start()` 只调用 `runtime.loadExistingAgents()`——这只是从服务端拉取 agent 列表、在内存里注册（`agentDrivers`/`agentNameToId`），不会主动 spawn 任何 PTY。PTY 完全是懒加载的：第一条消息到达时才 spawn。Hive 的 `autostartConfiguredAgents()` 会在启动时主动把所有有 launch config 的 agent 重新拉起。

### 这个方案的真实价值——需要先想清楚，不是无脑抄 Hive

Hive 的场景里有"orchestrator"这种默认应该常驻、主动协调 worker 的角色，autostart 对它有明确价值。Slock 现在的 agent 模型更偏"消息驱动"（被 @提及/DM 才触发），autostart 的价值主要是两点：
1. 减少 daemon 重启后第一条消息的冷启动延迟（agent 不用现场花 15s 启动超时窗口去 spawn）。
2. 崩溃恢复更完整——跟 `markUnfinishedRunsStale()` 配套，daemon 重启后不只是把历史记录标记干净，还真的把之前活跃的 agent 重新拉起来。

**代价**：每个自动拉起的 agent 都是一个真实的 Claude Code 进程，占用本地资源和该用户自己的 Claude 用量——如果对**所有**注册过的 agent 都做 autostart（照搬 Hive 的"所有有 launch config 的都拉起"），对一个注册了十几个很少用的 agent 的用户来说，daemon 一启动就会同时起十几个 Claude Code 进程，这个代价可能超过收益。

### 建议的落地方式（需要产品侧确认，不要直接抄 Hive 的"全部拉起"）

不建议无条件 autostart 所有 agent。推荐两个方向二选一：

**方案 A（推荐，改动小）**：只 autostart "daemon 重启前正在运行"的 agent——`runStore` 里 `markUnfinishedRunsStale()` 之前，先读一遍哪些 run 处于 `starting`/`running` 状态（也就是崩溃前正在活跃的），只对这些 agent 调用一次 `spawnPtyForAgent`（不带触发消息，只做 bootstrap），其余"注册了但没在跑"的 agent 保持懒加载。这样 autostart 的语义变成"崩溃恢复"，不是"预热所有配置过的 agent"，代价可控。

**方案 B（更接近 Hive，改动大）**：给 `agents` 表加一个 `autostart: boolean` 字段（默认 `false`），只有用户显式勾选过的 agent 才会在 daemon 启动时被拉起。需要服务端配合加字段+管理界面，工作量比方案 A 大。

**这次先做方案 A**，方案 B 留给有明确产品需求（比如"我这个 agent 需要 24 小时常驻监听"）时再做。

---

## 实施顺序建议

1. Session resume 先做（价值更明确：daemon 重启/idle-reclaim 之后的对话连续性，用户能直接感知到）——但先在小范围手动验证"--resume 传一个不存在的 session id 会怎样"，确认降级路径没问题再接入主流程。
2. Autostart 方案 A（跟崩溃恢复绑定，价值和成本都可控）。

## 和其他方案的关系

- 建议在「方案四：`agent-runtime.ts` 拆分」之后做——`spawnPtyForAgent` 现在已经是全文件里最大的一个函数（约 145 行），再往里加 session resume 的逻辑会让它更难维护；拆分之后能更清楚地找到插入点。
- 不依赖「方案二：MCP 化」。

---

## 执行记录（2026-07-16 当天完成，方案四/方案二之后）

### 开工前先发现了两个会让整个方案落空的既有 bug（不是这次新写的代码里的）

在按计划开始接线之前，先读了一遍 `agent-sessions.ts`/`agent-run-store.ts` 已有的实现，发现两个之前写好但**从没跑过真实数据**的模块，各自藏着一个会让 session resume 从一开始就是空转的 bug：

1. **`agent-sessions.ts` 的 claude 会话文件路径写反了**：原实现扫 `{workspaceDir}/.claude/projects/`，但 Claude Code 实际是把会话记录写在**用户主目录**下的 `~/.claude/projects/<mangled-abs-path>/`，不是项目目录本身。这不是猜的——直接去看了这台机器上真实的 `~/.claude/projects/` 目录列表，确认了目录名的生成规则（绝对路径里每一个非字母数字字符原样替换成一个 `-`，字符对字符，不合并连续特殊字符，比如 `D:\code\slock` → `D--code-slock`），并且现场核对了一个这次会话里真实跑过的 agent workspace（`716___`）对应的 mangled 目录名和里面的 `.jsonl` 文件，逐字节匹配。如果不修，`captureSessionId` 会一直静默返回 `null`，整个方案的地基就是假的。已修：`agent-sessions.ts` 新增 `mangleClaudeProjectPath()`，`claude`/`codex` 两个 pattern 都改用 `homedir()`（原来 `codex` 用 `process.env.HOME`，Windows 上通常是空的，也顺手用 `homedir()` 修了，虽然 codex 目前没接入任何调用链）。
2. **`agent-run-store.ts` 的 `loadRuntimeState()` 完全忽略 `agentId` 参数**——原签名是 `loadRuntimeState(): AgentRuntimeState | null`，直接返回 `states[states.length - 1]`（数组最后一条）。单 agent 场景下"恰好"是对的，但多 agent 的 daemon 里，查 agent A 的运行时状态会返回"最近一次保存的随便哪个 agent"的数据——用于 session resume 就是"A 可能被塞进 B 的 sessionId 去 `--resume`"，用于 autostart 崩溃恢复摘要也会张冠李戴。已修：签名改成 `loadRuntimeState(agentId: string)`，按 `agentId` 精确查找（`saveRuntimeState` 本来就保证每个 agentId 最多一条，只是读的那一半没对齐）。`types/index.ts` 的 `IAgentRunStore` 接口同步改了签名；确认过这次之前没有任何调用方在用这个方法（本来就没接线），不存在需要跟着改调用点的问题。

这两个都是"写测试之前先读一遍要用到的现有代码，而不是照抄设计文档假设它们已经工作正常"这条习惯捞出来的——如果直接按设计文档的伪代码接线，这个方案会在生产环境里安静地什么都不做，而 `tsc`/大部分手写测试都不会告诉你这件事（返回 `null`/返回错误但格式对得上的对象，都不会报错，只会在真机测试时"看起来 resume 了，其实每次都是新 session"这种不容易一眼看出来的方式失败）。

### Session resume 的落地：capture 一直开，consume 默认关

跟设计文档一致的核心判断：capture（把 sessionId 存下来）低风险，一直开着；"喂给 `--resume`"这半边风险最高（文档原话："这个方案里风险最高、最需要先用小范围实测验证的一环"——`--resume` 遇到坏 session id 时 Claude Code 到底是报错退出还是静默降级，这次环境没有真实 Claude Code + 真实服务器能验证）。所以做成显式 opt-in：`SLOCK_SESSION_RESUME=1` 才会真的往 spawn 参数里加 `--resume`；默认（未设置）行为跟这个方案完全不存在时一模一样，62（不含新增测试）→ 80 个测试里专门有一个用例钉死"即使 runStore 里存着 sessionId，默认也绝不会注入 `--resume`"。

即使打开了，也内置了设计文档要求的兜底：`agent-runtime-spawn.ts` 新增一个"宽限期"机制——带 `--resume` spawn 之后，如果 PTY 在很短时间内（默认 3s）就退出，判定为 resume 失败，清空存的 sessionId 并**立即无 `--resume` 重新 spawn 一次**（复用同一条触发消息，不会让这条消息平白丢失）。用 `fake-agent-manager.ts` 的 `simulateExit()` 精确控制这个时序，写了一个测试完整钉死"resume 失败 → 清空 sessionId → 自动重试一次不带 `--resume`"这条路径，是这次三个子任务里唯一没有真实 Claude Code 环境可验证、只能靠 fake PTY 精确控制时序来间接验证的部分。

`restart-summary` 互斥关系也按设计文档做了：resume 真的成功（宽限期内没退出）时跳过 `formatRestartSummary` 注入，不与 session resume 重复。

### 一个设计文档没提到、但接线时发现必须处理的问题：env 开关的读取时机

设计文档没讨论"`SLOCK_SESSION_RESUME=1` 这个开关什么时候生效"这个细节。最初实现里写成模块顶层的 `const SESSION_RESUME_ENABLED = process.env.SLOCK_SESSION_RESUME === "1"`——这在生产环境完全没问题（daemon 进程启动时读一次环境变量，本来就是正常预期），但会让测试没法用 `beforeEach` 简单地开关这个 flag（因为 ES module 的 `import` 在解析时就已经跑完模块顶层代码，早于任何测试代码设置 `process.env`，若要测试这个开关必须用 `vi.resetModules()` 重新加载整个依赖图，麻烦且脆弱）。改成一个函数 `isSessionResumeEnabled()`，每次调用时现读 `process.env`——这不是"为了测试而妥协设计"，是严格更好的写法（同样零成本，且理论上以后如果要支持不重启进程改配置也用得上），只是恰好也顺便让测试变简单了。`RESUME_QUICK_FAIL_WINDOW_MS`/`SESSION_CAPTURE_DELAY_MS` 两个定时器常量也改成了同样的模式（`SLOCK_RESUME_GRACE_MS`/`SLOCK_SESSION_CAPTURE_DELAY_MS` 可覆盖，生产默认还是 3000/5000），原因见下一节。

### Autostart（方案 A）：按设计实现，`daemon-core.ts` 的调用顺序是唯一容易踩的坑

新增 `IAgentRunStore.listActiveAgents()`——扫 `runs` 表里 `status` 为 `starting`/`running` 的记录，按 `agentId` 去重返回。接口注释和 `daemon-core.ts` 里都明确标注了"必须在 `markUnfinishedRunsStale()` 之前调用"——后者会把这些记录的 `status` 改写成 `error`，顺序反了会永远查到空列表。`daemon-core.ts` 的构造函数里现在严格按这个顺序：先 `listActiveAgents()` 存进 `this.autostartCandidates`，再 `markUnfinishedRunsStale()`。`start()` 里等 `loadExistingAgents()`（从服务端拉最新 agent 列表）跑完之后，顺序（不是并发）挨个调用新增的 `IAgentRuntime.autostartAgent(agentName)`——顺序而不是 `Promise.all` 并发，是为了避免崩溃前同时有好几个 agent 在跑时，daemon 一启动就并发拉起一堆 Claude Code 进程抢资源（设计文档明确提醒过这个代价）。多数情况下（正常优雅关闭，或者从没崩溃过）这个列表是空的，autostart 完全零成本。

`autostartAgent()` 内部**没有重新实现一遍 spawn 逻辑**，直接复用现成的 `dispatchToAgent()`——省掉了单独处理 token 换取/PTY 启动/状态机迁移的必要性，触发内容换成一条明确说明"这是系统重启、不是真实用户消息，没有真正待办就不用主动发言"的系统消息。有一个**没有解决、只是接受了的粗糙点**：`AgentRunRecord` 本身不记录频道，所以只能用 `"general"` 兜底传给 `dispatchToAgent`，而 `writeSystemPromptFile` 生成的系统提示里"本次任务"那段话默认框架是"你被 @ 了，请回复"——跟 autostart 消息里"不需要主动发言"的指令在同一次 bootstrap 里同时出现，语气上有点矛盾。这次没有再往 `agent-startup.ts`/`system-prompt.ts` 里加一个"autostart 模式"的专门分支去彻底解决这个矛盾（那样改动面更大，而且没有真机验证过 Claude 面对这种矛盾指令实际会怎么表现），先接受"给出足够明确的指令，大概率能压过默认框架"这个现实，留作已知的粗糙点。

### 意外发现并解决的测试套件并发 flake（跟方案三本身无关，但被这次新加的测试触发了）

加完 `session-resume.test.ts`（用真实定时器等 3s 宽限期窗口）之后，全量测试套件出现一个新的偶发失败：`mcp-server.test.ts`（方案二做的，真的 spawn 打包出来的 MCP server 子进程）里固定是第三个 spawn 的子进程在 `initialize` 握手上超时。排查过程：
- 单独跑 `mcp-server.test.ts`：稳定通过（<2s）。
- 只跑它和新加的 `session-resume.test.ts` 两个文件：稳定通过。
- 跑全部 8 个文件：稳定复现超时，即使把两层超时（单测 timeout + JSON-RPC 调用自己的 5s 超时）都拉到 12-15s 依然超时。
- 把新测试里的宽限期/捕获延迟常量调小到 80ms（通过上面新增的 env 覆盖）：**没有解决**，依然超时。
- 用 `vitest run --no-file-parallelism` 跑全量测试：**稳定通过**（70/70，之后加测试变成 80/80）。

这几步确认了根因是这台机器上 vitest 默认的文件级并行调度在"多个文件同时用真实定时器 + 真实子进程"时会互相抢占 OS 级资源（具体是 Windows 上子进程 stdio 管道的调度延迟），不是任何一段业务逻辑的 bug——单独验证过新增的 session-resume 逻辑本身完全正确（3/3 通过），mcp-server.test.ts 测的功能本身也没有问题（单独跑或降低并发都稳定）。新增 `packages/daemon/vitest.config.ts`，设置 `test.fileParallelism: false`（牺牲一部分总耗时换取稳定性，这个项目从方案一开始就是这个取舍标准）。有个小插曲：一开始按常规写法 `import { defineConfig } from "vitest/config"`，但 `vitest` 在这个 workspace 里从来没被 `packages/daemon` 自己声明为依赖（只是 pnpm store 里恰好存在、一直靠直接路径 `node .../vitest.mjs` 调用的），改成纯对象 `export default {...}` 绕开这个 import 问题。`mcp-server.test.ts` 里额外加的超时余量（12s/15s）虽然验证下来不是治本的办法，但保留下来作为无害的额外保险，没有撤销。

### 新增测试文件

| 文件 | 覆盖内容 |
|---|---|
| `test/agent-sessions.test.ts` | `mangleClaudeProjectPath` 的字符替换规则（对照本机真实目录名）；`captureSessionId`/`listSessions` 真的能在 `~/.claude/projects/<mangled>/` 下找到最新会话文件（真实文件系统，不 mock，用完自动清理测试专用的子目录） |
| `test/agent-run-store.test.ts` | `loadRuntimeState(agentId)` 按 agentId 精确查找、不会跨 agent 串数据；`listActiveAgents()` 只认 starting/running、去重、且必须在 `markUnfinishedRunsStale()` 之前调用才有意义 |
| `test/session-resume.test.ts` | 默认关闭时零行为变化；打开后宽限期内存活会正确注入 `--resume` 且跳过 restart-summary；宽限期内退出会清空 sessionId 并自动重试一次不带 `--resume`（用 fake-agent-manager 的 `simulateExit` 精确控制时序） |
| `test/autostart.test.ts` | `autostartAgent()` 对仍注册的 agent 走完整 dispatch 流程拉起 PTY；对已经不在注册表里的 agent 是安静的 no-op，不报错 |

`test/fakes/fake-agent-manager.ts` 顺手扩展了两个字段供以上测试断言用：`FakeRun.args`（记录每次 `startAgent` 传入的参数，用来断言 `--resume` 有没有被正确注入/移除）、`FakeAgentManager.lastCreatedRunId`（因为假的 `startAgent` 实现内部没有真正的 `await`，测试可以在调用方的 promise 还没 resolve 时就轮询这个字段拿到 runId，抢在宽限期计时器跑完之前调用 `simulateExit` 模拟"resume 参数导致 PTY 很快退出"）。

### 验证结果

`packages/daemon` 测试从方案二结束时的 7 个文件 67 个用例，变成 **11 个文件 80 个用例**，全部通过；`tsc --noEmit` 干净；全量套件连续跑了 3 次确认不再 flaky（之前加了 `vitest.config.ts` 之前会偶发那个 mcp-server 超时）。

### 未做、留给后续的部分

- ~~Session resume 的"喂给 `--resume`"这半边没有真机验证过~~ **2026-07-16/17 真机验证发现并修复了一个真实 bug**（见下方"真机验证记录"一节）——验证本身进行了，且暴露的问题已经修复，但**用户没有拿到过 Claude Code 遇到坏 `--resume` 时打印的原始文字**（因为那次验证是用假 sessionId + 真实 daemon 跑的，PTY 输出的原始字节没有随日志一起贴出来），所以"Claude Code 到底怎么描述这个失败"这个具体细节仍然不知道，只是从退出码（`exit=1`）和时序反推出来的。如果之后想彻底弄清楚，需要在 `SLOCK_VERBOSE_PTY=1` 打开的情况下，直接观察终端里滚动过去的原始文字。
- Autostart 的系统提示"被 @ 了/不用主动发言"矛盾措辞问题（见上面"意外发现"一节）——如果真机测试发现 agent 经常在 autostart 之后误发不必要的消息，需要回来给 `system-prompt.ts` 加一个专门的 autostart 分支。
- 没有做设计文档里提到的方案 B（`agents` 表加 `autostart: boolean` 字段，需要服务端配合）——按文档建议留给有明确产品需求时再做。
- `vitest.config.ts` 的 `fileParallelism: false` 是这台开发机上验证出的解法；没有在其他机器/CI 环境验证过这个设置是否还有必要、或者是否有更精细的调度方式（比如限制 worker 数而不是完全关掉并行）能兼顾稳定性和速度。

---

## 真机验证记录（2026-07-16/17，用户实测）

### 验证方式

按 `15-remaining-gaps-summary.md` 里给的步骤：停 daemon → 把 `daemon-state.json` 里 `716测试机` 的 `lastSessionId` 手工改成一个格式对但不存在的假 UUID → 设置 `SLOCK_SESSION_RESUME=1` + `SLOCK_VERBOSE_PTY=1` 重启 daemon → 发一条 `@716测试机` 的消息。

### 发现的真实 bug：消息静默丢失（不是"resume 该不该重试"的问题，是一个更基础的时序漏洞）

日志显示的时间线：

```
[Runtime] @716测试机 启动中 → 工作中
[Daemon] @716测试机 message dispatched (pty, bootstrap+first msg)   ← 宽限期（3s）已经跑完，没检测到失败
[ExitHandler] run=2fc49aa9 agent=05c588af exit=1                    ← PTY 在宽限期*之后*才真正退出
[Runtime] @716测试机 PTY exited (code=1); cleaned up runId=2fc49aa9
[Runtime] @716测试机 bootstrap+first message queued (2954 chars)    ← 往一个已经死掉的 PTY "写"消息
[Runtime] @716测试机 captured session id 5bb0b20b... for future --resume  ← 只是重新找到旧的真实 session，无害
```

根因：`--resume` 带着假 sessionId 确实失败了（`exit=1`），但失败得比 `RESUME_QUICK_FAIL_WINDOW_MS`（3 秒）宽限期检测更慢——真正的退出发生在宽限期检测已经放行、`doDispatch` 已经打出"message dispatched"日志**之后**。等 bootstrap 真正要写入时（还要再等 `termsAcceptDone`，至少 1.5 秒），PTY 早就是空壳，写入的内容直接消失，没有任何重试、也没有任何可见的失败提示——这条用户消息就这样被无声吞掉了。

这不是"resume 重试逻辑写错了"，是一个更基础的漏洞：**从 `attemptSpawn` 返回到 bootstrap 真正写入之间，有一段没人守着的窗口**——只要 PTY 在这段窗口里死掉（不管是不是因为 resume），bootstrap 消息就会被写进空气里。resume 失败只是这次实测把它暴露出来的触发方式，理论上任何原因导致的"启动后很快挂掉但没快到被 3 秒宽限期抓住"的场景都会踩到同一个坑。

### 修复

在 `agent-runtime-spawn.ts` 的 bootstrap IIFE 里，`await termsAcceptDone` 之后、真正调用 `postStartWriter` 之前，加了一道存活检测：如果这次 run 已经死了（`agentManager.getRun(...)` 查不到，或者 status 是 `exited`/`error`），且这是一次没重试过的 resume 尝试，就清空存的 sessionId 并递归调用 `attemptSpawn` 整个重新 spawn 一次（不带 `--resume`，复用同一条触发消息）——不是简单丢弃，是通过完整重新走一遍 spawn 流程真正把这条消息投递出去。如果死亡跟 resume 无关（没开 resume，或者已经重试过一次），就打印一条清晰的错误日志说明消息没送到，而不是像修复前那样完全沉默。

新增回归测试 `test/session-resume.test.ts` 里的第四个用例，用 fake PTY 精确复现了这个时序（先让 80ms 宽限期正常过去，再在 termsAcceptDone 的 1.5s 窗口内才 `simulateExit`），验证补投递确实把原始消息（"hello"）送到了第二次 spawn 的 PTY 里。`packages/daemon` 测试从 11 个文件 80 个用例变成 **11 个文件 81 个用例**，全部通过；`tsc --noEmit` 干净。

### 仍然成立的结论

- **MCP 信任对话框防御**（另一个 🔴 项）在这次实测里间接得到了佐证：日志里能看到 bootstrap 正常写入、Claude 正常工作过（第一次用真实 sessionId 成功那次），没有信任对话框卡住的迹象，跟 `12-mcp-server-plan.md` 里的验证结论一致。
- Session resume 这条路径现在**已经过一轮真机验证并修复了实测发现的问题**，但由于没拿到 Claude Code 失败时的原始输出文字，"Claude Code 具体怎么描述 resume 失败"这个细节仍然是黑盒——不影响当前修复的正确性（修复处理的是"PTY 死没死"这个可观察的事实，不依赖于知道它为什么死/怎么描述自己的死），但如果之后想做更精细的错误分类（比如区分"session 不存在"和"其它启动失败"），需要专门再看一次原始输出。
