# Slock Daemon Goal Mode — 自主运行配置

> 生成日期：2026-07-15
> 用途：让 Claude 在本 session 中持续自主工作，执行 daemon 重构路线图（Phase 1→5）

---

## 一、总体目标

在 `D:\code\slock` 项目上，执行 `docs/2026-07-15/06-priority-roadmap.md` 定义的 5 个 Phase，
将 `packages/daemon/src/` 从 447 行单体文件 + 脆弱子进程管理的 prototype，
升级为多模块、安全 token 管理、可靠 stdin 写入、有状态模型的工程化实现。

---

## 二、Loop 模式配置

### 2.1 启动方式

初次启动：

```
1. 写 goal-progress.json（初始值见附录）
2. /loop 3m /goal
```

后续 loop 迭代自动通过 ScheduleWakeup 维持。

### 2.2 调度节奏

| Phase | 间隔 | 原因 |
|-------|------|------|
| Phase 1（小改动） | 180s (3min) | cache 温热，快速迭代 |
| Phase 2+（大改动） | 600s (10min) | 需要编译时间 |

### 2.3 退出条件

```
□ 所有 5 个 Phase 全部完成 → stop loop
□ 连续 3 次无实质进展 → 汇报阻塞原因，等待用户
□ 用户输入新指令 → 自动中断 loop
□ 累计超过 30 次迭代 → 自动 stop（防止 runaway）
```

---

## 三、进度追踪

### 3.1 进度文件

`D:\code\slock\.claude\goal-progress.json`

```json
{
  "currentPhase": 1,
  "completedTasks": [],
  "currentTask": "1.1",
  "blocked": false,
  "blockedReason": null,
  "totalIterations": 0,
  "lastStatus": "Starting Phase 1.1: shorten turn timeout 180s→60s",
  "startedAt": "2026-07-15T10:00:00.000Z",
  "notes": []
}
```

每次迭代**起始**读此文件确定任务，**结束**更新此文件。

### 3.2 任务清单（26 项）

| ID | 描述 | 文件 | 估算迭代 |
|----|------|------|----------|
| **Phase 1** | | | **6** |
| 1.1 | turn timeout 180s→60s | persistent-claude.ts | 1 |
| 1.2 | 启动延迟 1s | persistent-claude.ts | 1 |
| 1.3 | 错误日志不吞 | core.ts | 1 |
| 1.4 | loadExistingAgents await | core.ts | 1 |
| 1.5 | 删除 logStatus 死代码 | core.ts | 1 |
| 1.6 | await import→顶楼 import | core.ts | 1 |
| **Phase 2** | | | **8** |
| 2.1 | types/index.ts | 新增 | 1 |
| 2.2 | agent-tokens.ts | 新增 | 1 |
| 2.3 | live-run-registry.ts | 新增 | 1 |
| 2.4 | agent-startup.ts | 新增 | 1 |
| 2.5 | agent-manager.ts (node-pty) | 新增 | 2 |
| 2.6 | agent-runtime.ts | 新增 | 2 |
| 2.7 | 精简 daemon-core.ts | 修改 | 1 |
| 2.8 | 四态模型集成 | 修改 | 1 |
| **Phase 3** | | | **5** |
| 3.1 | agent-stdin-writer.ts | 新增 | 2 |
| 3.2 | agent-stdin-dispatcher.ts | 新增 | 1 |
| 3.3 | command-presets.ts | 新增 | 1 |
| 3.4 | agent-run-store.ts | 新增 | 1 |
| **Phase 4** | | | **3** |
| 4.1 | 并发启动保护 | agent-runtime.ts | 1 |
| 4.2 | 退出处理链 | agent-runtime.ts | 1 |
| 4.3 | 启动中退出保护 | registry | 1 |
| **Phase 5** | | | **4** |
| 5.1 | agent-sessions.ts | 新增 | 1 |
| 5.2 | 空闲回收 | persistent-claude.ts | 1 |
| 5.3 | 重启恢复摘要 | agent-startup.ts | 1 |
| 5.4 | 跨平台命令解析 | agent-manager.ts | 1 |

