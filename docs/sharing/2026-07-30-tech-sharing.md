# 技术分享小会材料 — Slock：AI Agent 原生协作平台

> 2026-07-30 · 2 位技术同事 · 目的：讲清架构 + 拉人共建
> 用法：按提纲讲 20 分钟 + 现场演示 10 分钟，最后抛"可贡献清单"

---

## 0. 一句话开场（30 秒）

"Slock 是一个让人类和 AI Agent 在同一个频道体系里协作的平台——每个 Agent 的本体是你本机 daemon 拉起的一个 Claude Code 进程，平台负责消息路由、身份凭证、生命周期和可观测性。你可以把它理解成：给 Claude Code 装上 Slack 的壳、任务的骨架、和可观察的眼睛。"

## 1. 架构一张图（3 分钟）

```
┌──────────┐   REST / WS    ┌──────────┐   WS(/ws)    ┌──────────┐   PTY    ┌─────────────┐
│ Web 浏览器│ ◄────────────► │  Server  │ ◄──────────► │  Daemon  │ ◄──────► │ Claude Code │ × N agents
│ (React)  │                │ (Fastify)│              │ (node-pty)│         │  子进程      │
└──────────┘                └────┬─────┘              └────┬─────┘          └──────┬──────┘
                                 │ PostgreSQL               │ .slock/ 本地态         │ MCP stdio
                            业务数据/凭证                run 记录/工作区/日志      slock-mcp-server
```

三个讲点：
- **Server 无状态**，业务全在 PostgreSQL；任务不是独立表——"任务即带 task_number 的消息行"
- **Daemon 跑在 Agent 所有者的机器上**（agent 的算力和凭证不出本机），一个账号一条连接托管 N 个 agent
- **Agent 回调走 MCP 工具**（17 个结构化工具），不走"教 AI 敲命令行"

## 2. 五个有嚼头的技术亮点（10 分钟）

### ① 门控投递：怎么 reliably 给终端程序"打字"
- bracketed paste 包裹 + 等 `[Pasted text #N` ack + 100ms settle 再发回车（修过"回车被吞"）

- 回合结束三条件缺一不可：pending + **曾观察到忙碌** + 当前空闲有提示符；看的是 xterm 渲染帧不是原始字节流

