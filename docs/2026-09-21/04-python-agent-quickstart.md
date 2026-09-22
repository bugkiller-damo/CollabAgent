# Python 自建 Agent Worker 接入 Slock — 公开 Quickstart

面向想用 **Python + LangChain / LangGraph** 自建 agent worker、接入本地
Slock daemon 的开发者。worker 是你自己拥有、自己运行的本地进程；daemon 按
manifest 拉起它，经 stdin/stdout 跑 `slock.agent-runtime` v1（SARP/1）
JSONL 协议——生命周期、探测、协议校验、派发、取消、重试、MCP 路由与
crash 保护由 daemon 和 `slock-runtime` SDK 协作承担，客户只实现 Agent 业务逻辑。

## 当前发布状态（务必先读）

- `slock-runtime` 包 **尚未发布到 PyPI**：tag 触发的发布 workflow
  （`.github/workflows/python-release.yml`，trusted publishing）已就位，
  但本任务内未执行过发布。
- 当前受支持且已验证的安装路径是 **源码 / 本地 wheel**：

  ```bash
  # 源码 editable（仓库内开发）
  pip install -e "bridges/python[langgraph]"
  # 或本地构建的 wheel
  pip install "slock_runtime-0.1.0-py3-none-any.whl[langgraph]"
  ```

- CI（`.github/workflows/python-sdk.yml`）已配置但**远端尚未实际跑过**；
  本 quickstart 的兼容矩阵以本地验证为准，不声称远端 CI 已绿。

## 安装路径

支持 Python 3.10–3.13（`requires-python = ">=3.10,<3.14"`）。

| 用途 | 命令 |
|------|------|
| LangGraph worker | `pip install "slock-runtime[langgraph]"` |
| LangChain worker | `pip install "slock-runtime[langchain]"` |
| 裸协议（自定义 runtime） | `pip install slock-runtime` |

extras 内容（下界 = 本地实测过的最低版本，上界按大版本）：

- `[langgraph]`：`langgraph>=1.2.11,<2.0` + `langgraph-checkpoint-sqlite>=3.1.1,<4.0`
- `[langchain]`：`langchain>=1.4.2,<2.0` + `langchain-core>=1.6.3,<2.0`

更早的 1.x 版本未经测试，不在支持面内。

provider 包（`langchain-openai`、`langchain-anthropic` 等）与密钥由你按所选
模型自行安装/配置——**框架 ≠ provider**：SDK 只管协议桥，`init.model` 决定
运行时选哪个 provider 模型。

## 模板上手（推荐路径）

`bridges/templates/` 下有两个自包含、可直接复制的最小 worker：

```bash
cp -r bridges/templates/langgraph-agent /path/to/my-agent   # 或 langchain-agent
cd /path/to/my-agent
python -m venv .venv && . .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python agent.py --slock-probe    # 单行 probe.result，exit 0
```

模板默认 echo 节点**不需要任何 provider key** 即可跑通 initialize →
runtime.ready → turn → turn.end 全链路。注意：模板的 build factory 忽略
`init.model`——manifest `model` 选什么模型都还是 echo；要接真实模型，把
factory 换成按 `init.model` 构建 chat model 的实现（示例里有完整写法）。
更完整的示例（provider model、MCP tools、SqliteSaver durable checkpoint、
interrupt 审批门）见 `bridges/examples/langgraph-agent/` 与
`bridges/examples/langchain-agent/`。

## manifest 配置

daemon 读本机 `<daemon 进程 cwd>/.slock/runtimes.json`（`slockDir()` 默认
解析为 `process.cwd()/.slock`；`SLOCK_STATE_DIR` 可整体搬迁状态树根；
`SLOCK_RUNTIME_MANIFEST` 可直接覆盖该文件路径），`version: 1` +
`entries[]`。模板自带 `runtime.manifest.json` 样例：

```json
{
  "version": 1,
  "entries": [
    {
      "id": "my-langgraph-agent",
      "runtime": "langgraph",
      "label": "My LangGraph Agent",
      "command": "/absolute/path/to/.venv/bin/python",
      "args": ["agent.py"],
      "cwd": "/absolute/path/to/my-agent",
      "env": { "PYTHONUNBUFFERED": "1" },
      "secretEnv": ["OPENAI_API_KEY"],
      "model": { "mode": "select", "default": "openai:gpt-4o-mini",
                 "allowed": ["openai:gpt-4o-mini", "anthropic:claude-sonnet-4-5"] },
      "requireDurableThreads": false,
      "startupTimeoutMs": 15000,
      "silenceTimeoutMs": 300000,
      "shutdownTimeoutMs": 10000
    }
  ]
}
```

- `command` 必须是解释器绝对路径（或 PATH 可解析名）；禁 shell 元字符。
- `cwd` 必须绝对路径；`args` 相对 `cwd` 解析。
- `model.mode`：`fixed`（锁定 `default`）或 `select`（`allowed` 列表内可选，
  `default` 必须在列表中）。选择经 `initialize.runtime.model` 下发给 worker。
