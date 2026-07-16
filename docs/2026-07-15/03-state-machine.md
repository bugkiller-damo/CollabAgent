# ③ 代理生命周期状态机

> 生成日期：2026-07-15
> 参考：Hive 三态模型 (idle/working/stopped) + 新增 starting 中间态
> 用途：所有 agent 管理代码的状态转换依据

---

## 1. 状态总览

### 四态定义

```
uninit ──→ idle ──→ starting ──→ working ──→ stopped
  ↑                                            │
  └────────────────────────────────────────────┘
```

| 状态 | 含义 | 解释 |
|------|------|------|
| `uninit` | 未初始化 | agent 已注册到路由表，但从未被调用过 |
| `idle` | 空闲 | 进程已退出且运行记录已归档，等待下次消息 |
| `starting` | 启动中 | 进程正在 spawn，尚未就绪 |
| `working` | 工作中 | 进程存活且正在处理消息（可能有排队） |
| `stopped` | 已停止 | 进程已退出、被 kill、或 agent:stop 注销 |

### 当前 Slock 隐式状态 vs 目标

```
目前 Slock 的状态隐式表达：
- uninit:     agentDrivers 有 entry，但 persistentSessions 无
- idle:       不存在（当前设计无此状态）
- starting:   不存在（dispatchToAgent 正在 await spawn）
- working:    persistentSessions.get(agentName) 存在
- stopped:    agentDrivers 删除了 entry

问题：starting 态被隐藏（spawn 耗时被吞掉），idle 态不存在（无法判断"活着但闲着"）
```

---

## 2. 状态转换图

```
                          agent:start
                 ┌───────────────────────────┐
                 │                           ▼
              ┌──────┐   agent:start      ┌───────┐
              │uninit│──────────────────→ │ idle  │
              └──────┘                    └───┬───┘
                                              │
                     agent:deliver /          │
                     reminder.fire /          │ DM
                                              ▼
                                        ┌─────────┐
                                        │ starting │
                                        └────┬─────┘
                                   ┌──────────┼──────────┐
                                   │          │          │
                              spawn 成功   spawn 失败   超时 15s
                                   │          │          │
                                   ▼          ▼          ▼
                              ┌─────────┐ ┌───────┐ ┌───────┐
                              │ working │ │ idle  │ │ idle  │
                              └────┬────┘ └───────┘ └───────┘
                         ┌─────────┼──────────┐
                         │         │          │
                    handleMessage  空闲超时   agent:stop
                    ／dispatch       60s         │
                         │         │          │
                         ▼         ▼          ▼
                     (stay)   ┌───────┐  ┌──────────┐
                              │ idle  │  │ stopped  │
                              └───────┘  └──────────┘
                                                    │
                                              agent:start
                                                    │
                                                    ▼
                                                ┌───────┐
                                                │ idle  │
                                                └───────┘
```

### 简化正常路径

```
uninit ──── agent:start ──────→ idle
idle ────── agent:deliver ────→ starting
starting ── spawn 成功 ───────→ working
working ─── 完成/空闲超时 ────→ idle
working ─── agent:stop ───────→ stopped
stopped ─── agent:start ──────→ idle
```

---

## 3. 状态转换表

