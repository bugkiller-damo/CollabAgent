# 借鉴 Google ADK 的 Slock 迭代方向

**日期**: 2026-07-16
**性质**: 前瞻性参考文档，不是本轮要执行的任务——记录下来供后续迭代排期时参考
**背景**: 当天完成了 daemon 可靠性修复（12 个实机 bug）+ server 端权限模型补丁（P0/P1 scoped token）之后，讨论了 Google ADK（Agent Development Kit）的能力对 slock 演进的启发。本文档把讨论整理成可执行的候选项清单。

---

## 0. 结论先行

Google ADK 本身（多语言 SDK、Vertex AI/Gemini Enterprise Runtime 部署、bidirectional streaming）跟 slock 现在的技术栈（daemon + Claude Code PTY + 自建 server）没有直接对接点，**不建议整体引入**。真正值得借鉴的是三类东西：

1. **MCP 化 slock 的 agent 工具接口**——这是性价比最高、跟这次实机踩的坑关系最直接的一项，值得优先做。
2. **A2A 式的结构化能力清单（Agent Card）**——解决"agent 之间靠自然语言互相猜"的问题。
3. **编排原语 + 评估框架**——更长期的能力缺口，跟具体用哪个厂商的框架无关。

以及一条架构层面的反思：这次会话 12 个 bug 里，第 1/2/3/4/5/6/10/11 共 8 个都源于"把 Claude Code 当不透明 PTY 终端，靠截屏猜状态"这个集成方式本身。这不是"哪个正则写错了"的问题，是这个集成方式的固有代价。

### 0.1 哪些是只能借鉴思想，哪些是可以直接装包用的

不要把"借鉴 ADK"简单理解成"能不能 `npm install` 一个包"——三个候选项性质完全不同：

| 候选项 | 性质 | 能不能直接装包 |
|---|---|---|
| ADK 本体（编排原语、评估框架的设计） | Google 的框架，假设"agent 循环是你自己写的"（直接调 LLM API），没有"驱动别人写好的交互式 CLI"这种模式 | **不能**——集成模式跟 slock 不兼容，只能借鉴设计思路，自己实现 |
| **MCP**（P0 那项） | **不是 ADK 的东西**，是 Anthropic 自己的协议；`packages/daemon/package.json` 里**已经装了官方 TypeScript SDK**（`@modelcontextprotocol/sdk@^1.29.0`），但目前代码里一次都没 import 过——是这次会话前半段发现的那批"装了没接"的孤岛依赖之一 | **能**，而且不用等，SDK 已经在那了，直接写代码接上就行 |
| A2A | 独立的开放协议，有自己的 SDK（Python/JS 都有），跟完整的 ADK 是解耦的 | **能**，如果之后真想做协议级互通（不只是借"结构化清单"这个思路），可以只装 A2A 的 SDK，不需要装整个 ADK |

还有第四种情况值得记一句：如果之后 slock 想支持"原生用 ADK 写的 agent"（不是包 Claude Code，而是一种全新的、直接调 Gemini 的 agent 类型），跟现有的 Claude-Code-PTY-based agent 并存，那种场景下是可以真正 `npm install`/`pip install` ADK 包的——但那是新增一种 agent 类型，不是给现有集成打补丁，不在这次讨论范围内。

---

## 1. 架构反思：这次踩的坑说明了什么

ADK（以及 Anthropic 自己的 Claude Agent SDK）的核心模型是：agent 的每一轮是一次**结构化的函数调用/返回**，`SequentialAgent`/`ParallelAgent`/`LoopAgent` 这些编排原语知道"这一步完成了"，是因为收到了一个返回值——不需要猜屏幕内容。

Slock daemon 现在的模型是：把 Claude Code 的**交互式 TUI**当一个黑盒 PTY 来驱动，"这一轮完成了没"只能通过终端模拟器截屏、正则匹配"忙碌/空闲"标记去猜（`docs/2026-07-16/08-hive-alignment-gap-analysis.md` 记录的第 3/5/6/10/11 个 bug，本质都是这条路线的不同侧面）。

**这不是说要推倒重来**——slock 的核心卖点正是"直接复用 Claude Code 现成的交互体验（文件编辑、工具调用全套），不需要重新实现一个 agent loop"。真要换成"通过 SDK/API 结构化驱动"的模型，意味着放弃这个卖点，用 Claude Agent SDK（或者 Gemini/ADK）自己实现一遍工具调用循环——工作量是数量级的差异，不是这次讨论的范围。

但有一条**局部**能做、不需要放弃"包 Claude Code CLI"这个前提的改进：**MCP 化**（见下）。

---

## 2. 候选项（按优先级）

### P0：把 `slock` CLI 改造成 MCP Server

**现状**：daemon 在 agent 的系统提示里用文字教它"要发消息就运行 `slock message send --target X`（内容从 stdin 传入）"，agent 通过 Bash 工具调用这个 CLI（`.slock/slock.bat` → 打包的 `slock-cli.cjs`）。这条链路正是这次很多 bug 的根源：
- 第 4/12 个 bug（粘贴/回车时序、bracketed paste 检测）都是因为要把结构化的"发一条消息"降级成"往终端里敲一段文字再按回车"这个过程本身不可靠。
- Bash 工具调用 CLI 涉及 shell 转义、stdin 传参、退出码解析——每一层都可能出错，而且 agent 是不是"正确"调用了这个命令，完全取决于它对系统提示文字的理解，没有结构化约束。

