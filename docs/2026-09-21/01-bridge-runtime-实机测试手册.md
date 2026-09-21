# Bridge Runtime 实机测试手册（LangChain / LangGraph）

> 2026-09-21 实测通过的完整流程。目标链路：
> `manifest → daemon probe → ready.entrypoints → server 门禁 → agent:start → daemon spawn Python worker → SARP/1 → 频道回复`

---

## 1. 环境变量速查

### server（`packages/server`）

| 变量 | 值 | 作用 |
|------|-----|------|
| `SLOCK_BRIDGE_RUNTIMES` | `1` | **创建门禁总开关**。不设则 `POST /api/agents` 对 langchain/langgraph 一律 400 `runtime not wired` |

### daemon（`packages/daemon`）

| 变量 | 值 | 作用 |
|------|-----|------|
| `SLOCK_EXPERIMENTAL_BRIDGE_RUNTIMES` | `1` | **上报开关**。不设则 ready 不带 `entrypoints`，server 侧永远看不到本机 worker |
| `SLOCK_RUNTIME_MANIFEST` | 绝对路径 | 可选。覆盖 manifest 位置（默认 `<daemon cwd>/.slock/runtimes.json`） |
| `SLOCK_STATE_DIR` | 绝对路径 | 可选。整体搬迁 `.slock` 状态树（含 manifest 默认落点） |
| `OPENAI_API_KEY` 等 | provider key | **secretEnv 的值源**。manifest `secretEnv` 里声明的名字，从 daemon 进程 env 按名取值注入 worker——daemon 自己必须带这些变量启动 |

### daemon CLI 参数

```
pnpm exec tsx src/index.ts \
  --server-url http://localhost:3001 \
  --api-key sk_machine_<token> \
  --server "<server名>"          # 可选，仅日志可读性 + scope 一致性声明
```

- `--server-url`：直连 server 端口即可（如 `:3001`）；经 vite proxy（`:5174`）也行，但直连少一跳。
- `--api-key`：`sk_machine_` 机器令牌（server 侧 `POST /api/computers/me/token` 签发，或直接往 `machine_tokens` 表插 sha256 行）。
- `--server`：声明 token 的 scope 名；不一致会被拒连。

---

## 2. manifest：`packages/daemon/.slock/runtimes.json`

> 注意落点：daemon 以 `packages/daemon` 为 cwd 启动时，读 `packages/daemon/.slock/runtimes.json`。

```json
{
  "version": 1,
  "entries": [
    {
      "id": "langgraph-deepseek",
      "runtime": "langgraph",
      "label": "LangGraph Approval-Gate Agent (deepseek)",
      "command": "D:\\code\\slock\\bridges\\python\\.venv\\Scripts\\python.exe",
      "args": ["agent.py"],
      "cwd": "D:\\code\\slock\\bridges\\examples\\langgraph-agent",
      "env": {
        "PYTHONUNBUFFERED": "1",
        "OPENAI_BASE_URL": "https://api.deepseek.com"
      },
      "secretEnv": ["OPENAI_API_KEY"],
      "model": {
        "mode": "select",
        "default": "openai:deepseek-chat",
        "allowed": ["openai:deepseek-chat", "openai:deepseek-reasoner"]
      },
      "requireDurableThreads": true,
      "startupTimeoutMs": 30000,
      "silenceTimeoutMs": 300000,
      "shutdownTimeoutMs": 10000
    }
  ]
}
```

字段要点：

| 字段 | 说明 |
|------|------|
| `command` | **用 venv python 绝对路径**。写 `"python"` 会命中系统 Python（没装 langgraph → probe `command-not-found` 或协议失败） |
| `env` | 明文非 secret 配置。DeepSeek 走 OpenAI 兼容端点：`OPENAI_BASE_URL=https://api.deepseek.com` |
| `secretEnv` | **只声明名字**。值从 daemon 进程 env 取；任何一个名字在 daemon env 缺失 → probe `secret-env-missing` 拒建 |
| `model.mode` | `fixed` = 锁死 default（API 传别的 model → 400 `model_fixed`）；`select` = 限 `allowed` 名单（不在名单 → 400 `model_not_allowed`） |
| `model.default` / `allowed` | `init_chat_model` 的 `<provider>:<model>` 格式。DeepSeek = `openai:deepseek-chat` / `openai:deepseek-reasoner` |
| `requireDurableThreads` | langgraph 必须 `true`（有 SqliteSaver checkpoint）；langchain 示例为 `false` |

---

## 3. 启动顺序

