# LangGraph Agent Template

最小可复制的 SARP/1 LangGraph worker：零 provider key 也能跑通 initialize →
runtime.ready → turn → turn.end 全链路（默认 echo 节点不联网）。

## 使用

1. **复制本目录**到你自己的位置：

   ```bash
   cp -r langgraph-agent /path/to/my-langgraph-agent
   cd /path/to/my-langgraph-agent
   ```

2. **建虚拟环境并安装依赖**：

   ```bash
   python -m venv .venv
   # POSIX:   source .venv/bin/activate
   # Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   ```

3. **本地自检**（probe 由 SDK 内置，无需写任何分支）：

   ```bash
   python agent.py --slock-probe   # 单行 probe.result，exit 0
   ```

4. **修改 `runtime.manifest.json` 里的绝对路径**：
   - `command`：你的 venv 解释器绝对路径
     （POSIX `/path/to/venv/bin/python`；Windows `C:\\path\\to\\venv\\Scripts\\python.exe`）；
   - `cwd`：本目录的绝对路径。
   然后把该 manifest 复制/合并到 daemon 机的 `<slockDir()>/runtimes.json`。

5. **接入真实模型**（可选）：manifest `model` 改 `select` + `allowed`，
   `secretEnv` 声明 provider key 名（值留在 daemon 本机）。在 `build_graph`
   里用 `init.model` 经 `init_chat_model` 构建真实模型——框架（LangGraph）
   与 provider（OpenAI/Anthropic…）是两层，SDK 只负责协议桥。

## 更进一步

模板 `graph.compile()` 未挂持久 checkpointer，握手报 `durableThreads=false`。
durable checkpoint（SqliteSaver 落盘、进程重启可续）、`interrupt()` 审批门
+ resume token、custom progress 映射、Slock MCP tools 绑定的完整示例见
`bridges/examples/langgraph-agent/`。公开 quickstart 见
`docs/2026-09-21/04-python-agent-quickstart.md`。
