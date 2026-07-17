# 方案四：`agent-runtime.ts` 拆分

**日期**: 2026-07-16
**前置条件**: 强烈建议先完成「方案一：测试补齐」——先有测试兜底，再拆分，不要反过来

---

## 现状

`agent-runtime.ts` 现在 1011 行，是整个 daemon 里最大的文件（第二大是 `cli.ts` 670 行）。今天一天的 12 个 bug 修复全部发生在这个文件里，它只增不减。Hive 对应的能力被拆成了十几个 20-150 行的单一职责文件（`agent-run-starter.ts`/`agent-run-exit-handler.ts`/`agent-runtime-active-run.ts` 等）。

## 拆分的真实难点：不是简单的剪切粘贴

Hive 的拆分之所以自然，是因为它的各个函数之间通过**显式传参**（context 对象、registry 实例）通信。Slock 现在的 `agent-runtime.ts` 是**一个巨大的闭包**——`createAgentRuntime` 内部十几个 `Map`（`runIdByAgent`/`agentStates`/`pendingMsgCount`/`busyObservedByAgent`/`runContext`/...）被下面所有函数通过闭包捕获访问，互相之间没有显式的依赖边界。直接把某个函数剪切到新文件会立刻报"找不到这些 Map"的错误。

**拆分前必须先做的事**：定义一个 `RuntimeContext` 类型，把当前所有共享状态的 Map/Registry 打包进去，`createAgentRuntime` 构造一份 `ctx: RuntimeContext`，后续拆出去的函数都改成显式接收 `ctx` 参数，而不是闭包捕获。这是这次拆分工作量的大头，不是"移动代码"那么简单。

## 目前的结构地图（供拆分时参照）

```
agent-runtime.ts 现有区块（行号是当前状态，拆分时会变）：
├─ 顶层工具函数（1-171 行）
│  ├─ 状态机：VALID_TRANSITIONS / assertTransition / STATE_LABEL
│  ├─ BUSY_MARKER_RE / PROMPT_RE（回合结束检测用的正则）
│  └─ resolveClaudeBinary / resolveCmdShimTarget（Windows .cmd shim 解析）
├─ createAgentRuntime 内部（172-1011 行）
│  ├─ 注册表 Maps（agentDrivers/agentSessions/agentNameToId/agentInfo）
│  ├─ PTY 基础设施 Maps（runIdByAgent/unsubByRunId/persistentSessions）
│  ├─ scoped token（mintAgentCredential/revokeAgentCredential）—— 今天 P1 新增
│  ├─ 四态模型（agentStates/transitionState/clearStartupTimer）
│  ├─ 回合消息计数（pendingMsgCount/incPending/decPending/hasPending）—— bug 8/9 修复产物
│  ├─ 忙碌观测标记（busyObservedByAgent/markBusyObserved/hasBeenBusy）—— bug 11 修复产物
│  ├─ 退出清理链（runContext/messagesProcessedByRun/exitHandler/idleReclaimer/exitCoordinator）
│  ├─ 内部方法（resolveAgentId/mentionedAgentNames/findMentionedAgent）
│  ├─ 卡住检测器（installStuckDetector）
│  ├─ PTY 辅助（buildPtyEnv/isClaudeAcceptDialog/installTermsAcceptHandler）
│  ├─ spawnPtyForAgent（约 145 行，全文件最大的单个函数）
│  ├─ 消息分发核心（doDispatch/dispatchToAgent/runAgent/runAgentDm/runAgentReminder）
│  └─ 公开接口（return { ... } 实现 IAgentRuntime）
```

## 建议的拆分方案

```
agent-runtime-context.ts       # 新增：RuntimeContext 类型定义 + 构造函数
                                #（所有 Map/Registry 的家，其他文件都依赖这个）

agent-runtime-state.ts         # 状态机：VALID_TRANSITIONS/assertTransition/
                                # transitionState/clearStartupTimer/STATE_LABEL

agent-runtime-credentials.ts   # mintAgentCredential/revokeAgentCredential（P1 新增部分，
                                # 独立性最强，最容易先拆出去练手）

agent-runtime-pending.ts       # pendingMsgCount + busyObservedByAgent 相关全部函数
                                # + BUSY_MARKER_RE/PROMPT_RE（bug 8/9/11 修复产物，
                                # 逻辑高度相关，应该在同一个文件里）

agent-runtime-exit.ts          # exitCoordinator 的构造 + runContext/messagesProcessedByRun
                                # + exitHandler 创建逻辑（对应 Hive 的 agent-run-exit-handler.ts）

agent-runtime-terms-dialog.ts  # isClaudeAcceptDialog + installTermsAcceptHandler
                                # （bug 1 修复产物，逻辑自成一体）

agent-runtime-spawn.ts         # spawnPtyForAgent（全文件最大的函数，独立成文件后
                                # 单独更容易补测试，也是方案一里 fake-agent-manager
                                # 测试的主要目标）

agent-runtime-dispatch.ts      # doDispatch/dispatchToAgent/runAgent/runAgentDm/
                                # runAgentReminder（消息分发的业务逻辑，对应 Hive
                                # team-operations.ts 的角色）

command-resolver-claude.ts     # resolveClaudeBinary/resolveCmdShimTarget
                                #（跟 command-resolver.ts 现有职责合并考虑，
                                # 避免产生两个"解析可执行文件路径"的文件）

agent-runtime.ts               # 瘦身后：只剩 createAgentRuntime 的组装逻辑——
                                # 构造 RuntimeContext，调用上面几个文件的工厂函数，
                                # 组装出 IAgentRuntime 的 registerAgent/unregisterAgent/
                                # stopAgent/stopAll/loadExistingAgents 等公开方法
```

