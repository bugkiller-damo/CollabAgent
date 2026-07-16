# ⑥ 实现优先级地图

> 生成日期：2026-07-15
> 目的：将重构按阶段拆分为可独立交付的增量，每个阶段有明确目标、产出和验收标准
> 原则：先修痛处，再建架构，最后优化

---

## 1. 阶段总览

```
Phase 1 ──── Phase 2 ──── Phase 3 ──── Phase 4 ──── Phase 5
痛点修复     安全+架构    可靠+持久     并发正确     优化补充
2-3 天       5-7 天       3-5 天        2-3 天       3-5 天
             │
             └── 核心改动，建议独立分支
```

| 阶段 | 主题 | 新增文件 | 修改文件 | 预计工时 |
|------|------|----------|----------|----------|
| Phase 1 | 痛点修复 | 1 | 2 | 2-3 天 |
| Phase 2 | 安全+架构 | 4 | 4 | 5-7 天 |
| Phase 3 | 可靠+持久 | 3 | 1 | 3-5 天 |
| Phase 4 | 并发正确 | 0 | 2 | 2-3 天 |
| Phase 5 | 锦上添花 | 2 | 1 | 3-5 天 |
| **合计** | | **10** | | **15-23 天** |

---

## 2. Phase 1: 痛点修复（预计 2-3 天）

**目标**：不改架构，解决最小单元最突出的问题。

### 任务清单

```
□ 1.1 缩短 turn timeout
  文件: drivers/persistent-claude.ts
  改动: timeout 180s → 60s（可配置 SLOCK_TURN_TIMEOUT_MS）
  风险: 无，纯配置改动

□ 1.2 增加启动延迟
  文件: drivers/persistent-claude.ts
  改动: spawn 后等待 1s 再写 stdin（可配置 SLOCK_STARTUP_DELAY_MS）
  风险: 低，已有 fixed-delay 模式

□ 1.3 增加错误日志
  文件: core.ts (handleMessage, dispatchToAgent)
  改动: catch block 不吞错误，console.error + 调用栈
  风险: 无

□ 1.4 修复 loadExistingAgents 未 await
  文件: core.ts start()
  改动: start() 改为 async，await loadExistingAgents()
  风险: 低，改变启动微时序

□ 1.5 删除死代码 logStatus()
  文件: core.ts line 333-335
  改动: 删除方法
  风险: 无

□ 1.6 优化 await import
  文件: core.ts (agentWorkspace, writeAgentPrompt)
  改动: 顶楼 import fs/path，去掉动态 import
  风险: 低
```

### 验收标准

```
□ daemon 启动正常
□ @mention 后 agent 在 10s 内回复（之前 3-5 分钟）
□ 进程崩溃时日志完整显示错误栈
□ loadExistingAgents 在 WS 连接前完成
□ 删除 logStatus 后编译无报错
```

---

## 3. Phase 2: 核心安全与架构（预计 5-7 天）

### 子任务及依赖

```
□ 2.1 types/index.ts — 共享类型定义（无依赖）
  新增: AgentStatus, LiveAgentRun, AgentInfo, AgentRunRecord

□ 2.2 agent-tokens.ts — Token 生命周期（依赖 2.1）
  新增: issue/peek/validate/revokeIfMatches
  参考: Hive agent-tokens.ts（~50 行）

□ 2.3 live-run-registry.ts — 活跃运行表（依赖 2.1）
  新增: add/get/remove/list + createExitEntry/setPendingExitCode
  参考: Hive live-run-registry.ts

□ 2.4 agent-startup.ts — 启动指令生成（依赖 2.1）
  从 core.ts 抽出: writeAgentPrompt, agentWorkspace
  新增: buildStartupInstructions, buildProtocolDoc, buildReminderTail
  参考: Hive agent-startup-instructions.ts

□ 2.5 agent-manager.ts — 进程管理（依赖 2.1, node-pty）
  新增: node-pty 封装（startAgent/stopRun/writeInput/resizeRun）
  参考: Hive agent-manager.ts
  ⚠️ 风险: node-pty 原生依赖，Windows 兼容

□ 2.6 agent-runtime.ts — 核心运行时（依赖 2.1-2.5）
  从 core.ts 抽出: dispatchToAgent, runAgent 系列
  集成: agent-tokens + agent-manager + live-run-registry + agent-startup
  参考: Hive agent-runtime.ts

□ 2.7 精简 daemon-core.ts（依赖 2.6）
  保留: WS 消息路由 + 顶层协调
  剥离: agent 管理逻辑 → agent-runtime

□ 2.8 四态模型集成（依赖 2.1, 2.6, 2.7）
  uninit/idle/starting/working/stopped
```

### 执行顺序

```
2.1 types
  ├── 2.2 tokens
  ├── 2.3 registry
  ├── 2.4 startup
  └── 2.5 manager (node-pty)
          │
        2.6 agent-runtime
          │
        2.7 daemon-core 精简
          │
        2.8 四态模型
```

### 验收标准

```
□ 所有 agent 管理测试通过
□ token 在 spawn 前签发，exit 后吊销
□ revokeIfMatches 匹配检查正常
□ core.ts 从 447 行缩减至 ~150 行
□ node-pty 在 macOS/Linux/Windows 编译通过
□ 状态转换可观测
```