| 当前状态 | 事件 | 条件 | 动作 | 新状态 | 异常处理 |
|----------|------|------|------|--------|----------|
| `uninit` | `agent:start` | 注册信息有效 | 存储 agent 信息到 route table | `idle` | - |
| `uninit` | `agent:deliver` | - | 不可直接派发，需先 start | 不变 | 打印警告，忽略 |
| `idle` | `agent:start` | - | 更新 agent 信息，重置运行记录 | `idle` | - |
| `idle` | `agent:deliver` | 有 launch config | 1.`tokenRegistry.issue()` 2.`spawnProcess()` 3.启动 15s 超时计时器 | `starting` | spawn 失败→`idle` |
| `idle` | `agent:deliver` | 无 launch config | 用默认配置启动 | `starting` | 无默认配置→忽略 |
| `idle` | `agent:stop` | - | 从 route table 删除 | `stopped` | - |
| `starting` | spawn 成功 | readiness 通过 | 1.取消超时计时器 2.`registry.add()` 3.注入启动指令 4.write stdin | `working` | - |
| `starting` | spawn 失败 | exit code ≠ 0 | 1.`tokenRegistry.revokeIfMatches()` 2.记录日志 3.通知服务端 | `idle` | - |
| `starting` | 15s 超时 | - | 1.`process.kill()` 2.`tokenRegistry.revokeIfMatches()` 3.日志警告 | `idle` | 下次消息重试 |
| `starting` | `agent:stop` | - | 1.`process.kill()` 2.`tokenRegistry.revokeIfMatches()` 3.从 route table 删除 | `stopped` | - |
| `working` | handleMessage 完成 | - | pump 下一队列消息 | `working` | - |
| `working` | 队列为空 | 空闲超时 60s | 1.`process.kill()` 2.`tokenRegistry.revokeIfMatches()` 3.记录运行历史 | `idle` | 下次消息自动恢复 |
| `working` | `agent:deliver` (新消息) | - | 1.格式化消息 2.写入 stdin 3.重设空闲计时器 | `working` | 写入错误→尝试重启 |
| `working` | 进程退出 (exit 0) | - | 1.`completeLiveRun()` 2.`tokenRegistry.revokeIfMatches()` 3.通知 onAgentExit | `idle` | 需要重启→自动恢复 |
| `working` | 进程退出 (exit ≠ 0) | - | 同上 + 记录错误日志 | `idle` | 同上 |
| `working` | turn timeout (5min) | - | 1.`process.kill()` 2.日志警告 3.`tokenRegistry.revokeIfMatches()` | `idle` | - |
| `working` | `agent:stop` | - | 1.`process.kill()` 2.`tokenRegistry.revokeIfMatches()` 3.从 route table 删除 | `stopped` | - |
| `stopped` | `agent:start` | - | 重建 route table entry | `idle` | - |
| `stopped` | `agent:deliver` | - | 忽略（agent 已注销） | 不变 | 打印日志 |
| 任意 | daemon shutdown | - | 1.kill 所有进程 2.revoke 所有 token 3.持久化 | (退出) | - |

---

## 4. 核心不变式

```
规则 1: 任意时刻，一个 agent 最多有一个活跃进程
规则 2: working 态必有对应进程、token、registry entry
规则 3: 非 working 态必无活跃进程（idle 可能保留配置但无进程）
规则 4: token 在 spawn 之前签发，在进程退出/超时后吊销
规则 5: 启动失败必须回滚所有已分配资源（token、文件句柄等）
规则 6: 同一 agent 的两次 agent:deliver 不可同时启动两个进程
         实现: startPromises dedup
规则 7: 进程退出回调与新的 start 调用不可产生竞态
         实现: token revokeIfMatches
规则 8: 正在 starting 时收到新消息→排队等待，不触发第二次 spawn
         实现: 启动锁 + 消息队列 per agent
```

---

## 5. 资源生命周期

```
token    : ─────── issue ───────────────── revoke
process  :           └─── spawn ──── kill ─┘
registry :           └─── add ── remove ─┘
sessionId: ─────── capture ─────────── save ─┘

步骤: [1]token.issue  [2]spawn  [3]registry.add  [4]指令注入  [5]处理  [6]退出清理
```

---

## 6. 时序保护

### 6.1 启动/退出竞态

```
场景: 进程1 exit → 回调未执行 → 进程2 spawn → 进程1 回调吊销了进程2 的 token
保护: revokeIfMatches(agentId, token1) 只删 token1，不碰 token2
```

### 6.2 启动中退出