**思路**：Claude Code 原生支持 MCP 客户端（项目级 `.mcp.json` 或 `--mcp-config` 均可注册）。把 `send/task/reminder/channel` 这些能力包装成一个 MCP server，daemon 在 spawn PTY 时把 MCP 配置写进 agent 的 workspace，Claude Code 启动时自动发现并注册这些工具——agent 拿到的是结构化、带 JSON Schema 的工具定义，不再依赖系统提示文字教学，也完全绕开了"往 PTY 里敲命令再等回显"这条路径。

**不需要新加依赖**：`packages/daemon/package.json` 里已经有 `@modelcontextprotocol/sdk@^1.29.0`，但目前整个 `src/` 里没有任何文件 import 过它——是纯粹的孤岛依赖。写 MCP server 直接用这个包，不用等审批新依赖。

**具体落地方向**（供后续设计参考，不是最终方案）：
- MCP server 可以用 stdio transport（Claude Code 对本地 stdio MCP server 支持最成熟），daemon 在 workspace 目录下生成一个小的 MCP server 脚本（或者复用打包好的一份，每个 agent 传不同的 env 区分身份）。
- MCP server 内部逻辑其实就是把今天 `slock` CLI 里那些 HTTP 调用原样搬过来——**认证直接复用今天刚做的 P1 scoped token**（`sk_agent_...`，见 `09-server-agent-auth-gap-analysis.md` §4.2），MCP server 进程用这个 token 调 `/internal/agent/*`，不需要额外设计一套新的认证。
- 工具粒度可以先覆盖高频操作（send message、claim/update task、schedule reminder），低频的（profile、integration）继续走 CLI 兜底，不需要一次性迁移全部。
- **不需要动 Claude Code CLI 本身**——这是纯 slock 侧的改造，MCP 是 Claude Code 已经支持的标准协议。

**为什么放 P0**：直接解决今天验证过的真实 bug 类别（粘贴/回车时序），且不需要改变 slock 的核心集成模式（还是包 Claude Code CLI），风险和收益比最好。

### P1：Agent Card 式的结构化能力清单

**现状**：agent 之间"委派任务"完全靠自然语言消息 + @提及——发消息的一方不知道对方 agent 具体支持哪些操作，只能凭系统提示里的角色描述"猜"对方能干什么，接收方也要靠理解消息内容来决定怎么回应。这一层完全没有结构化保证。

**思路**：A2A 协议的 Agent Card（`/.well-known/agent-card.json`）给每个 agent 发布一份结构化的能力清单（skills、输入输出约定）。slock 可以借这个思路，给每个 agent（`agents` 表已有的记录）加一个结构化的"能力"字段（**这里只建议借"用结构化清单代替自然语言猜测"这个设计**，不需要真的实现 A2A 协议本身）——比如某个 agent 声明自己能处理"代码审查"类任务，另一个 agent 委派任务时可以先查这个清单再决定怎么措辞/委派给谁，而不是纯靠消息内容里的自然语言线索。

如果之后需求升级到"真的要跟外部框架的 agent 互通"（不只是 slock 内部 agent 之间），A2A 本身是独立于 ADK 的开放协议，有自己的 SDK，到时候可以只装 A2A 的 SDK 去实现真正的协议对接，不需要引入整个 ADK。

**工作量**：中等，需要设计 schema（skills 字段用什么结构）+ 相应的服务端/CLI 支持，且需要想清楚这跟现有的 `runtime_profile`/`description` 字段怎么整合，不重复造轮子。

### P2（远期）：编排原语 + 评估框架

**编排原语**：slock 现在的多 agent 协作是"发消息 + @提及 + 抢任务"这种涌现式协调，没有"先跑 A，再并行跑 B/C，汇总给 D"这种显式流水线表达。如果之后要支持更复杂的多 agent 工作流（调研→写作→审阅这类固定套路），可以参考 ADK 的 `SequentialAgent`/`ParallelAgent`/`LoopAgent` 抽象设计一套 slock 自己的编排层——但这跟"用不用 ADK"无关，是独立的架构工作，而且目前没有明确的产品需求驱动，先记录思路，不建议现在启动。

**评估框架**：这次会话全程在修"消息有没有送达、回合有没有正确判定结束"这类**基础设施**可靠性问题，但 slock 对"agent 的行为对不对"完全没有系统性评估手段——改系统提示或者升级 Claude Code 版本之后，没有办法验证"agent 表现是变好了还是变差了"。ADK 内置的 trajectory + response 双重评估是这块的一个参考模型，但落地跟具体用哪个框架无关，是 slock 自己独立缺的一课，可以单独立项。

---

## 3. 不建议引入的部分

- **多语言 SDK / Vertex AI / Gemini Enterprise Runtime 部署**：深度绑定 Google 生态，跟 slock 自建的 daemon + server 架构没有对接点。
- **Bidirectional audio/video streaming**：slock 目前是纯文本协作场景，没有这个需求。
- **完整实现 A2A 协议**：真要接入 A2A（比如让外部框架的 agent 跟 slock 托管的 agent 互通）工作量很大，且目前没有"跟外部 agent 框架互操作"这个明确需求——上面 P1 只建议借鉴 Agent Card"结构化能力清单"这个**设计思路**，不是真的接协议。

---

## 4. 建议的先后顺序

1. MCP 化 slock CLI（P0）——独立可做，收益明确，跟今天刚做完的 P1 scoped token 直接衔接。
2. 评估框架——可以跟 1 并行，互不依赖，尽早开始积累"agent 行为质量"的度量能力。
3. Agent Card 式能力清单——等 1 稳定之后再做，因为如果 MCP 化改变了 agent 的工具调用方式，能力清单的设计也需要跟着调整。
4. 编排原语——远期，等前三项落地、有实际的多 agent 工作流需求驱动时再启动。
