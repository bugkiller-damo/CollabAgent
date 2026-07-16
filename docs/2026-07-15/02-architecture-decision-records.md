# ② 架构决策记录 (ADR)

> 生成日期：2026-07-15
> 范围：Slock Daemon 重构（Phase 1-5）
> 格式：每个 ADR 包含问题、选项、决策、理由、后果

---

## ADR-001: 进程管理方案

### 问题
子进程管理应该使用 `node-pty`（真实 PTY）还是继续使用 `child_process.spawn`？

### 选项

| 选项 | 优点 | 缺点 |
|------|------|------|
| **A: child_process.spawn** | 无额外依赖，实现简单 | 无真实终端，ANSI/颜色输出可能丢失，无法 resize，无法暂停/恢复 |
| **B: node-pty** | 真实 PTY 终端，支持 resize/pause/resume，与 Hive 一致的架构 | 额外原生依赖（node-pty v1.x），Windows 兼容性需处理 |

### 决策
**采用 B: node-pty**（Phase 2 引入）

### 理由
1. 计划支持 Codex/Gemini/OpenCode 等多 CLI，这些 CLI 依赖真实终端渲染
2. 需要 `resize` 功能以适配不同终端宽度
3. 与 Hive 一致的 PTY 管理方案，降低学习和移植成本
4. `node-pty` 已经成熟（v1.x，Hive 已验证可用）

### 后果
- 需要在 `package.json` 中添加 `node-pty` 依赖
- 安装时需原生编译（macOS Xcode, Linux build-essential, Windows Visual Studio）
- Hive 的 `agent-manager.ts` 可直接作为参考实现
- 当前 PersistentClaude 的 `child_process.spawn` 在 Phase 1 保留，Phase 2 替换

---

## ADR-002: 持久化方案

### 问题
代理运行时状态应该存储在 SQLite、JSON 文件、还是继续全内存？

### 选项

| 选项 | 优点 | 缺点 |
|------|------|------|
| **A: 全内存** | 零依赖，零延迟 | daemon 重启丢失所有状态，无法查询历史 |
| **B: JSON 文件** | 实现简单，人类可读 | 无并发控制，更新需全量写入，不适合频繁写 |
| **C: better-sqlite3** | 事务支持，并发安全，查询能力强，Hive 已验证 | 额外原生依赖，增加约 2MB 安装体积 |

### 决策
**Phase 1 采用 B: JSON 文件**，**Phase 3 迁移到 C: better-sqlite3**

### 理由 (Phase 1 选 B)
1. Phase 1 只需持久化 token 映射、agent 注册表和少量配置
2. JSON 文件 10 行代码即可实现，快速迭代
3. 写入频率不高（仅启动/停止/重启时写），JSON 性能足够

### 理由 (Phase 3 迁 C)
1. 需要查询能力时（历史运行记录、消息查找），JSON 无法满足
2. 多条记录并发写入时 JSON 文件易损坏
3. 与 Hive 一致的持久化方案

### 后果
- Phase 1: 实现 `AgentStateStore` 接口，后端用 JSON 文件
- Phase 3: 同一接口替换为 SQLite 实现，上层代码无需修改

---

## ADR-003: 状态模型

### 问题
代理生命周期的状态模型应该是什么？

### 选项

| 选项 | 优点 | 缺点 |
|------|------|------|
| **A: 自定义复杂状态** | 精确匹配业务需求 | 设计成本高，难与团队对齐 |
| **B: Hive 三态模型 (idle/working/stopped)** | 简洁已被验证足够 | 缺少"启动中"中间态 |
| **C: 四态模型 (idle/starting/working/stopped)** | 覆盖"启动中"瞬时态，更精确 | 略增复杂度 |

### 决策
**采用 C: 四态模型**

```
idle ──→ starting ──→ working ──→ stopped
  ↑                                      │
  └──────────────────────────────────────┘
```