```
场景: 进程刚 spawn 但未 registry.add() → 立即崩溃
保护:
  1. spawn 后立即 createExitEntry(runId)  ← 先注册退出通道
  2. 进程在 add() 前退出 → setPendingExitCode(runId, code)
  3. add() 后检查 hasPendingExitCode() → 立即处理退出
```

### 6.3 并发 agent:deliver

```
场景: 两条 agent:deliver 几乎同时到达
保护:
  1. startPromises Map: start(key) → Promise<run>
  2. 已有 pending start → 返回同一个 Promise
  3. 已有 active run → 直接写入 stdin，不 spawn
```

---

## 7. 超时策略

| 超时名 | 阈值 | 触发 | 处理 |
|--------|------|------|------|
| `STARTUP_TIMEOUT` | 15 秒 | `starting` → 超时 | kill + revoke token + 日志 |
| `TURN_TIMEOUT` | 5 分钟 | `working` → 消息处理超时 | kill + revoke + 日志 |
| `IDLE_TIMEOUT` | 60 秒 | `working` → 队列空 + 无写入 | 优雅关闭 + 保存 sessionId |
| `WS_RECONNECT_BASE` | 1 秒 | WS 断线 | 指数退避重连 |
| `WS_RECONNECT_MAX` | 30 秒 | 重连延迟上限 | 超过此值不再增长 |

### 超时配置化接口

```typescript
interface TimeoutConfig {
  startupTimeout: number;    // default 15000 (ms)
  turnTimeout: number;       // default 300000 (ms)
  idleTimeout: number;       // default 60000 (ms)
  wsReconnectBase: number;   // default 1000 (ms)
  wsReconnectMax: number;    // default 30000 (ms)
}
```

---

## 8. 持久化数据结构

### 8.1 运行时状态 (Phase 1 JSON)

```typescript
interface AgentRuntimeState {
  agentId: string;
  agentName: string;

  status: 'uninit' | 'idle' | 'starting' | 'working' | 'stopped';
  lastTransitionAt: number;  // Date.now()

  totalRuns: number;
  currentRunId: string | null;

  lastSessionId: string | null;
  lastSessionUpdatedAt: number | null;

  command: string;
  args: string[];

  createdAt: number;
  updatedAt: number;
}
```

### 8.2 运行历史

```typescript
interface AgentRunRecord {
  runId: string;
  agentId: string;
  agentName: string;

  status: 'starting' | 'running' | 'exited' | 'error';
  exitCode: number | null;

  startedAt: number;
  endedAt: number | null;

  messagesProcessed: number;
  lastTurnDuration: number | null;  // ms
}
```

### 8.3 Token 记录

```typescript
interface TokenRecord {
  agentId: string;
  token: string;
  issuedAt: number;
  revokedAt: number | null;
}
```

---

## 9. 与外部系统的映射

### WS 消息 → 状态转换

| WS 消息 | 触发转换 | 备注 |
|---------|----------|------|
| `agent:start` | `uninit→idle` 或 `stopped→idle` | 注册路由表 |
| `agent:deliver` | `idle→starting` 或 `working→working` | 消息入队 |
| `agent:stop` | 任意→`stopped` | 清理所有资源 |
| `reminder.fire` | `idle→starting` 或 `working→working` | 同 agent:deliver |

### 进程事件 → 状态转换

| 事件 | 转换 | 备注 |
|------|------|------|
| spawn 成功 | `starting→working` | readiness check 通过 |
| spawn 失败 | `starting→idle` | 回滚所有资源 |
| exit code = 0 | `working→idle` | 正常结束 |
| exit code ≠ 0 | `working→idle` | 异常退出 |
| idle timeout | `working→idle` | 优雅回收 |

### 状态 → 对服务端上报

| 状态 | 上报 | 含义 |
|------|------|------|
| `uninit` | 不上报 | - |
| `idle` | `{status:"idle"}` | 可接收消息 |
| `starting` | `{status:"starting"}` | 正在启动 |
| `working` | `{status:"working"}` | 忙碌中 |
| `stopped` | 不上报 | 已注销 |