- `requireDurableThreads: true` 时握手能力 `durableThreads=false` 会拒绝
  entrypoint——LangGraph worker 需挂持久 checkpointer（如 SqliteSaver）。

**CentOS Stream 9 前置**：官方 AppStream 提供 Python 3.11 与 Node.js 20。
包尚未发布到公共 PyPI，当前受支持路径是把本地/内部 wheel 装进独立 venv：

```bash
dnf -y module install nodejs:20        # daemon 侧 Node 运行时
dnf -y install python3.11 python3.11-pip
python3.11 -m venv /opt/slock-agent-venv
/opt/slock-agent-venv/bin/python -m pip install --upgrade "pip>=24,<26"
/opt/slock-agent-venv/bin/python -m pip install "/path/to/slock_runtime-0.1.0-py3-none-any.whl[langgraph]"
```

manifest `command` 写 `/opt/slock-agent-venv/bin/python`。将来包进入内部
私有索引或 PyPI 后，只需替换安装来源（wheel 路径换索引包名），解释器契约
不变——`command` 始终指向装了 SDK 的那个解释器/venv 的绝对 python 路径。

## flags 与 secret

两侧都要显式开 bridge runtime 开关：

| 侧 | 环境变量 | 关闭时行为 |
|----|----------|-----------|
| server | `SLOCK_BRIDGE_RUNTIMES=1` | 新建 bridge agent 报 `runtime not wired` |
| daemon | `SLOCK_EXPERIMENTAL_BRIDGE_RUNTIMES=1` | 不上报 entrypoints、不注册 bridge driver；新建先被 `entrypoint_unavailable` 拦，已有 agent 派发报 `runtime-unsupported` |

**secret 三种形态**（可混用；同一变量名不能在多处声明——`entry-secret-overlap`）：

| 形态 | manifest 字段 | 值存哪 | 适用 |
|------|--------------|--------|------|
| daemon env 注入 | `secretEnv: ["OPENAI_API_KEY"]` | **daemon 启动环境**（如 `packages/daemon/.env`） | 机器主人统一供给；probe 期 `secret-env-missing` fail-fast |
| 本机 secret store | `secretRefs: ["OPENAI_API_KEY"]` | `<slockDir()>/runtime-secrets.json`（0600、逐 entrypoint 桶） | 逐 entrypoint 隔离/轮换，`slock runtime secret set <id> <NAME> <value>` 管理，改 key 不用重启 daemon |
| worker 自管 | **不声明** | worker 自己的配置文件（如 worker 目录 `.env`） | daemon 对 provider 凭据**零感知**——与 `claude login` 自管凭证同构 |

前两种形态下 daemon 只做「按名取值 → spawn 时注入 worker 进程 env」的
运送：值不经过 server、不进任何协议帧、不落 manifest/probe 摘要。
普通 `env` 字段禁止写凭据形态的名字（`*_KEY`/`*_SECRET`/`*_TOKEN` 等
会被 `entry-env-invalid` 拒）。

**worker 自管形态**适合「daemon 只与 agent 软件打交道、模型 API 关系
完全归 worker」的部署：manifest 不留任何 secret 字段，daemon probe/
spawn/协议层全程不接触凭据。worker 在握手前自读配置即可：

```python
def _load_worker_env() -> None:
    """加载 worker 本地 .env（不覆盖已存在的进程 env 键）。"""
    import os
    from pathlib import Path

    env_file = Path(__file__).resolve().parent / ".env"
    if not env_file.is_file():
        return
    for line in env_file.read_text(encoding="utf-8-sig").splitlines():  # utf-8-sig 防 BOM
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())
```

代价：probe 阶段不再对 key 做 fail-fast——缺 key 的失败推迟到回合内
provider 报错（`slock runtime doctor <id>` 的 `diagnostics.lastError`
可查）；轮换=编辑 worker 自己的配置文件。

无论哪种形态，daemon 都不直连 provider——`initialize.runtime.model`
下发的是不透明选择标识（等价于给 `claude` CLI 传 `--model`），
`provider:model` → provider client 的映射完全由 worker 解释。

## 自动 probe

`command --slock-probe` 由 SDK `WorkerRuntime.serve` 内置处理：打印**单行**
`probe.result` 帧（`probe:true` + `runtime.id` + `runtime.frameworkVersion`
+ `runtime.bridgeVersion` + `capabilities` + `model`）后 `exit(0)`——
在读 stdin、开 journal、调 `on_initialize`、建 graph/model、起 MCP 之前
返回。worker 源码**不需要**自写 probe 分支。daemon 用它做 entrypoint
可用性门禁（15s 超时，要求恰好一行）。

## 故障速查

