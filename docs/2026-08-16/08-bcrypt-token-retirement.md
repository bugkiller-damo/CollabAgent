# O8 · bcrypt 机器令牌兼容分支退役计划

> 日期：2026-08-16
> 状态：**待退役**（本机 dev 库实测仍有 22 个 active bcrypt 令牌，见文末）

## 1. 背景

机器令牌（`sk_machine_*`）历史上用 bcrypt 哈希落库，认证必须「全表扫描 + 逐行
`bcrypt.compare`」——O(N×100ms) 且无法走索引。`lib/token-hash.ts` 已改为 sha256 快路径
（`WHERE token_hash = $1` 唯一索引 O(1) 命中），但为了兼容历史令牌，以下两处保留了
bcrypt 兼容分支：

| 位置 | 分支内容 |
|---|---|
| `packages/server/src/index.ts`（HTTP `authenticate` 装饰器，machine token 段） | sha256 索引未命中后，`SELECT user_id, scope, token_hash FROM machine_tokens WHERE revoked_at IS NULL` 全表扫描 + 逐行 `bcrypt.compare` |
| `packages/server/src/ws/handler.ts`（WS `resolveUserId`，daemon 段） | 同上（`SELECT user_id, token_hash ...`） |

## 2. 观测手段（已落地）

- **metrics 计数器**（`GET /api/metrics` → `counters`）：
  - `machineAuthBcryptScans`：进入兼容分支的次数（= 全表扫描次数）；
  - `machineAuthBcryptHits`：兼容分支成功命中次数（= 仍在使用旧令牌的请求数）。
- **命中日志**：命中时输出 warn——
  - HTTP：`request.log.warn({ userId, scope }, "legacy bcrypt machine token used — rotate/revoke it ...")`；
  - WS：`console.warn("[WS] legacy bcrypt machine token used by user=...")`。

运营判断：`scans` 长期为 0 说明所有活跃客户端都已用 sha256 令牌；`hits > 0` 时按
日志里的 userId 找到对应 daemon 重新签发令牌（删除旧 `sk_machine_*` 重新走
`POST /api/profile/machine-token` 即可）。

## 3. 退役判定标准

**两张表 active（未吊销且未过期）的 bcrypt 令牌数均为 0**，即：

```sql
-- machine_tokens
SELECT count(*) FROM machine_tokens
 WHERE revoked_at IS NULL
   AND (expires_at IS NULL OR expires_at > now())
   AND (token_hash LIKE '$2a$%' OR token_hash LIKE '$2b$%' OR token_hash LIKE '$2y$%');

-- agent_credentials（verifyTokenHash 的 bcrypt 分流同样依赖此表状态）
SELECT count(*) FROM agent_credentials
 WHERE revoked_at IS NULL
   AND (expires_at IS NULL OR expires_at > now())
   AND (token_hash LIKE '$2a$%' OR token_hash LIKE '$2b$%' OR token_hash LIKE '$2y$%');
```

两条 SQL 都返回 0 → 可退役。

### 审计脚本

```bash
pnpm audit:bcrypt-tokens            # 或 node scripts/audit-bcrypt-tokens.mjs
```

脚本按「表 × 哈希类型 × 状态（active/expired/revoked）」统计并直接给出判定结论。

## 4. 退役步骤（判定通过后执行）

1. **删除 HTTP 兼容分支**：`index.ts` 中 machine token 段里 sha256 快路径之后的
   「兼容路径」整块（含 `machineAuthBcryptScans` 计数、bcrypt import、全表扫描循环），
   未命中直接 `401 Invalid machine token`；
2. **删除 WS 兼容分支**：`ws/handler.ts` `resolveUserId` 同样整块删除；
3. **收尾 `token-hash.ts`**：`verifyTokenHash` 的 bcrypt 分流也一并删除（`isBcryptHash`
   仅保留给审计脚本/迁移时使用，或同步删除并去掉审计脚本的 bcrypt 统计口径）；
4. **观察指标**：删除后 `machineAuthBcryptScans` 计数器不再增长（可随后从 metrics.ts
   移除该计数器）；
5. 跑 `pnpm --filter @collabagent/server test` 全量回归（ws.test 的 daemon 认证用例
   覆盖 sha256 快路径）。

## 5. 本机实测记录（2026-08-16）

`node scripts/audit-bcrypt-tokens.mjs` 输出：

```
machine_tokens    | bcrypt    | active   | 22
machine_tokens    | sha256    | active   | 11
agent_credentials | sha256    | expired  | 5
agent_credentials | sha256    | revoked  | 3
```

结论：⚠️ 未达退役条件——本机 dev 库还有 22 个 active bcrypt 机器令牌（历史数据），
需轮换/吊销后方可执行第 4 节步骤。`agent_credentials` 已全部 sha256。