---

## 四、每次迭代执行流程

### Step 1: 读进度

```
const p = JSON.parse(read('D:\\code\\slock\\.claude\\goal-progress.json'))
taskId = p.currentTask
```

### Step 2: 加载对应设计文档

| Phase | 参考文档 |
|-------|----------|
| 1 | `01-current-state-inventory.md` |
| 2 | `02-architecture-decision-records.md` + `04-module-decomposition.md` |
| 3 | `04-module-decomposition.md` + `02-architecture-decision-records.md` |
| 4 | `03-state-machine.md` |
| 5 | `04-module-decomposition.md` |

### Step 3: 读取要改的源文件

### Step 4: 执行改动

一次迭代**只做一个任务**（一个文件）。

### Step 5: 验证

```
npx tsc --noEmit -p packages/daemon/tsconfig.json
```

### Step 6: 更新进度

```
p.completedTasks.push(taskId)
p.currentTask = nextId
p.totalIterations += 1
p.lastStatus = "Done X.Y: ..."
write(progress.json, JSON.stringify(p))
```

### Step 7: 调度下次

```
ScheduleWakeup({
  delaySeconds: phase===1 ? 180 : 600,
  prompt: "<<autonomous-loop-dynamic>>",
  reason: "完成 X.Y, 下一个: X.Z"
})
```

### Step 8: 向用户汇报

```
SendMessage({
  to: "main",
  summary: "Done X.Y: short desc",
  message: "✅ Phase X.Y 完成: desc\n📊 进度: Phase X (a/b)\n⏭️ 下一个: X.Z\n📝 notes"
})
```

---

## 五、决策规则

### 自主执行

```
□ 修改参数（timeout/delay）
□ 新增 < 80 行模块
□ 删除死代码
□ 拆分函数到新文件
□ 修复类型错误
```

### 暂停并询问

```
□ 编译错误 2 次无法解决
□ 需安装新依赖（node-pty, better-sqlite3）
□ 计划与代码实际不符
□ 同一任务失败 3 次
□ 需用户在服务端操作
```

### 跳过

```
□ 本机无某 CLI → notes 记录 → 继续
□ 模块已部分存在 → 复用 → 继续
```

---

## 六、错误恢复

| 错误 | 处理 |
|------|------|
| 编译错误 | 读错误输出 → 修复 → 最多 2 次 |
| 结构性错 | 回退改动 → 记录 blocked |
| 进度文件丢失 | 从 Phase 1.1 开始 |
| 进度文件损坏 | 检查 git log → 重建 |

---

## 七、Slash Command 注册

写入 `D:\code\slock\.claude\settings.json`:

```json
{
  "slash_commands": [
    {
      "name": "goal",
      "description": "Continue executing Slock daemon upgrade plan",
      "prompt": "你现在处于 goal mode。读取 D:\\code\\slock\\.claude\\goal-progress.json 了解当前进度，然后按 06-priority-roadmap.md 执行下一个未完成的任务。每次迭代只做一件事。完成后更新进度文件并调用 ScheduleWakeup 调度下一次。如果阻塞，用 SendMessage 向 main 汇报。"
    }
  ],
  "permissions": {
    "allow": ["Bash","Read","Write","Edit","Glob","Grep","Agent","ScheduleWakeup","SendMessage"]
  }
}
```

---

## 附录：初始进度文件

```json
{
  "currentPhase": 1,
  "completedTasks": [],
  "currentTask": "1.1",
  "blocked": false,
  "blockedReason": null,
  "totalIterations": 0,
  "lastStatus": "Starting Phase 1.1",
  "startedAt": null,
  "notes": []
}
```

首次启动时写入此文件，然后 `/loop 3m /goal`。