---

## 4. Phase 3: 输入可靠性与持久化（预计 3-5 天）

### 子任务

```
□ 3.1 agent-stdin-writer.ts — 智能写入策略（依赖 2.6）
  实现: 等待提示符 → bracketed paste → 提交回车
  区分: 交互式 CLI vs 非交互式
  参考: Hive post-start-input-writer.ts

□ 3.2 agent-stdin-dispatcher.ts — 消息格式化（依赖 2.4, 2.6）
  实现: [Slock 系统消息] + <slock-system-reminder> tail
  五种消息: dispatch/report/status/cancel/reminder
  参考: Hive agent-stdin-dispatcher.ts

□ 3.3 command-presets.ts — CLI 预设参数表（无依赖）
  claude/codex/gemini/opencode 的 yolo + resume 参数
  参考: Hive command-preset-defaults.ts

□ 3.4 agent-run-store.ts — 运行记录持久化（依赖 2.1）
  JSON 文件存储 AgentRunRecord + AgentRuntimeState
  接口: 设计为可迁移到 SQLite
```

### 验收标准

```
□ stdin 写入等待提示符出现（不丢内容）
□ 消息正确含系统标签 + tail reminder
□ CLI 预设参数自动注入
□ daemon 重启后恢复 agent 运行状态
```

---

## 5. Phase 4: 正确性与并发（预计 2-3 天）

### 子任务

```
□ 4.1 并发启动保护（依赖 2.6）
  改动: startPromises dedup 模式
  参考: Hive agent-runtime.ts startAgent

□ 4.2 完整退出处理链（依赖 2.6, 2.2）
  改动: pendingExitCode → completeLiveRun → revokeIfMatches
  参考: Hive agent-run-exit-handler.ts

□ 4.3 启动中退出保护（依赖 2.3, 2.6）
  改动: createExitEntry → add → hasPendingExitCode 流程
```

### 验收标准

```
□ 同一 agent 连续两次 agent:deliver 不启动两个进程
□ 进程在启动过程中退出，不产生 stale token
□ 进程退出后所有资源正确清理
```

---

## 6. Phase 5: 锦上添花（预计 3-5 天）

### 子任务

```
□ 5.1 agent-sessions.ts — 会话 ID 恢复（无依赖）
  对接各 CLI 的会话文件位置
  参考: Hive session-capture-*.ts

□ 5.2 空闲回收（依赖 2.6）
  60s 空闲超时 → 优雅关闭 → 保存 sessionId

□ 5.3 重启恢复摘要（依赖 2.4, 3.4）
  进程重启时注入恢复摘要
  参考: Hive restart-policy.ts

□ 5.4 跨平台命令解析（依赖 2.5）
  PATH 搜索 + PATHEXT + .cmd/.bat 处理
  参考: Hive agent-command-resolver.ts
```

### 验收标准

```
□ 代理重启后恢复前次 session
□ 60s 空闲后进程自动回收
□ 重新唤醒时带恢复摘要
□ Windows 下 .cmd/.bat 正常执行
```

---

## 7. 时间线

```
Week 1         Week 2        Week 3         Week 4
┌────────┐    ┌────────┐    ┌────────┐    ┌────────┐
│Phase 1 │    │  Phase 2   │  Phase 3  │    │Ph4│Ph5 │
│2-3 天  │    │  5-7 天    │  3-5 天   │    │2-3│3-5 │
│        │    │           │           │    │   │    │
│□ 1.1   │    │□ 2.1 type │□ 3.1      │    │□4.1│□5.1│
│□ 1.2   │    │□ 2.2 token│  stdin    │    │□4.2│□5.2│
│□ 1.3   │    │□ 2.3 reg  │  writer   │    │□4.3│□5.3│
│□ 1.4   │    │□ 2.4 st.  │□ 3.2      │    │    │□5.4│
│□ 1.5-6 │    │□ 2.5 mgr  │  msg fmt  │    └────┘    │
└────────┘    │□ 2.6 run. │□ 3.3      │              │
              │□ 2.7 core │  presets  │              │
              │□ 2.8 stat │□ 3.4      │              │
              └───────────┤  store    │              │
                          └───────────┘              │
              ▲                                       │
              └── 核心分支 (feature/daemon-refactor) ──┘
```

---

## 8. 风险与回退

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| node-pty Windows 编译失败 | 🟡 中 | 🔴 高 | Phase 1 保留 child_process，Phase 2 并行验证 |
| 拆分 core.ts 漏依赖 | 🟡 中 | 🟡 中 | 逐个方法拆分，每步跑 CI |
| Token 引入破坏现有认证 | 🟢 低 | 🔴 高 | Phase 2 用 feature flag 切换 |
| JSON 文件并发写入 | 🟢 低 | 🟡 中 | atomic write 模式 |

### 回退策略

```
Phase 1 失败: git checkout HEAD，零影响
Phase 2 失败: 切回原 core.ts，feature branch 保留
Phase 3+ 失败: 回退到 Phase 2
```