### 理由
1. Hive 三态 (`idle`/`working`/`stopped`) 已被验证足够
2. 但 Slock 场景不同：agent:deliver 时可能需要先 spawn 进程（启动延迟）
3. `starting` 态可精确追踪启动耗时，便于诊断"5 分钟才回 hello"的问题
4. 与 Hive 对齐，降低跨项目学习成本

### 后果
- 需要在 daemon-core 和持久化中增加 `starting` 态
- 启动超时可精确归因（`starting` 超时 → 日志 → 通知）
- 需要定义超时阈值：`starting` 超过 15s 视为失败

---

## ADR-004: Token 管理方案

### 问题
子进程认证 token 应该由运行时动态签发管理，还是继续从环境变量读取静态值？

### 选项

| 选项 | 优点 | 缺点 |
|------|------|------|
| **A: 静态环境变量** | 简单 | 无吊销机制，旧进程 token 永远有效，竞态问题 |
| **B: 运行时签发 + 验证** | 完整生命周期管理，吊销保护 | 增加 token 传递复杂度 |
| **C: 运行时签发 + 验证 + 匹配吊销** | 防止旧进程回调误清新 token | 实现复杂度最高，但最安全 |

### 决策
**采用 C: 运行时签发 + 验证 + `revokeIfMatches`**（参考 Hive `agent-tokens.ts`）

### 理由
1. 子进程崩溃重启时，旧进程的退出回调可能晚于新进程的 token 签发
2. 不使用匹配检查 → 旧退出回调会清掉新 token → 新进程后续认证全部失败
3. Hive 的 `revokeIfMatches` 模式已被生产验证
4. 安全是第一优先级（代理 token 是 daemon 的唯一认证凭据）

### 后果
- 启动流水线中新增 `tokenRegistry.issue(agentId)` 步骤（spawn 前签发）
- 环境变量中注入运行时 token（而非直接传递 apiKey）
- 退出处理器中调用 `tokenRegistry.revokeIfMatches()`
- 需要实现 `AgentTokenRegistry` 接口（参考 Hive `agent-tokens.ts` 约 40 行）

---

## ADR-005: 持久会话 vs 按需启动

### 问题
代理消息到来时应该使用持久化子进程（进程常驻）还是每次消息临时启动？

### 选项

| 选项 | 优点 | 缺点 |
|------|------|------|
| **A: 持久会话** | 零冷启动延迟，进程温热可直接交互 | 内存占用，进程可能泄漏，需心跳保活 |
| **B: 按需启动** | 内存零占用，完全隔离，无泄漏风险 | 每次冷启动 2-5 秒，不适合快速对话 |
| **C: 混合（首选持久，超时回收）** | 兼具两者优点 | 实现复杂度最高 |

### 决策
**采用 C: 混合模式**（参考 Hive PersistentClaude + restart-policy）
- 默认持久会话，60s 空闲超时后回收
- 新消息到达时自动恢复（有恢复摘要）
- 支持环境变量配置空闲超时

### 理由
1. 聊天场景需要低延迟（持久化）
2. 空闲时释放资源（回收）
3. 恢复摘要让 agent 能快速重新锚定上下文

### 后果
- PersistentClaude 需增加空闲计时器 + 自动回收逻辑
- 回收前需保存最后一次交互的 sessionId
- 重新唤醒时生成恢复摘要（参考 Hive `restart-policy.ts`）

---

## ADR-006: 消息协议格式

### 问题
daemon 传递给子进程的消息应该使用 SDK stream-json 还是结构化文本？

### 选项

| 选项 | 优点 | 缺点 |
|------|------|------|
| **A: stream-json (当前)** | 结构化，Claude SDK 原生支持 | 非人类可读，调试困难，依赖具体 SDK |
| **B: 纯文本透传** | 简单 | LLM 分不清系统消息和用户消息 |
| **C: 结构化文本 + XML 标签** | 人类可读，LLM 对 XML 标签敏感，self-describing | 解析需额外代码 |

