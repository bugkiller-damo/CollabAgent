# langgraph-agent — Slock × LangGraph 示例 worker

设计文档 `docs/2026-09-20/02-daemon-langchain-langgraph-runtime-design.md` Phase 3
的可运行示例：真实 `CompiledStateGraph` + `SqliteSaver` durable checkpoint +
`interrupt()` 审批门 + Slock MCP tools 加载。

## 图结构

```text
START → agent → (有 tool_calls? → tools → agent) → review → END
```

- **agent**：`init_chat_model(init.model)` 绑定 Slock MCP tools；未下发
  `runtime.model` 时退化为 echo 节点（无 provider key 也能冒烟跑通图）。
- **tools**：`ToolNode` 包装的 `SlockTool` —— `initialize.platform.mcp`
  下发的 stdio MCP server（Slock 回话/读历史工具），worker 全程复用同一
  client（§12.4）。
- **review**：`interrupt({"kind":"final_approval","preview":...})` 挂起，
  daemon 把审批提示发回频道；同 conversation 的下一条用户消息作为
  `resume.value` 进来——`reject*` 撤回回复，其余放行。
- **checkpoint**：`SqliteSaver` 落 `<workspace>/.slock/langgraph-checkpoints.sqlite`，
  `configurable.thread_id = conversationId`（§11.2）——worker 重启不丢 thread。

## 接入 daemon

依赖：worker 进程的 Python 环境需要 `slock-runtime`（本仓库
`bridges/python/`）+ `langgraph` + `langgraph-checkpoint-sqlite` +
`langchain-core`（+ `langchain` 与对应 provider 包用于真实模型）：

```bash
uv pip install -e bridges/python langgraph langgraph-checkpoint-sqlite langchain-core langchain
```

把 `runtime.manifest.json` 里的 entry 合并进 `<slockDir()>/runtimes.json`
（或按 `SLOCK_RUNTIME_MANIFEST` 指到本文件），按需改 `cwd` 为实际绝对路径、
`command` 为装了依赖的解释器。

- `requireDurableThreads: true`：worker 必须用 SqliteSaver 等持久
  checkpointer，否则握手 `durableThreads=false` 会被 daemon 拒启（§11.3）。
- `secretEnv`：provider key 由 daemon 环境注入，不写进 manifest env。
- `model.mode=select`：仅 allowlist 内模型可覆盖。

## 手动冒烟（无 daemon）

```bash
cd bridges/examples/langgraph-agent
python agent.py <<'EOF'
{"protocol":"slock.agent-runtime","version":1,"type":"initialize","seq":1,"timestamp":"2026-09-20T00:00:00Z","requestId":"r1","agent":{"id":"a1","name":"demo"},"runtime":{"id":"langgraph","entrypoint":"langgraph-example"},"workspace":{"path":"<abs workspace dir>"},"platform":{},"limits":{"maxFrameBytes":1048576,"silenceTimeoutMs":300000}}
{"protocol":"slock.agent-runtime","version":1,"type":"turn.start","seq":2,"timestamp":"2026-09-20T00:00:01Z","turnId":"t1","conversationId":"conv-1","attempt":1,"source":{"kind":"channel","channel":"general"},"prompt":"hello"}
{"protocol":"slock.agent-runtime","version":1,"type":"turn.start","seq":3,"timestamp":"2026-09-20T00:00:02Z","turnId":"t2","conversationId":"conv-1","attempt":1,"source":{"kind":"channel","channel":"general"},"prompt":"approve","resume":{"interruptId":"<turn.end.interrupt.interruptId>","resumeToken":"<turn.end.interrupt.resumeToken>","value":"approve"}}
{"protocol":"slock.agent-runtime","version":1,"type":"shutdown","seq":4,"timestamp":"2026-09-20T00:00:03Z"}
EOF
```

预期：`runtime.ready`（`durableThreads:true`）→ turn1 以
`turn.end.status="interrupted"` 收尾（带 `interrupt` 三要素）→ 把其中的
`interruptId`/`resumeToken` 填进 turn2 → `turn.end.status="success"`，
`finalText` 为 echo/模型回复。再次启动进程用同一 `conversationId` 仍能看到
历史消息（checkpoint 在 workspace `.slock/` 下持久化）。

stdout 只会有协议帧；日志一律走 stderr。