## 拆分顺序建议（降低风险，每一步都可独立验证）

1. **先拆 `agent-runtime-credentials.ts`**——今天刚加的代码，依赖最少（只需要 `options.serverUrl`/`options.apiKey`），练手风险最低。
2. **拆 `agent-runtime-state.ts`**——纯函数居多（`assertTransition`不依赖任何 Map），第二容易。
3. **定义 `RuntimeContext`**，把 `agent-runtime-pending.ts`/`agent-runtime-exit.ts` 拆出去——这两个耦合最深（`decPending`/`clearBusyObserved` 都要在退出清理链里调用），需要一起设计接口。
4. **拆 `agent-runtime-terms-dialog.ts`**。
5. **拆 `agent-runtime-spawn.ts`**——依赖前面所有模块，放最后；这一步开始之前，「方案一」的 fake-agent-manager 回归测试必须已经就位，因为这是风险最高的一步（这次 12 个 bug 里至少 8 个的代码都在这个函数附近）。
6. **拆 `agent-runtime-dispatch.ts`**。
7. 每拆完一步跑一次全部测试 + `tsc --noEmit`，绿了再进行下一步，不要攒到最后一次性验证。

## 不建议做的事

- 不要在拆分的同一个 PR/提交里顺手"优化"逻辑——拆分本身风险已经不低（这次会话花了大半天才把这个文件里的状态管理理顺），拆分和重构逻辑要分开验证。
- 不要一次性拆完再测——按上面的顺序每步验证，任何一步测试变红就地修，不要往后拖。

## 和其他方案的关系

- **强依赖「方案一」**：没有回归测试兜底，不建议启动这个方案。
- 完成后能让「方案三：session resume」更容易找到 `spawnPtyForAgent` 里正确的插入点。
- 跟「方案二：MCP 化」相互独立，可以并行，但两个都改 `agent-runtime.ts` 的话建议先后做完一个再做另一个，避免长期分支冲突。

---

## 执行记录（2026-07-16 当天完成，紧接「方案一」之后）

### 实际拆分结果 vs 原计划

按建议顺序原样执行了 6 步，没有跳步、没有合并步骤。每一步都是"改代码 → 修掉因为闭包变量消失产生的悬空引用 → `tsc --noEmit` → 跑全部测试 → 绿了再进入下一步"。没有采用文中"不建议做的事"里提到的一次性拆完再测。

`agent-runtime.ts`：**1011 行 → 398 行**。新增 6 个模块（总计 1275 行，含拆分后各文件独立的注释头）：

| 文件 | 行数 | 对应步骤 |
|------|------|----------|
| `agent-runtime-credentials.ts` | 41 | Step 1 |
| `agent-runtime-state.ts` | 86 | Step 2 |
| `agent-runtime-turn-tracker.ts` | 45 | Step 3a |
| `agent-runtime-exit.ts` | 131 | Step 3b |
| `agent-runtime-terms-dialog.ts` | 87 | Step 4 |
| `agent-runtime-spawn.ts` | 232 | Step 5（风险最高，见下） |
| `agent-runtime-dispatch.ts` | 255 | Step 6 |

**没有单独建 `agent-runtime-context.ts`（原计划里的 `RuntimeContext` 类型）**——实际拆分时发现，每个模块只需要自己那部分状态（比如 `agent-runtime-exit.ts` 只要 `unsubByRunId`/`runIdByAgent`，不需要 `agentDrivers`/`agentSessions` 这些注册表 Map），所以采用了"每个工厂函数自带一个精确到该模块需求的 `XxxDeps` 接口"的做法，而不是一个大而全的共享 context 类型。这样每个模块的依赖边界反而更清楚——`agent-runtime-dispatch.ts` 的 `DispatchDeps` 一眼就能看出它依赖了哪些东西，不用去猜"这个 context 里哪些字段这个模块真的用得到"。`agent-runtime.ts` 里剩下的注册表 Map（`agentDrivers`/`agentSessions`/`agentNameToId`/`agentInfo`）+ `resolveAgentId`/`mentionedAgentNames`/`findMentionedAgent` + 公开接口 `return {...}` 组装逻辑，就是瘦身后剩下的"胶水层"。

### Step 3 拆成了 3a + 3b（原计划里是一步）

