# Server 端优化路线图 — 基于评分卡

> 日期：2026-07-15 | 基于 `server-review-scorecard.md`（综合评分 7.00/10）

---

## 路线图概览

| 阶段 | 目标 | 评分目标 | 估算 |
|---|---|---|---|
| **Phase A — 止血** | 修复 CRITICAL + HIGH 问题 | 7.00→7.80 | 1 天 |
| **Phase B — 提质** | 消灭 `as any` + API 一致性 | 7.80→8.50 | 2-3 天 |
| **Phase C — 精进** | 性能 + 测试死角 + 可观测性 | 8.50→9.00+ | 2-3 天 |

---

## Phase A — 止血（CRITICAL + HIGH）

| # | 任务 | 等级 | 说明 |
|---|---|---|---|
| A1 | **dev-token 后门加 NODE_ENV 保护** | 🔴 CRITICAL | 生产环境拒绝 `Bearer dev-token` |
| A2 | **CORS 白名单** | 🟠 HIGH | `origin: true`→环境变量配置 |
| A3 | **消除死依赖** | 🟠 HIGH | 移除 ioredis/nanoid/zod/drizzle 未用包 |
| A4 | **补充 WS/Agent/通知测试** | 🟠 HIGH | 核心逻辑零覆盖 |
| A5 | **修复 hasMore 逻辑** | 🟡 MEDIUM | `GET /messages` 的 hasMore 始终 false |

## Phase B — 提质（MEDIUM 项）

| # | 任务 | 说明 |
|---|---|---|
| B1 | **消灭 186 处 `as any`** | 类型声明增强，最大质量杠杆 |
| B2 | **精简 index.ts（366→200 行）** | 抽 metrics/daemon-status/users 路由 |
| B3 | **统一错误格式** | 统一 `{ error, code? }` |
| B4 | **消除 validatePassword 重复** | auth.ts + profile.ts → lib/ |
| B5 | **console.log → Fastify logger** | 全局替换 |

## Phase C — 精进

| # | 任务 | 说明 |
|---|---|---|
| C1 | **N+1 查询优化** | messages.send 中 server+agents+通知循环 |
| C2 | **Redis 缓存层** | 多实例替换内存缓存 |
| C3 | **API 版本化** | `/v1/` 前缀 |
| C4 | **Metrics 持久化** | 重启不丢失计数器 |

---

## 建议执行顺序

```
Day 1:  A1 + A2 + A3（半天移除所有 🚨 标记）
Day 2:  A4（补 WS/Agent 测试）
Day 3-4: B1（as any 歼灭战，最大质量回报）
Day 5:  B2 + B5（index.ts + 日志）
Next:   B3 + B4 + C1 + C2（一致性 + 性能）
```

## 目标指标

| 指标 | 当前 | Phase A | Phase B | Phase C |
|---|---|---|---|---|
| 综合评分 | 7.00 | 7.80 | 8.50 | 9.00+ |
| `as any` 数量 | 186 | 186 | **0** | 0 |
| `index.ts` 行数 | 366 | 366 | **≤200** | ≤200 |
| 测试总数 | 86 | **+15** | **+30** | **+50** |
| CRITICAL 问题 | 1 | **0** | 0 | 0 |

---

## 关联文档

- [`server-review-scorecard.md`](server-review-scorecard.md) — 完整评分卡
