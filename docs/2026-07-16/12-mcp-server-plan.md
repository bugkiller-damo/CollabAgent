# 方案二：把 slock CLI 的 agent 工具接口 MCP 化

**日期**: 2026-07-16
**背景**: `docs/2026-07-16/10-adk-inspired-roadmap.md` 的 P0 项
**前置**: `packages/daemon/package.json` 已有 `@modelcontextprotocol/sdk@^1.29.0`，未被使用；服务端 P1 的 scoped token（`sk_agent_...`，见 `09-server-agent-auth-gap-analysis.md` §4.2）已经上线可直接复用认证

---

## 现状与问题

daemon 在 agent 的系统提示里用文字教它"要发消息就运行 `slock message send --target X`（内容从 stdin 传入）"，agent 通过 Bash 工具调用 `.slock/slock.bat` → 打包的 `slock-cli.cjs`。这条链路是这次会话第 4/12 个 bug 的根源——本质上是把一次结构化的"发消息"操作，降级成"往交互式终端里敲一段文字再等回显"，中间每一层（bracketed paste、粘贴确认、回车时序、Bash 工具的 shell 转义）都可能出问题，且 agent 是否"正确"调用完全取决于它对系统提示文字的理解，没有结构化约束。

Claude Code 原生支持 MCP 客户端。把这些能力包装成 MCP server 后，agent 拿到的是结构化、带 JSON Schema 的工具定义，调用是一次函数调用（MCP 协议本身走 stdio，不经过 PTY 的键盘输入模拟），完全绕开上面这一串问题。

---

## 设计

### 1. 新文件：`packages/daemon/src/mcp/slock-mcp-server.ts`

用 SDK 的 `McpServer` + `StdioServerTransport`（已确认这两个类在 `@modelcontextprotocol/sdk@1.29.0` 里存在，`registerTool(name, config, handler)` 是当前非废弃 API）：

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const AGENT_ID = process.env.SLOCK_AGENT_ID!;
const AGENT_TOKEN = process.env.SLOCK_AGENT_TOKEN!; // 复用 P1 的 sk_agent_... scoped token
const SERVER_URL = process.env.SLOCK_SERVER_URL!;