- 忙碌时消息不丢：promise 链串行排队 + 前端 toast"已缓冲"

  这套机制有四层，从检测到兜底：

    1. 回合检测（判断"电话挂没挂"）：daemon 盯着 agent 终端渲染后的画面——看到 esc to interrupt（Claude 的忙碌指示）说明正在输出；看到 ❯ 提示符且忙碌消失，才判定"这一回合干完了"。
    2. 串行排队（纸条放托盘）：agent 忙的时候新消息不丢，挂到它专属的 promise 链尾部排队，一闲下来按顺序递；同时前端弹 toast"⏳ 已缓冲，空闲后自动投递"——这就是昨天修的
    P0-1，之前是直接丢弃。
    3. 写入确认（递纸条的手法）：真正写入时用终端的 bracketed paste 协议把整段文字包起来（防止文字里的换行被当成回车提前提交），等终端回显 [Pasted text #1 确认"贴上了"，停
    100ms，再单独发回车。不修这个的话，长消息的最后一个回车经常被吞掉，agent 永远收不到提交。
    4. 超时兜底（防闸门卡死）：提示符 8 秒没检测到就强行写入；20 秒完全无输出但有提示符，直接判回合结束——兜住那些"安静读完消息不回复"的回合。

### ② 终端观察：给每个 Agent 装监控摄像头
- `@xterm/headless` 无头终端镜像 → 400ms 推帧（去重）→ 浏览器实时画面
- resize 协商全链路：前端拖面板 → WS → PTY `resize` → Claude Code 收 SIGWINCH 重排
- 退出落盘可回看（>512KB 截尾 256KB）

### ③ 生命周期：五态状态机 + 成本控制
- uninit/idle/starting/working/stopped；崩溃回 idle 而非 stopped（stopped 是显式注销语义）
- idle 回收 30 分钟、session resume 默认开（`--resume` 续会话，失败有宽限期自动降级）
- **token 是一等公民**：昨天刚做完一轮 8 项 token 优化（下面血泪史讲）
  - 崩溃退出回 idle，绝不回 stopped。因为 stopped 是"离职"语义，dispatch 会拦截跳过；如果崩溃也归到 stopped，那这个 agent 就再也叫不醒了。回 idle
    意味着"人还在，只是电脑关了"，下一条消息来时重新 spawn 就行。
    - idle → working 是合法直达。进程还活着的时候收到新消息，不用走"开机流程"（starting），直接往现有终端里写——这叫 PTY 复用，是省掉冷启动的关键路径。

### ④ 凭证隔离：两级 token
- 账号级 machine token（daemon 用）vs agent 级 scoped token（24h TTL，进子进程 env）
- 重签即撤旧 + mint 端点拒绝 scoped token 自调用（防泄露后自我续期）
- daemon 的账号 token **永不进子进程**

### ⑤ 派发体系：经理/worker + 看板单一事实源
- 频道可设一名 agent 经理；经理 `dispatch_task` → worker 干活 → `report_task` 回报
- 派发通知消息**本身就是看板卡片**（补 task_number 即成任务）：派发→in_progress、回报→in_review、撤回→closed
- 人类也能把任意消息一键"转任务"（同一个接口语义：给原消息行补号，不是复制）

## 3. 血泪史：四个值得记住的坑（5 分钟，技术同事最爱这段）

1. **Windows `shell:true` + `child.kill()` 只杀 cmd 包装层**——node 孙子进程成孤儿，新旧两个 daemon 并存：日志全双份、每个 agent 被重复 spawn（**双倍 token**）、新实例签 token 把旧实例的全吊销（MCP 集体 401）。修复：`taskkill /T /F` 整树杀 + PID 单实例锁
2. **`BASE_URL` 是 Vitest 保留变量**——worker 会把它覆盖成 vite 的 `base`（"/"），测试静默打错服务器还被限流 429。排查半天，换 `SLOCK_TEST_BASE_URL` 解决
3. **Fastify：无 body 的 DELETE 带 `Content-Type: application/json` → 400**——AI agent 取消提醒反复失败白烧 token。客户端只在有 body 时带 content-type
4. **Claude CLI 的 Windows shim**：`where claude` 拿到的是 `.cmd` 包装，要正则提取真实 `.exe` 才能 ConPTY 直连

## 4. 现场演示（10 分钟，按序走）

> 前置检查：dev 服 :3001 已重启（吃 P1 看板同步代码）、daemon 在线

1. 频道里人 + 3 个 agent 共存，@经理 agent 提需求
2. 终端观察面板：实时看 agent 思考/工具调用（**高光时刻，多停留**）
3. 把一条消息"📋 转任务"→ 看板出现卡片
4. 经理派发给 worker → 看板卡片自动 in_progress → worker 回报 → in_review
5. 展示 worker 的终端画面和最终小说产出

## 5. 可贡献清单（拉人共建的钩子，按上手难度排）

| 难度 | 事项 | 涉及 |
|------|------|------|
| ⭐ | 消息列表 AI 头像、线程页前缀样式 | `MessageRow.tsx`/`ThreadView.tsx` |
| ⭐ | daemon 测试基建（测试文件在但没装 vitest） | `packages/daemon` |
| ⭐⭐ | effort 键名真机验证（settings.json `effort` 是否生效） | 真机跑一次即可 |
| ⭐⭐ | 多 runtime driver：codex/gemini（预设已有，spawn 路径待抽象） | `command-presets.ts`、`agent-runtime.ts` |
| ⭐⭐⭐ | run store JSON → SQLite | `agent-run-store.ts`（接口已抽象） |
| ⭐⭐⭐ | "沉默 vs 成功"区分：MCP send_message 打点 + 回合核对 | 设计文档 §10.5 |

## 6. 代码导览地图（给他们带走）

- 入口：`packages/daemon/src/daemon-core.ts`（WS 路由）→ `agent-runtime.ts`（工厂组装 20+ 模块）
- 设计文档三件套：`docs/2026-07-19/01-智能体协作体系详细设计.md`（含**设计不变量 9 条**，改代码前必读）、`02-数据架构设计.md`、`03-接口设计.md`
- 演示路径核实：`docs/competition/demo-feasibility.md`（含全部近期变更记录）
- 本地跑测试：`SLOCK_TEST_BASE_URL=http://localhost:3011 NODE_ENV=test vitest run`（server 包，113 个测试）
