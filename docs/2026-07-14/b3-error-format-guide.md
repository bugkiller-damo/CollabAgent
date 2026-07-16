# B3: 统一错误格式指南

> 目标：消除 auth.ts 中的 `code` 字段，全 API 统一为 `{ error: string }`
> 估算：15 分钟 | 涉及 1 个文件 9 处改动

---

## 背景

`auth.ts` 的 9 处错误响应包含冗余的 `code` 字段，而其余 ~150 处路由错误只有 `error` 字段。HTTP 状态码已完全表达了 `code` 的语义，且前端不依赖 `code`。

## 改法

每个 `return reply.status(NNN).send({ code: "XXX", error: "..." })` 改为 `return reply.status(NNN).send({ error: "..." })`。

**文件：** `packages/server/src/routes/auth.ts`

| 行号 | 改前 | 改后 |
|---|---|---|
| ~58 | `{ code: "INVALID_ARG", error: "邮箱、用户名和密码为必填项" }` | `{ error: "邮箱、用户名和密码为必填项" }` |
| ~61 | `{ code: "INVALID_ARG", error: "用户名仅支持字母数字下划线" }` | `{ error: "用户名仅支持字母数字下划线" }` |
| ~64 | `{ code: "INVALID_ARG", error: pwErr }` | `{ error: pwErr }` |
| ~71 | `{ code: "CONFLICT", error: "用户名或邮箱已被注册" }` | `{ error: "用户名或邮箱已被注册" }` |
| ~116 | `{ code: "INVALID_ARG", error: "请输入用户名/邮箱和密码" }` | `{ error: "请输入用户名/邮箱和密码" }` |
| ~122 | `{ code: "RATE_LIMITED", error: "登录失败次数过多..." }` | `{ error: "登录失败次数过多..." }` |
| ~132 | `{ code: "AUTH_FAILED", error: "用户不存在" }` | `{ error: "用户不存在" }` |
| ~137 | `{ code: "ACCOUNT_DEACTIVATED", error: "该账户已注销" }` | `{ error: "该账户已注销" }` |
| ~141 | `{ code: "AUTH_FAILED", error: "密码错误" }` | `{ error: "密码错误" }` |

## 验证

```bash
cd packages/server && pnpm typecheck && pnpm test
```