### 决策
**保留 A (stream-json) 作为与 Claude 的传输协议，在写入前用 C (结构化文本) 格式化内容**

即：内部系统消息用结构化文本包装后传入：

```
[Slock 系统消息：来自 @<sender> 的消息]

<消息正文>

<Slock-system-reminder>
你是一个 Slock 团队中的 <role>。
可用命令...
</Slock-system-reminder>
```

### 理由
1. stream-json 是 Claude SDK 的标准交互方式，不应替换
2. 但外部消息需要与系统提示区隔——结构化文本是最有效的 LLM 控制手段
3. Hive 的 `<hive-system-reminder>` XML 标签方案已被验证有效
4. tail-reminder 防止 context window 压缩后丢失身份锚定

### 后果
- `agent-stdin-dispatcher.ts`（新增）负责消息格式化
- 每条从 WS 收到的 `agent:deliver` 都经过格式化再注入 stdin
- 需要维护 agent 角色规则模板

---

## ADR-007: 输入写入策略

### 问题
向子进程 stdin 写入指令时，应该立即写入还是等待进程就绪再写入？

### 选项

| 选项 | 优点 | 缺点 |
|------|------|------|
| **A: 直接写入** | 简单 | 进程未就绪时写入的内容可能丢失 |
| **B: 延迟固定时间后写入** | 比 A 可靠 | 延迟时间难以确定，太长或太短都有问题 |
| **C: 等待提示符出现 + bracketed paste** | 最可靠，已知进程就绪 | 实现复杂，需解析终端输出 |

### 决策
**Phase 1 采用 B（固定延迟 1s）**，**Phase 2 迁移到 C**

### 理由 (Phase 1 选 B)
1. Phase 1 目标是快速稳定，不应引入大改动
2. Claude 启动时间通常 < 1s，固定 1s 延迟足够可靠
3. 实现仅需 `setTimeout(() => write(), 1000)`

### 理由 (Phase 2 迁 C)
1. 多 CLI 启动时间差异大（Gemini 可能 3s+）
2. 固定延迟无法兼顾速度和可靠性
3. bracketed paste 防止长文本被终端转义
4. Hive 的 `post-start-input-writer.ts` 可直接参考

### 后果
- Phase 1: PersistentClaude 增加 `startupDelay` 配置项（默认 1s）
- Phase 2: 实现 `StdinWriter` 接口，策略模式切换
- 区分交互式 CLI（需等待提示符）和非交互式（直接写入）

---

## 附录：决策时间线

```
Phase 1 (痛点修复)     Phase 2 (安全+架构)    Phase 3 (可靠性)      Phase 4 (正确性)     Phase 5 (锦上添花)
──────────────       ──────────────         ─────────────          ─────────────          ──────────────
ADR-007 (输入B)      ADR-001 (node-pty)     ADR-002 (SQLite)       -                     ADR-005 (混合)
                     ADR-004 (Token)                               ADR-006 (格式化)
                     ADR-003 (状态)
```

受影响程度：

| ADR | 影响源文件 | 代码规模估算 |
|-----|-----------|-------------|
| ADR-001 (node-pty) | `agent-manager.ts` 新增, `persistent-claude.ts` 修改 | ~150 行 |
| ADR-002 (JSON→SQLite) | `agent-run-store.ts` + 接口定义 | ~200 行 |
| ADR-003 (四态模型) | `agent-runtime.ts`, `daemon-core.ts` | ~80 行 |
| ADR-004 (Token) | `agent-tokens.ts` 新增, `agent-runtime.ts` 修改 | ~50 行 |
| ADR-005 (混合) | `persistent-claude.ts` 修改 | ~100 行 |
| ADR-006 (格式化) | `agent-stdin-dispatcher.ts` 新增 | ~120 行 |
| ADR-007 (输入策略) | `agent-stdin-writer.ts` 新增 | ~150 行 |

**总计新增 + 修改：约 850 行**（对应 Hive 的 ~2000 行 agent 管理代码，约 40% 覆盖率）
