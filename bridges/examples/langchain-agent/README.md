# langchain-agent — Slock SARP/1 LangChain 示例 worker

设计文档：`docs/2026-09-20/02-daemon-langchain-langgraph-runtime-design.md` §9/§12。

最小可跑的 LangChain runtime entrypoint：daemon 经 stdin/stdout 逐行
SARP/1 帧驱动本进程；本进程把 turn 转给 `build_agent()` 产出的
LangChain agent（`langchain.agents.create_agent`），事件流经
`slock_runtime.serve_langchain` 落成 `assistant.delta` / `tool.*` /
`turn.end` 帧。

## 文件

- `agent.py` — entrypoint。`build_agent(init, tools)` 工厂在 initialize
  握手后被调用；`init.mcp` 存在时 `tools` 是 SDK 已加载的 Slock MCP
  `StructuredTool`（§12.4：tools 先于 graph 构建；单一 MCP client 复用）。
- `runtime.manifest.json` — daemon 本机 manifest 条目（§9.2 schema）。
  把 `entries[0]` 并入 `<daemon cwd>/.slock/runtimes.json`（或
  `SLOCK_RUNTIME_MANIFEST` 指向的整文件），并按需修正 `cwd` 为绝对路径、
  `command` 为本机 Python（venv 内则指向 venv 解释器）。
- `--slock-probe`：`python agent.py --slock-probe` 输出单行
  `probe.result` 帧即退出（§9.4），供 daemon entrypoint probe 使用。

## 依赖

```bash
pip install -e bridges/python        # slock_runtime SDK
pip install langchain langchain-core # 框架依赖由 worker 自己声明（SDK 零依赖）
```

## 模型与密钥

- `initialize.runtime.model`（如 `openai:gpt-4o-mini`）经
  `init_chat_model` 解析；provider 包/密钥缺失时降级为本地 demo
  runnable（不联网、不 bind_tools），管道仍可跑通。
- 用真实模型时在 manifest `secretEnv` 里声明变量名（如
  `["OPENAI_API_KEY"]`），值由 daemon 环境注入——manifest 与协议帧
  绝不出现明文 secret。

## 能力声明

`runtime.id = "langchain"`，`requireDurableThreads = false`：普通
Runnable 无 checkpoint，adapter 不虚报 `durableThreads`/`interrupts`，
`resume` 一律 PROTOCOL_VIOLATION（§12.2）。