async function callSlock(path: string, init?: RequestInit) {
  const res = await fetch(`${SERVER_URL}/internal/agent/${AGENT_ID}${path}`, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${AGENT_TOKEN}`, "content-type": "application/json" },
  });
  if (!res.ok) throw new Error(`slock API ${path} failed: ${res.status}`);
  return res.json();
}

const server = new McpServer({ name: "slock", version: "0.1.0" });

server.registerTool("send_message", {
  title: "发送消息",
  description: "在指定频道/DM 里发一条消息",
  inputSchema: {
    target: z.string().describe('频道名（如 "#general"）或 DM 目标（如 "dm:@handle"）'),
    content: z.string(),
    threadId: z.string().optional(),
  },
}, async ({ target, content, threadId }) => {
  const result = await callSlock("/send", { method: "POST", body: JSON.stringify({ target, content, threadId }) });
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

// ... claim_tasks / update_task_status / schedule_reminder 同理

const transport = new StdioServerTransport();
await server.connect(transport);
```

### 2. 首批要覆盖的工具（对应今天已经读过的服务端路由）

| 工具名 | 对应端点 | 优先级 |
|---|---|---|
| `send_message` | `POST /internal/agent/:id/send` | 高频，必须首批做 |
| `list_tasks` | `GET .../tasks` | 高频 |
| `create_tasks` | `POST .../tasks` | 高频 |
| `claim_tasks` | `POST .../tasks/claim` | 高频 |
| `update_task_status` | `POST .../tasks/update-status` | 高频 |
| `unclaim_task` | `POST .../tasks/unclaim` | 中 |
| `schedule_reminder` | `POST .../reminders` | 中 |
| `list_reminders` / `cancel_reminder` | `GET`/`DELETE .../reminders` | 低，可以先留给 CLI 兜底 |

低频操作（profile、integration、upload）**不需要一次性迁移**——CLI 继续存在，MCP 和 CLI 可以长期并存，агент 两条路都能走。

### 3. daemon 侧接入点

`spawnPtyForAgent`（`agent-runtime.ts`）在 `mintAgentCredential(agentId)` 拿到 scoped token 之后，除了注入 env，还要在 workspace 目录写一份项目级 `.mcp.json`：

```json
{
  "mcpServers": {
    "slock": {
      "command": "node",
      "args": ["<打包后的 slock-mcp-server.cjs 路径>"],
      "env": {
        "SLOCK_AGENT_ID": "<agentId>",
        "SLOCK_AGENT_TOKEN": "<刚 mint 的 sk_agent_... token>",
        "SLOCK_SERVER_URL": "<options.serverUrl>"
      }
    }
  }
}
```

`slock-mcp-server.ts` 打包成单文件（跟现有 `setupSlockWrapper()` 打包 `slock-cli.cjs` 的方式一样，用 esbuild），每个 agent workspace 写一份指向同一个打包产物、不同 env 的 `.mcp.json`。

### 4. 认证：完全复用 P1，不需要新设计

MCP server 进程直接用 daemon 传进来的 `SLOCK_AGENT_TOKEN`（P1 mint 出来的 scoped token）去调 `/internal/agent/:agentId/*`——跟今天 `slock` CLI 用的是同一套认证，服务端不需要任何改动。

### 5. 系统提示怎么改

现在 bootstrap 里"请用 `slock message send --target ...`"这段指令性文字要去掉，改成"你有 `send_message`/`list_tasks` 等工具可用"这种更轻量的说明（甚至可以完全不提，因为 MCP 工具是结构化注册的，Claude Code 会自动在可用工具列表里看到，不需要教）。

---

## 风险 / 待确认

- **MCP server 进程的生命周期**：是每个 agent 一个独立的 MCP server 子进程（Claude Code 通过 stdio 拉起，随 Claude Code 进程退出而退出），还是 daemon 起一个常驻的、按 agentId 分流的 HTTP-based MCP server？stdio 方案更简单（Claude Code 原生支持好），且天然跟 Claude Code 进程生命周期绑定，不需要 daemon 额外管理——**建议先用 stdio**。
- **调试**：MCP 调用失败时怎么让 agent 看到清晰的错误信息——`callSlock` 里 catch 到的错误要包装成对 agent 友好的文本，不能直接把 HTTP 状态码扔回去。
- **首次接入建议只做 `send_message`**：验证"MCP 工具确实比 Bash+CLI 更可靠"这个假设后，再逐步扩展工具列表，不要一次性全迁移。

---

## 和其他方案的关系

- 依赖 P1 的 scoped token 机制（已完成）。
- 不依赖「方案四：`agent-runtime.ts` 拆分」，可以独立并行做。
- 做完之后，第 4/12 个 bug 那类"粘贴/回车时序"问题对 `send_message` 这类高频操作会彻底消失（`slock message send` 不再需要走 PTY 键盘输入模拟）；但 Claude Code 自身的其他 Bash 工具调用（比如它读写代码文件）不受影响，跟 MCP 化无关。

---

## 执行记录（2026-07-16 当天完成，紧接「方案四」之后）

### 实际范围 vs 原计划的表格

原表格把 8 个工具分成"高/中/低"三档，风险一节又建议"首次接入只做 send_message"。实际执行时在这两条建议之间做了折中：**实现了「高」+「中」共 7 个工具**（`send_message`/`list_tasks`/`create_tasks`/`claim_tasks`/`update_task_status`/`unclaim_task`/`schedule_reminder`），跳过「低」档的 `list_reminders`/`cancel_reminder`——这条界线直接对应文档自己的措辞"低频操作不需要一次性迁移——CLI 继续存在"，用文档自己定义的优先级分界当成实现范围的分界，而不是额外引入新的取舍标准。

### 新增文件

| 文件 | 作用 |
|------|------|
| `src/mcp/slock-mcp-server.ts` | MCP server 本体（独立子进程入口，`McpServer` + `StdioServerTransport` + 7 个 `registerTool`） |
| `src/mcp-bundle.ts` | `bundleSlockMcpServer()`——用 esbuild 把上面的文件打包成 `.slock/slock-mcp-server.cjs`，模块级 memoized promise，daemon 生命周期内只打包一次，所有 agent 共用同一份产物（跟 `setup-slock-wrapper.ts` 打包 CLI 的思路一致） |
| `test/mcp-server.test.ts` | 5 个测试，见下方"测试策略"一节 |

### 接入点：没有完全照抄设计文档的示例，多加了一层"信任对话框"防御

设计文档第 3 节只提到写 `.mcp.json`。实际接入在 `agent-runtime-spawn.ts` 里新增的 `writeMcpConfig()` 除了写 `.mcp.json`，**额外写了一份 `.claude/settings.local.json`，内容 `{"enableAllProjectMcpServers": true}`**——这是为了绕开 Claude Code 首次发现新 `.mcp.json` 时会弹出的"是否信任这个项目的 MCP server"确认对话框。这类一次性信任对话框和这次会话 bug 1 的 Accept-Permissions 对话框是同一类风险：如果 bootstrap 消息在对话框还开着的时候被写入，会被对话框当输入吃掉、永久丢失。

**【2026-07-16 真机验证通过】** 用户实测了一次真实的 `@716测试机` 消息分发，事后直接读取这次运行的真实 session transcript（`~/.claude/projects/<mangled>/5bb0b20b-....jsonl`，日志里 `captured session id 5bb0b20b...` 那一行对应的文件）核实，确认：
- transcript 里的工具调用名是 `mcp__slock__send_message`（Claude Code 对 MCP 工具调用的标准命名 `mcp__<server>__<tool>`），不是 Bash 调用 CLI——证明 `.mcp.json` 被成功发现并连接，agent 也确实按系统提示优先选用了 MCP 工具而不是退回 CLI。
- transcript 全文搜 "trust"/"approve"/"mcp server" 均无命中，时间线正常（收消息到第一次工具调用间隔约 9-10 秀，跟 `[PostStart] ... sending Enter now` 的正常延迟对得上，没有异常长停顿）。
- 日志本身也显示整个回合正常收尾（`round-end` 正确触发、状态机 `工作中 → 空闲`、消息确实发出去了）。

**结论：`enableAllProjectMcpServers: true` 这条防御按预期生效，本方案里唯一悬而未决的高风险项已解除。** 这不是靠日志推测，是直接核对了真实 session 文件里的工具调用记录得出的确定性结论——`agent-runtime-terms-dialog.ts` 目前不需要再加对应的信任对话框检测分支。

两个文件都写进 `workspace`（`createWorkspaceDir` 返回的每 agent 专属目录），不是设计文档草图暗示的"每个 agent 一份 `.mcp.json`、但内容一样"那种平铺方式——`.mcp.json` 里的 `env` 确实按 agent 各自不同（各自的 `SLOCK_AGENT_ID`/`SLOCK_AGENT_TOKEN`），但 `args` 指向的打包产物路径对所有 agent 是同一份。

`writeMcpConfig()` 在 `spawnPtyForAgent` 返回的异步函数里、`agentManager.startAgent()` 之前调用（必须在 Claude Code 进程真正起来之前落盘，否则它启动时扫不到）；打包本身则在 `createSpawnPtyForAgent` 工厂函数体（不是返回的闭包）里用 `void bundleSlockMcpServer()` 预热了一次——工厂函数在 daemon 启动、`createAgentRuntime` 构造时就会跑一次，早于任何用户消息到达，所以 esbuild 编译发生在等首条消息的空闲期，不会拖慢第一次真实 spawn（这点与原设计文档"跟现有 setupSlockWrapper() 打包方式一样"的建议一致，只是没有改 `daemon-core.ts` 的启动序列去做，而是让 `createSpawnPtyForAgent` 自己在构造时预热，效果等价但改动面更小）。打包失败或写文件失败都只 `console.warn` 后放行，不阻塞 spawn——MCP 是 CLI 之外一条更结构化的通道，不是硬依赖。

### 踩的一个坑：esbuild 打包 cjs 格式不支持顶层 await

`slock-mcp-server.ts` 最初直接在模块顶层写 `await server.connect(transport);`（跟设计文档的示例代码一模一样）。第一次实际跑 `bundleSlockMcpServer()` 验证时才发现：`esbuild.build({format: "cjs", target: "node18", ...})` 编译这个文件会直接报错 `Top-level await is currently not supported with the "cjs" output format`——这是这次会话又一次"设计文档的示例代码是示意，不是可以直接复制的产物"的教训（跟 doc 12 自己在"5. `McpServer.registerTool`"一节强调的一样，写代码前要对着 SDK 真实类型定义核实，示例代码同样需要真的跑一遍才能信）。修复很小：把 `await server.connect(transport)` 包进一个立即执行的 `void (async () => {...})();`，不改变行为，只是让顶层作用域本身不含 await。这个坑是在**写代码后立刻用 esbuild 实际编译一次**（不是等到写完所有测试才发现）时抓到的，没有靠猜测就定位到根因和修法。

### 系统提示 + 每回合指令文案的改法：两条腿都保留，不是二选一

设计文档第 5 节的建议是"这段指令性文字要去掉，改成……甚至可以完全不提"。实际执行时选择了更保守的做法——**两条路都在文案里显式并列**（"优先用 `send_message` 工具……没有该工具时退回 `slock message send --target ...`"），而不是完全去掉 CLI 提示：

- `system-prompt.ts` 的 `generateSystemPrompt()`：新增"优先用 MCP 工具"的说明段落，"可用命令"表格里逐条给出"工具优先，CLI 兜底"的写法（发消息/私信/任务板/提醒新建），其余暂未 MCP 化的操作（读历史/查新消息/搜索/加表情/看服务器/看频道成员/资料/上传附件/提醒列出与取消）保持原有纯 CLI 说明不变。
- `agent-runtime-dispatch.ts` 的 `runAgent`/`runAgentDm`/`runAgentReminder` 三处每回合注入的用户消息文案，同步加了"优先用 `send_message` 工具……没有该工具时退回 `slock message send`"的措辞。

这么做的理由：这次没有真实环境能验证"MCP 工具在 Claude Code 里确实稳定可用"（`.mcp.json`/信任对话框那条链路本身还未经真机验证，见上一节），如果按文档建议直接把 CLI 提示完全去掉，一旦 MCP 工具因为某个没预见到的原因没被 Claude Code 识别到（比如信任对话框卡住、bundle 没打包成功、`.mcp.json` 格式 Claude Code 不认……），agent 会连仅存的 CLI 退路提示都读不到，比"多一句冗余提示"的成本要高得多。等真机验证过 MCP 工具确实稳定可用后，再考虑把 CLI 提示精简掉。

### 测试策略：真的起子进程，不是只测 schema

MCP server 是一个独立子进程（Claude Code 通过 stdio 拉起，不跑在 daemon 主进程里），也不共享 daemon 测试里现成的 `fake-fetch.ts`（那个 mock 的是主进程的 `globalThis.fetch`，对子进程完全无效）。`test/mcp-server.test.ts` 用 `node:http` 起了一个真实的本地 HTTP server 模拟 `/internal/agent/:id/...`，然后把 `bundleSlockMcpServer()` 产出的真实打包文件当子进程 `spawn` 出来，用裸 JSON-RPC 消息（不借助 SDK 客户端库，手写 `initialize`/`notifications/initialized`/`tools/list`/`tools/call`）驱动一遍完整协议。5 个测试覆盖：
1. 打包产物真的能跑起来，`tools/list` 返回预期的 7 个工具名（验证 registerTool 的 zod schema 都能通过，不会在启动时炸）。
2. `send_message` 真的发出了 `POST /internal/agent/agent-under-test/send`，带上 `Authorization: Bearer sk_agent_test_token`，body 字段对得上。
3. `list_tasks` 用 GET + query string（验证 URLSearchParams 编码，包括 `#` 被转义成 `%23`）。
4. `create_tasks` 的 `titles: string[]` 正确映射成服务端要的 `{tasks: [{title}]}` 形状。
5. 服务端返回非 2xx 时，工具调用返回 `isError: true` + 服务端 `error` 字段的文字，而不是让子进程崩掉或者把裸 HTTP 状态码扔给 agent。

`packages/daemon` 测试从 6 个文件 62 个用例，变成 **7 个文件 67 个用例**，全部通过；`tsc --noEmit` 干净。

### 未做、留给后续的部分

- ~~信任对话框的真机验证~~ **已于 2026-07-16 完成真机验证，通过**（见上方"真机验证通过"一节）。
- `list_reminders`/`cancel_reminder`（低频档）没有做，继续走 CLI。
- `upload` 附件没有 MCP 化——`send_message` 工具里没有暴露 `attachmentIds` 参数（设计上先只覆盖纯文字消息），系统提示里附件流程依然是"CLI 上传 + CLI 或 MCP 发消息"的组合，如果后续要补全，需要先给 `send_message` 加 `attachmentIds` 参数、再单独加一个 `upload_attachment` 工具（`multipart/form-data` 请求，`callSlock` 目前的 JSON-only 实现需要单独分支处理）。
- 没有验证过"同一个 daemon 进程里，多个 agent 并发 spawn 时第一次触发 `bundleSlockMcpServer()` 的竞态"——理论上 memoized promise 应该能让并发调用都拿到同一个 in-flight promise，不会重复打包，但没有专门写并发测试去钉死这一点。
