# ⑤ 安全模型

> 生成日期：2026-07-15
> 用途：定义 Slock Daemon 的信任边界、认证机制和安全的 Token 生命周期
> 对比基准：Hive `agent-tokens.ts` 的安全模式

---

## 1. 威胁模型

### 1.1 假设

1. daemon 进程运行在用户本地机器上，与用户有相同的 OS 用户权限
2. 服务端是可信的（HTTPS + Bearer token 认证）
3. 子进程（Claude/Codex 等）运行在同一 OS 用户下，但不应自动获得 daemon 控制权
4. 本地 127.0.0.1 是可信的，但同局域网不可信
5. daemon exit 回调时序不可控——旧进程可能在新进程 spawn 后仍触发回调

### 1.2 不防护的范围

- 不防恶意子进程（AI agent 本身能执行任意 shell 命令）
- 不防 OS 提权攻击（以当前 OS 用户权限运行）
- 不防物理攻击

### 1.3 需要防护的攻击场景

| 威胁 | 场景 | 严重度 | 当前状态 |
|------|------|--------|----------|
| **T1: Token 混淆** | 旧进程退出回调吊销新进程的 token | 🔴 高 | ❌ 无保护 |
| **T2: 重放攻击** | 截获的 token 被用于冒充 agent | 🟡 中 | ❌ token 无过期 |
| **T3: 凭证泄露** | 子进程获得 daemon 的 apiKey | 🟡 中 | ❌ apiKey 直接进入 env |
| **T4: 文件泄露** | 未授权读取 system prompt 文件 | 🟢 低 | ✅ OS 文件权限 |

---

## 2. 信任边界

### 当前（问题结构）

```
[服务端] ←── HTTPS/Bearer ──→ [Daemon Core]
                                  │
                                  │ spawn + env (apiKey 直接给子进程!)
                                  ▼
                              [子进程] ←── 可冒充 daemon
```

### 目标（Phase 2）

```
[服务端] ←── HTTPS/Bearer ──→ [Daemon Core]
                                  │
                          tokenRegistry.issue(agentId)
                                  │
                                  │ spawn + env (runtime_token, 受 scope 限制)
                                  ▼
                              [子进程] ←── 仅能调 agent API
```

---

## 3. 当前安全缺陷

| 编号 | 问题 | 位置 | 后果 |
|------|------|------|------|
| S-01 | **apiKey 直接暴露给子进程** | `core.ts:282-286` | 子进程可冒充 daemon 执行任意 API |
| S-02 | **无 token 吊销机制** | `core.ts` | 进程退出后 token 仍有效 |
| S-03 | **无 revokeIfMatches** | `core.ts` | 旧回调误清新 token |
| S-04 | **硬编码 agentId** | `core.ts:24` | 不支持多 daemon |
| S-05 | **WS 无超时** | `core.ts:156-158` | 连接可能 hang |

---

## 4. Token 生命周期

### 4.1 层次结构

```
Layer 1: Service API Key
  - 来源: CLI --api-key
  - 用途: daemon ↔ 服务端
  - 范围: 全部权限
  - 存储: 仅 daemon 内存

Layer 2: Runtime Token (Phase 2 新增)
  - 来源: tokenRegistry.issue(agentId)
  - 用途: 子进程认证
  - 范围: 受 scope 限制的 agent API
  - 生命周期: spawn → exit

Layer 3: Session Token (未来)
  - 服务端 WS 下发的短期 token
  - 单次请求有效
```

### 4.2 TokenRegistry 实现（参考 Hive）

```typescript
export const createAgentTokenRegistry = (): AgentTokenRegistry => {
  const tokens = new Map<string, string>();

  return {
    issue(agentId) {
      const token = crypto.randomUUID();
      tokens.set(agentId, token);
      return token;
    },
    peek(agentId) {
      return tokens.get(agentId);
    },
    validate(agentId, token) {
      if (!token) return false;
      const expected = tokens.get(agentId);
      return expected !== undefined && expected === token;
    },
    revokeIfMatches(agentId, token) {
      // ★ 只有匹配才删除——防止旧回调误清新 token
      if (tokens.get(agentId) === token) {
        tokens.delete(agentId);
      }
    },
  };
};
```

---

## 5. Token 时序保护

### 竞态：旧进程退出 vs 新进程启动

```
时间: t1         t2        t3        t4        t5
进程A: spawn ── work ──── exit ─── exit_cb ── revokeIfMatches(id, tokenA)
                                                         │
进程B:                spawn ── issue(tokenB) ── work ──→ │
                                                         │
                                                  tokenA ≠ tokenB → 不删除
                                                  进程B 安全
```

### 竞态：启动中退出

```
spawn() → createExitEntry() → add() → ... → handleExit()
              │                  │
        进程在 add() 前退出 ────→ setPendingExitCode(code)
                                  │
                            add() 后检查 pending → 立即处理
```

### 竞态：多次 agent:start

```
agent:start(name) → issue(tokenA) → spawn A
agent:start(name) → issue(tokenB) → spawn B  // 覆盖 tokenA
A.exit_cb → revokeIfMatches(name, tokenA)    // ≠ tokenB → 安全
```

---

## 6. 环境变量方案

### Phase 2 目标

```typescript
// 运行时 token 替代 apiKey
const runtimeToken = tokenRegistry.issue(agentId);

const env = {
  SLOCK_AGENT_ID: agentId,
  SLOCK_AGENT_TOKEN: runtimeToken,           // ← 会话级，非 apiKey
  SLOCK_SERVER_URL: this.serverUrl,
  SLOCK_AGENT_ACTIVE_CAPABILITIES: 'send,read,mentions',  // scope 限制
};

// daemon 的 apiKey 永不进入子进程环境变量
```

### 安全规则

```
规则 1: SLOCK_AGENT_TOKEN 是运行时 token，不是 apiKey
规则 2: 不同 agent 会话的 token 不同
规则 3: 同一 agent 的不同轮次 token 不同
规则 4: daemon apiKey 永不进入子进程 env
规则 5: 运行时 token 受 scope 限制
```

---

## 7. 文件系统安全

| 文件 | 内容 | 要求 |
|------|------|------|
| `.slock/sysprompt-{name}.md` | Agent 指令 | 仅 daemon 写 |
| `.slock/workspaces/{name}/MEMORY.md` | 长期记忆 | agent 读写 |
| `.slock/daemon-state.json` | 运行时状态 | 仅 daemon 读写 |
| `.slock/slock.bat` | 环境变量脚本 | 仅 daemon 写 |

**token 永不入持久化文件**，仅存运行时内存。

---

## 8. WS 安全

| 改进 | Phase | 说明 |
|------|-------|------|
| WS 连接超时 5s | Phase 1 | 超时则重连 |
| 4001 认证失败不再重连 | 已有 | 保留 |
| 消息校验 (zod) | Phase 2 | 类型安全 |
| 心跳 ping/pong | 未来 | 保活 |

---

## 附录：安全改进 CheckList

```
Phase 1
□ WS 连接超时 5s

Phase 2
□ agent-tokens.ts 完整实现
□ env 改用运行时 token（非 apiKey）
□ 启动流水线集成 token issue
□ 退出处理集成 revokeIfMatches
□ scope 机制

未来
□ 短期 session token
□ 动态 token 刷新
□ 审计日志
```