```powershell
# 1) server（先起，daemon 要连）
cd packages/server
$env:SLOCK_BRIDGE_RUNTIMES='1'
pnpm exec tsx src/index.ts

# 2) daemon（带 flag + provider key）
cd packages/daemon
$env:SLOCK_EXPERIMENTAL_BRIDGE_RUNTIMES='1'
$env:OPENAI_API_KEY='sk-...'          # secretEnv 声明的 key
pnpm exec tsx src/index.ts --server-url http://localhost:3001 --api-key "sk_machine_<token>" --server 001
```

> **单实例守卫**：新 daemon 启动会 taskkill `.slock/daemon.pid` 里的旧实例。若用 `pnpm dev`（supervisor watch）跑，旧树会重生无 flag 的 daemon 互相抢连接——测试时用 `tsx src/index.ts` 直跑，或确保 supervisor 那套命令也带齐 flag/env。

---

## 4. 验证路径（每步都有 API 可查）

```powershell
$H = @{ Authorization = 'Bearer sk_machine_<token>'; 'x-server-id' = '<serverId>' }

# ① entrypoints 上报了吗（status 应为 installed / installed_unsupported）
Invoke-RestMethod -Headers $H "http://localhost:3001/api/computers?serverId=<serverId>"

# ② 创建 agent（三要素：runtime + entrypoint + model）
Invoke-RestMethod -Method Post -Headers ($H + @{'Content-Type'='application/json'}) `
  -Body (@{ name='lg-deepseek'; displayName='LG'; serverId='<serverId>';
            computerId='<computerId>'; runtime='langgraph';
            entrypoint='langgraph-deepseek'; model='openai:deepseek-chat' } | ConvertTo-Json) `
  "http://localhost:3001/api/agents"

# ③ DM 触发回合（target 格式 dm:@<agentName>；agent 会被 dmAgentRecipients 唤醒）
#    PowerShell 注意：中文必须 UTF-8 编码 body，否则变 ???
$body = [Text.Encoding]::UTF8.GetBytes((@{ target='dm:@lg-deepseek'; content='你好' } | ConvertTo-Json))
Invoke-RestMethod -Method Post -Headers ($H + @{'Content-Type'='application/json; charset=utf-8'}) `
  -Body $body "http://localhost:3001/api/messages/send"

# ④ 读回频道历史
Invoke-RestMethod -Headers $H "http://localhost:3001/api/messages/history?channel=dm:<channelId>&limit=20"
```

LangGraph 示例的审批门：每个回合 `review` 节点 `interrupt()` 挂起 → daemon 回 `approve`/`reject` 开头的下一条消息即 resume。

---

## 5. 常见失败速查

| 现象 | 原因 |
|------|------|
| `entrypoints: []` | daemon 没带 `SLOCK_EXPERIMENTAL_BRIDGE_RUNTIMES=1`（key 不出现=没开 flag；空数组=开了但 manifest 空/全失败） |
| `entrypoint_not_ready: secret-env-missing` | `secretEnv` 声明的名字不在 daemon 进程 env 里 |
| `entrypoint_not_ready: command-not-found` | `command` 写 `python` 但 PATH 里没有/指向错解释器——改 venv 绝对路径 |
| `entrypoint_not_ready: probe-failed` | worker 的 `--slock-probe` 分支缺失或超时（15s 上限）；手动跑 `<command> <args> --slock-probe` 应输出单行 JSON 后退出 0 |
| `runtime not wired` (400) | server 没带 `SLOCK_BRIDGE_RUNTIMES=1` |
| `entrypoint_unavailable` (400) | entrypoint id 不属于该 computer 的 live meta（跨机/离线/旧 daemon） |
| 回合无响应 | daemon 日志看 `[JsonlWorker]` stderr；worker stdout 必须纯 JSONL（print 全走 stderr） |

## 6. 已实测的事实（2026-09-21）

- DeepSeek：`langchain-openai` 1.6.2 + `OPENAI_BASE_URL=https://api.deepseek.com`，模型 `deepseek-chat`/`deepseek-reasoner` 可用。
- venv：`bridges/python/.venv`（uv 建的，无 pip——装包用 `uv pip install --python .venv/Scripts/python.exe <pkg>`）。
- worker 持久跨回合；杀进程后下条消息自动 respawn（dispatch 850ms 重试），SqliteSaver checkpoint 在 `<workspace>/.slock/langgraph-checkpoints.sqlite`，thread 上下文不丢。
- 审批 prompt 目前以 progress 消息短暂出现后被删——频道里**没有**持久的「待审批」提示，UX 改进项。