| 现象 / 错误 | 含义 | 处置 |
|-------------|------|------|
| `runtime not wired` | server `SLOCK_BRIDGE_RUNTIMES` 未开 | server 环境变量置 1 后重启 |
| `entrypoint_unavailable` | daemon flag 未开 / manifest 无可用条目 / probe 失败 | 查 daemon flag、manifest 路径与 probe 输出 |
| `runtime-unsupported` | 已有 bridge agent 派发时 daemon driver 未注册 | daemon `SLOCK_EXPERIMENTAL_BRIDGE_RUNTIMES=1` |
| `entry-*-invalid` | manifest 条目字段非法（精确错误码按字段区分） | 按错误码定位字段：id/runtime/label/command/args/cwd/env/secretEnv/secretRefs/model/timeout/durable |
| `secret-ref-missing` | `secretRefs` 声明的名字不在本机 secret store | `slock runtime secret set <id> <NAME> <value>` 补登记 |
| 回合内 provider `Missing credentials`/401 | worker 侧 key 缺失或无效（自管形态下 probe 不预检） | `slock runtime doctor <id>` 看 `diagnostics.lastError`；确认 worker 配置文件可读、`.env` 无 BOM |
| `entry-id-duplicate` | manifest 内 id 重复 | 改唯一 id |
| probe 超时（15s） | worker 启动慢 / stdout 有非协议输出 / 卡在 import | `command --slock-probe` 手动跑，确认单行帧 + exit 0；stdout 禁日志 |
| `RUNTIME_ID_MISMATCH` | initialize.runtime.id ≠ worker `runtime_id` | manifest `runtime` 与 `serve_*` 的 `runtime_id` 对齐 |
| turn.end error `MCP_START_FAILED` | Slock MCP 子进程没起来 | 查 worker stderr；probe 阶段不启 MCP，先排除环境问题 |
| `durableThreads` 拒绝 | `requireDurableThreads=true` 但握手报 false | LangGraph compile 挂持久 checkpointer（SqliteSaver 等） |

## 信任边界

worker 是**受信任的任意本地代码**，不是沙箱：

- scoped token、env 白名单、标准 SDK 的 MCP 面只收窄平台侧暴露面，
  不构成 OS 级隔离；worker 进程本身可访问本机文件与网络。
- 正常控制面不会主动上送 command/cwd/provider secret 值；但若 worker
  自己把 secret 写进 assistant/tool 输出，平台不做绝对保证——daemon 有
  出口脱敏（`redact.ts`），仍按“可能泄漏”建模。
- stdout 协议纯净是硬约束：任何非协议帧输出都会破坏 probe/握手。

## 兼容矩阵

| 维度 | 支持面 | 验证方式 |
|------|--------|----------|
| Windows 11 x64 | CPython 3.10.21 / 3.12.14 / 3.13.15 | 本地已验证：pytest 134/134（两端点无 skip）、wheel 干净安装 + 双模板 probe/单回合冒烟、daemon `sarp-python-worker` 5/5 |
| Windows Server 2022 x64 | CPython 3.10–3.13 | 远端 CI 已验证（run `35602381617`：3.10/3.13 全量 pytest + daemon bridge） |
| Ubuntu 22.04 / 24.04 x64 | CPython 3.10–3.13 | 远端 CI 已验证（run `35602381617`：3.10/3.13 全量 pytest + daemon bridge + 3.10 最低依赖）；Linux x86_64 cp310/cp311/cp313 依赖已本地证明全为 binary wheel（43 wheel、0 sdist） |
| CentOS Stream 9 x64 | AppStream Python 3.11 + Node.js 20 | 远端 CI 已验证（`centos-stream-9` 容器 job：SDK pytest + 模板冒烟 + daemon 三件） |
| CentOS Linux 7 | — | 不支持：EOL 2024-06-30，无受支持的 Python ≥3.10 基线 |
| macOS | CPython 3.12 | 远端 CI 已验证（安装 + 双模板 probe/单回合冒烟），非主要内部目标 |
| Python 版本范围 | 3.10–3.13（`>=3.10,<3.14`） | 同上行各 OS 行 |
| Python 3.10 + 最低依赖 | 精确 `langchain==1.4.2` `langchain-core==1.6.3` `langgraph==1.2.11` `langgraph-checkpoint-sqlite==3.1.1` | ubuntu-24.04 专用 minimum-dependencies job 已在远端 run `35602381617` 通过全量 pytest |
| LangChain | `>=1.4.2,<2.0` | `[langchain]` extra + 模板/示例测试（更早 1.x 未测试不支持） |
| LangGraph | `>=1.2.11,<2.0` | `[langgraph]` extra + 模板/示例测试 |
| langgraph-checkpoint-sqlite | `>=3.1.1,<4.0` | `[langgraph]` extra |
| 协议 | SARP/1（`slock.agent-runtime` v1） | contract fixtures + daemon 集成测试 |

## 相关文档

- `bridges/python/README.md` — SDK 安装/API/稳定性分层
- `docs/2026-09-21/02-sarp1-protocol.md` — SARP/1 协议规范（权威）
- `docs/2026-09-21/01-bridge-runtime-实机测试手册.md` — 实机测试手册
- `docs/2026-09-21/03-python自建agent接入能力评估与实施计划.md` — 现状与实施计划