原方案把 `agent-runtime-pending.ts` 和 `agent-runtime-exit.ts` 归成一步（"这两个耦合最深，需要一起设计接口"）。实际执行时发现拆成两个独立提交更安全：先拆纯粹的 `turnTracker`（pendingMsgCount/busyObservedByAgent，不依赖任何其他新模块），验证通过后，再拆 `exitChain`（它需要引用 `turnTracker` 的实例做退出时清理，如果两个一起写，出错时不好判断是哪一半的问题）。这个顺序调整没有偏离"每步都能独立验证"的核心原则，只是把一步拆成了两步更小的步骤。

### Step 5（`spawnPtyForAgent`）：预想的最高风险步骤，实际验证下来没有意外

这是全文件最大的单个函数（约 150 行），也是这次会话 12 个 bug 里至少 8 个的发生地——原计划特别强调"这一步开始之前，方案一的 fake-agent-manager 回归测试必须已经就位"。实际执行时严格做到了纯剪切+改调用方式：函数体一个字符都没有改动逻辑，只是把闭包捕获的自由变量（`agentManager`/`stateMachine`/`turnTracker`/`exitChain`/`idleReclaimer`/`postStartWriter`/`runIdByAgent`/`unsubByRunId`/`resolvedClaudePath`/`runStore`）改成显式的 `SpawnPtyForAgentDeps` 参数对象，`hasPending(agentName)` 这类之前的裸函数调用改成 `turnTracker.hasPending(agentName)`。改完之后 `tsc --noEmit` 一次过，62 个测试（包括方案一里专门为这个函数的历史 bug 写的 6 个 `round-end.integration.test.ts` 回归用例）全部一次性通过，没有出现"看起来对但测试红了"的情况——这正是方案一"先补测试再拆分"这个前置条件真正发挥作用的地方：如果没有这层回归测试兜底，这种纯人力 diff review 很难对一个 232 行、涉及 9 个外部依赖的函数做到"确认逻辑零改动"的信心。

### 每一步实际遇到的机械性问题（不是设计问题，是"剪切代码后编译器会告诉你哪里漏了"的正常过程）

每一步拆分后，`tsc --noEmit` 都会先报几个 `Cannot find name 'xxx'`——因为原来是闭包捕获，剪切到新文件后这些变量自然不存在了。处理方式统一：把这些残留引用替换成"新工厂返回的对象.方法"（例如 Step 3 把 `exitCoordinator.onExit(...)` 换成 `exitChain.onExit(...)`，`runContext.set(...)` 换成 `exitChain.registerRunContext(...)`）。这是拆分工作量的大头，跟文档最初预判的一致："拆分前必须先做的事……这是这次拆分工作量的大头，不是'移动代码'那么简单"——只是最终没有用统一的 `RuntimeContext` 类型来解决，而是每个模块自己的 `XxxDeps` 接口，效果等价（消除闭包捕获，改成显式传参），但边界更细粒度。

### 顺手清理的死代码

Step 5/6 拆完之后，`agent-runtime.ts` 里有几处目的已经不存在的中间产物顺手清掉了（不是"顺便重构逻辑"，是拆分之后这些声明确实不再被用到）：
- `mintAgentCredential`（`credentialsClient` 解构出来的裸函数）——`agent-runtime-dispatch.ts` 直接拿完整的 `credentialsClient` 对象自己解构。
- `incPending`/`decPending`/`markBusyObserved`/`clearBusyObserved`——这几个在 `agent-runtime.ts` 里不再被直接调用（都下沉到 `agent-runtime-spawn.ts`/`agent-runtime-dispatch.ts` 里通过 `turnTracker.xxx()` 调用），只保留 `hasPending`/`hasBeenBusy` 给 `installStuckDetector`（诊断用，留在原文件里没有拆出去）用。
- `claudePrint`/`writeSystemPromptFile`/`createWorkspaceDir` 的顶层 import——全部下沉进 `agent-runtime-dispatch.ts`。

### 验证结果

每一步都跑了 `tsc --noEmit -p tsconfig.json`（全部干净）+ 全量 vitest（`packages/daemon` 6 个测试文件 62 个用例，全部通过），没有一步是红的就往后拖的情况。6 步走完后的最终状态：62/62 通过，`tsc` 干净。

### 未做、留给后续的部分

- `resolveClaudeBinary`/`resolveCmdShimTarget`/`PTY_COMMAND`（Windows `.cmd` shim 解析）还留在 `agent-runtime.ts` 顶层，没有按原计划挪到 `command-resolver-claude.ts` 或合并进现有 `command-resolver.ts`——这次没做是因为它们不属于 6 步拆分清单里的任何一步（原计划里这部分只是提了一句"考虑合并"，没有列入拆分顺序），且这几个函数本身不依赖 `createAgentRuntime` 内部任何状态，风险最低，随时可以单独作为一个小任务处理，不影响当前拆分已经达成的目标。
- 没有为新拆出来的模块单独补充"纯单元测试"（比如单独测 `agent-runtime-terms-dialog.ts` 的 `isClaudeAcceptDialog`）——现有的 `round-end.integration.test.ts` 这类集成测试是通过 fake-agent-manager 间接覆盖到这些模块的行为，覆盖率没有下降，但如果后续要在某个模块内部做更细粒度的改动，针对性的单元测试会更好定位问题。
