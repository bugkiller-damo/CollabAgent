"""LangGraph 图路径执行循环（§12.3）；入口/握手内核在 agent.py（WP8 §8.1）。

`serve_langgraph` 是 `serve_agent` 的 stable 别名（强制图路径）——签名、
语义不变：CompiledStateGraph 实例或 `factory(init, tools)` 工厂均可，
握手/runtime.id 比对/workspace_cwd/工具构建由共享内核承担，本模块只留
图路径的判定与执行循环。

职责（§12.3）：
- conversationId → configurable.thread_id（§11.2），slock_turn_id 进
  configurable 做幂等审计，不替代 thread ID；
- input_mapper 把 Slock turn 转为 graph 输入；默认 {"messages":[HumanMessage]}，
  init.system_prompt 存在且 thread 为空（get_state().values 为空）时前置
  SystemMessage（§12.5；system_prompt_mode="none" 时完全不注入）；
- stream_mode=["messages","updates","custom"] 三路事件：
  messages → assistant.delta（仅 ai 类 chunk；ToolMessage 不进文本流）；
  updates → tool.start/tool.end（AIMessage.tool_calls / ToolMessage）与
  __interrupt__ 检测；custom → 仅 custom_event_mapper 显式放行的
  progress（§12.3.4，不把私有事件透出）；Slock MCP 工具标为
  provider=slock、operation=metadata.operation（metadata 缺席按名兜底），
  其余 provider=langgraph；
- interrupt() → InterruptRecord + TurnOutcome(interrupted)；resume token
  签发/单次消耗由 runtime journal 兜底（§11.4），adapter 不碰；
- §9.1 默认 interrupt 渲染（用户提供 interrupt_mapper 时以用户为准）：
  str 原样；LangChain HITLRequest（dict 含 action_requests 列表）→
  可读中文提示 + options（decisions=各 allowed_decisions 交集、
  actions=name/args/description 预览）；dict 含字符串键
  prompt/question/message → 取该值；其余 → json.dumps 截断；
- turn.resume → Command(resume=resume_mapper(init, turn, interrupt_value)
  ——用户提供 resume_mapper 时以用户为准；缺省走 §9.2 默认归约：
  HITLRequest → {"decisions":[...]}（结构化 decision 映射，或文本归类
  ——批准词 approve、其余一律 reject/respond，歧义输入不执行被拦截
  动作）；非 HITL → decision dict 透传，无 decision 时 value 原文；
- graph.checkpointer 决定 durableThreads：InMemorySaver/MemorySaver/None
  → false，其余（SqliteSaver/Postgres…）→ true（§11.3）；
- §8.3 执行模式：auto 按 checkpointer 类名 Async* / async-only 节点判定；
  sync 走 graph.stream/invoke（SqliteSaver 不支持异步），async 经内核
  常驻事件循环跑 astream/ainvoke + aget_state/aupdate_state；
- §8.4：默认 input mapper 时握手期校验图输入 schema 含 "messages" 键
  （check_default_input_schema），取不到 schema 则跳过。

纪律：
- 模块零框架依赖——所有 langgraph/langchain 导入都在函数体内惰性进行，
  `import slock_runtime.langgraph` 在未装框架时也必须可用；
- 不完整 graph state / checkpoint blob / secret 永远不进协议帧；
  tool output 截断 ~4000 字符；stdout 只写协议帧。
"""

from __future__ import annotations

import asyncio
import inspect
import json
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .errors import GRAPH_INPUT_INVALID, INTERRUPT_NOT_FOUND, SarpError
from .protocol import (
    INTERRUPT_DECISION_KINDS,
    SarpInitialize,
    SarpInterruptOptions,
    SarpResumeDecision,
    SarpTurnStart,
    parse_interrupt_options,
)
from .runtime import InterruptRecord, RunTurn, TurnEmit, TurnOutcome, new_resume_token
from .tool_events import tool_provider_fields

TOOL_OUTPUT_MAX_CHARS = 4000  # §20.5：超大 tool output 截断
_STREAM_MODES = ["messages", "updates", "custom"]
# 进程内 checkpointer 类名——命中即 durableThreads=False（§11.3）
_VOLATILE_CHECKPOINTERS = ("InMemorySaver", "MemorySaver")


@dataclass(frozen=True)
class SlockTool:
    """Slock MCP 工具的旧式运行时视图（§12.4）——兼容保留。

    WP8 起工厂拿到的是 `slock_runtime.SlockStructuredTool`（StructuredTool
    子类）：`.name`/`.description`/`.input_schema`/`.invoke(dict)` 兼容面
    一致，另有 `call(args)`、`metadata={"slock": True, "operation": name}`。
    """

    name: str
    description: str
    input_schema: dict
    call: Callable[[dict], str]

    def invoke(self, arguments: dict | None = None) -> str:
        return self.call(dict(arguments or {}))


# ---------------------------------------------------------------------------
# 默认 mapper
# ---------------------------------------------------------------------------


def _flatten_content(content: Any) -> str:
    """message.content → 纯文本。str 直返；list-of-blocks 拼 text 块。"""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                if block.get("type") in (None, "text"):
                    t = block.get("text")
                    if isinstance(t, str):
                        parts.append(t)
            else:
                t = getattr(block, "text", None)
                if isinstance(t, str):
                    parts.append(t)
        return "".join(parts)
    return str(content)


def checkpoint_thread_id(init: SarpInitialize, conversation_id: str) -> str:
    """Phase 5 §11.2：thread_id 按 worker 身份命名空间隔离。

    entrypoint/model/manifest revision 任一分量变化 → 新命名空间 →
    不复用旧 checkpoint thread；entrypoint 已唯一标识 worker——DEC-10 起
    不再含 runtime.id 分量（旧 5 段 thread 一次性废弃）。身份不变时
    conversation_id 保住会话连续性。前缀分量做分隔符清洗，保证结果仍是
    合法 thread_id 且不会跨命名空间碰撞。
    """
    parts = [
        init.entrypoint,
        init.revision or "-",
        init.model or "-",
        conversation_id,
    ]
    cleaned = ["".join(c if (c.isalnum() or c in "._-") else "_" for c in p) for p in parts]
    return ":".join(cleaned)


def _default_input_mapper(
    init: SarpInitialize, turn: SarpTurnStart, fresh: bool, system_prompt_mode: str = "prepend"
) -> dict:
    """§12.3.2：HumanMessage(turn.prompt)；thread 全新且有平台 prompt 时前置
    SystemMessage（§12.5）。system_prompt_mode="none" 完全不注入（§8.5）。"""
    from langchain_core.messages import HumanMessage, SystemMessage  # 惰性导入

    msgs: list = []
    if system_prompt_mode == "prepend" and init.system_prompt and fresh:
        msgs.append(SystemMessage(content=init.system_prompt))
    msgs.append(HumanMessage(content=turn.prompt))
    return {"messages": msgs}


def _default_output_mapper(values: Any) -> str:
    """终态 state.values → finalText：取最后一条 message 的 content 拍平。"""
    if not isinstance(values, dict):
        return ""
    msgs = values.get("messages")
    if isinstance(msgs, (list, tuple)) and msgs:
        return _flatten_content(getattr(msgs[-1], "content", msgs[-1]))
    return ""


def _truncate(text: Any, limit: int = TOOL_OUTPUT_MAX_CHARS) -> str:
    s = text if isinstance(text, str) else _flatten_content(text)
    if not isinstance(s, str):
        try:
            s = json.dumps(s, ensure_ascii=False, default=str)
        except Exception:
            s = str(s)
    return s if len(s) <= limit else s[:limit] + f"…[truncated {len(s) - limit} chars]"


def _msg_kind(msg: Any) -> str:
    """消息归类：真 langchain 消息看 .type（"ai"/"tool"/"human"/…），
    鸭子类型对象退回类名小写——测试里的 fake message 也能走同一套逻辑。"""
    t = getattr(msg, "type", None)
    if isinstance(t, str) and t:
        return t
    return type(msg).__name__.lower()


def _is_ai_kind(kind: str) -> bool:
    return kind in ("ai", "aimessage", "aimessagechunk")


def _is_tool_kind(kind: str) -> bool:
    return kind in ("tool", "toolmessage", "toolmessagechunk")


def _jsonable(v: Any) -> bool:
    try:
        json.dumps(v)
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# §9.1 interrupt 默认渲染 + §9.2 resume 默认归约
#
# LangChain `HumanInTheLoopMiddleware` 以 interrupt(HITLRequest) 挂起：
#   {"action_requests": [{"name","args","description"?}…],
#    "review_configs":  [{"action_name","allowed_decisions"…}…]}
# 恢复值必须是 {"decisions": [Decision…]}——决定数与 action_requests 数
# 一致（middleware 校验，human_in_the_loop.py:483-489）。D11：此前
# Command(resume=<文本>) 撞 `interrupt(...)["decisions"]` 直接崩、
# resume token 已被 journal 消耗、审批作废——默认归约兜住这条路径。
# ---------------------------------------------------------------------------


def _hitl_request(value: Any) -> dict | None:
    """LangChain HITLRequest 判定：dict 且含 action_requests 列表。"""
    if isinstance(value, dict) and isinstance(value.get("action_requests"), list):
        return value
    return None


def _hitl_allowed_decisions(request: dict) -> list[str]:
    """各 review_configs[].allowed_decisions 的交集（只收已知决定枚举、
    排序输出保证帧形状确定）；取不到/交集为空 → []（调用方省略 decisions）。

    review_configs 缺失或条目畸形 → 该条按空集计——宁可不渲染审批按钮，
    也不放行不能确认被允许的决定。"""
    configs = request.get("review_configs")
    if not isinstance(configs, list) or not configs:
        return []
    acc: set[str] | None = None
    for cfg in configs:
        allowed = cfg.get("allowed_decisions") if isinstance(cfg, dict) else None
        kinds = (
            {d for d in allowed if isinstance(d, str) and d in INTERRUPT_DECISION_KINDS}
            if isinstance(allowed, list)
            else set()
        )
        acc = kinds if acc is None else acc & kinds
    return sorted(acc) if acc else []


def _hitl_actions(request: dict) -> list[dict]:
    """action_requests → options.actions 预览条目（name 必填，args/
    description 可选）——产出 dirty dict 由 parse_interrupt_options 归一。"""
    actions: list[dict] = []
    for a in request.get("action_requests") or []:
        if not isinstance(a, dict):
            continue
        name = a.get("name")
        if not isinstance(name, str) or not name:
            continue
        item: dict[str, Any] = {"name": name}
        args = a.get("args")
        # 协议帧纪律：args 必须 JSON 可序列化——否则整帧 dumps 失败、
        # 回合 handler 中途死亡（与 payload 的 _jsonable 判定同口径）
        if args is not None and _jsonable(args):
            item["args"] = args
        desc = a.get("description")
        if isinstance(desc, str) and desc:
            item["description"] = desc
        actions.append(item)
    return actions


def _short_arg(v: Any, limit: int = 60) -> str:
    """审批提示里的单个参数值：str 原样，其余 json；超长截断。"""
    if isinstance(v, str):
        s = v
    else:
        try:
            s = json.dumps(v, ensure_ascii=False, default=str)
        except Exception:
            s = str(v)
    return s if len(s) <= limit else s[:limit] + "…"


_HITL_DECISION_LABELS = {"approve": "批准", "reject": "拒绝", "respond": "回复", "edit": "修改"}


def _hitl_prompt(request: dict) -> str:
    """HITLRequest → 可读中文提示（§9.1）：
    需要审批：调用 send_email（to=…, body=…）。可选：批准 / 拒绝 / 回复 / 修改"""
    parts: list[str] = []
    for a in request.get("action_requests") or []:
        if not isinstance(a, dict):
            continue
        name = a.get("name") if isinstance(a.get("name"), str) else "?"
        args = a.get("args")
        arg_s = ""
        if isinstance(args, dict) and args:
            inner = ", ".join(f"{k}={_short_arg(v)}" for k, v in args.items())
            arg_s = f"（{inner}）"
        parts.append(f"调用 {name}{arg_s}")
    suffix = ""
    decisions = _hitl_allowed_decisions(request)
    if decisions:
        suffix = "。可选：" + " / ".join(_HITL_DECISION_LABELS.get(d, d) for d in decisions)
    body = "；".join(parts)
    return _truncate(f"需要审批：{body}{suffix}" if body else f"需要审批{suffix}")


def _default_interrupt_render(value: Any) -> tuple[str, SarpInterruptOptions | None]:
    """§9.1 默认 interrupt 渲染 → (prompt, options)。

    options 经 parse_interrupt_options 归一（decisions 过滤枚举、
    actions ≤10 条、name 必填）——与 daemon 侧过滤口径一致。"""
    if isinstance(value, str):
        return value, None
    hitl = _hitl_request(value)
    if hitl is not None:
        options = parse_interrupt_options(
            {"decisions": _hitl_allowed_decisions(hitl), "actions": _hitl_actions(hitl)}
        )
        return _hitl_prompt(hitl), options
    if isinstance(value, dict):
        for key in ("prompt", "question", "message"):
            v = value.get(key)
            if isinstance(v, str):
                return v, None
    try:
        s = json.dumps(value, ensure_ascii=False, default=str)
    except Exception:
        s = str(value)
    return _truncate(s), None


# 文本 resume 的批准词表（§9.2）：剥首尾空白/标点后大小写不敏感精确命中
_APPROVE_WORDS = frozenset({"批准", "同意", "可以", "确认", "approve", "yes", "ok", "lgtm"})
_APPROVE_STRIP_CHARS = " \t\r\n。！？!?.,，、；;：:…~～-—_*\"'“”‘’`（）()[]【】{}<>《》"


def _is_approval_text(text: str) -> bool:
    """剥首尾空白与标点（内部内容不动）后命中批准词表。"""
    t = text.strip(_APPROVE_STRIP_CHARS).strip().lower()
    return t in _APPROVE_WORDS


def _decision_wire(decision: SarpResumeDecision) -> dict:
    """非 HITL interrupt 的 decision 透传（中立形状 → dict，None 键省略）。"""
    out: dict[str, Any] = {"type": decision.type}
    if decision.message is not None:
        out["message"] = decision.message
    if decision.args is not None:
        out["args"] = decision.args
    return out


def _hitl_decision_for_action(decision: SarpResumeDecision, action: Any, fallback_message: str) -> dict:
    """SarpResumeDecision → HITL Decision dict（§9.2；edit 按该 action 的
    名字展开 edited_action——同名换参语义，中间件按名查可用工具）。"""
    dtype = decision.type
    if dtype == "approve":
        return {"type": "approve"}
    if dtype == "reject":
        out: dict[str, Any] = {"type": "reject"}
        if decision.message is not None:
            out["message"] = decision.message
        return out
    if dtype == "respond":
        # message 必填——缺省退回 resume.value（用户回复原文），不崩回合
        msg = decision.message if isinstance(decision.message, str) else fallback_message
        return {"type": "respond", "message": msg}
    if dtype == "edit":
        name = action.get("name") if isinstance(action, dict) else None
        return {
            "type": "edit",
            "edited_action": {"name": name if isinstance(name, str) else "", "args": decision.args},
        }
    # R-UF 前向兼容：未知决定类型原样下传，中间件报「Unexpected human
    # decision」清晰错误——默认映射不擅自归类
    out = {"type": dtype}
    if decision.message is not None:
        out["message"] = decision.message
    return out


def _hitl_text_decision(text: str, request: dict) -> dict:
    """纯文本 resume → HITL 决定（§9.2）：批准词 → approve；**其余一律
    reject**（歧义输入不得执行被拦截动作），message=原文。reject 不在
    allowed_decisions → 退 respond；仍不允许 → GRAPH_INPUT_INVALID。"""
    if _is_approval_text(text):
        return {"type": "approve"}
    allowed = set(_hitl_allowed_decisions(request))
    if "reject" in allowed:
        return {"type": "reject", "message": text}
    if "respond" in allowed:
        return {"type": "respond", "message": text}
    raise SarpError(
        GRAPH_INPUT_INVALID,
        f"resume text {text!r} cannot be mapped to an allowed HITL decision "
        f"(allowed: {sorted(allowed)})",
        retryable=False,
    )


def _hitl_resume(turn: SarpTurnStart, request: dict) -> dict:
    """HITLRequest → {"decisions": […]}——按 action_requests 数量复制
    （中间件要求决定数与挂起 tool_call 数一致）。"""
    actions = list(request.get("action_requests") or [])
    resume = turn.resume
    if resume is not None and resume.decision is not None:
        d = resume.decision
        decisions = [_hitl_decision_for_action(d, a, resume.value) for a in actions]
    else:
        text = resume.value if resume is not None else ""
        decisions = [_hitl_text_decision(text, request) for _ in actions]
    return {"decisions": decisions}


def _default_resume_value(turn: SarpTurnStart, interrupt_value: Any) -> Any:
    """§9.2 默认 resume 归约（resume_mapper 缺省时）。

    - HITLRequest → {"decisions":[…]}（decision 结构化映射 / 文本归类）；
    - 非 HITL：decision 出席 → decision dict 透传；否则 value 原文（现状语义）。

    已知限制（§9.2）：resume token 在 runtime.py:_spawn_turn 先于映射被
    消耗——默认映射只抛明确的 SarpError（GRAPH_INPUT_INVALID），绝不
    意外崩溃或模糊放行被拦截动作；校验前移到消费之前留作后续。"""
    hitl = _hitl_request(interrupt_value)
    if hitl is not None:
        return _hitl_resume(turn, hitl)
    resume = turn.resume
    if resume is not None and resume.decision is not None:
        return _decision_wire(resume.decision)
    return resume.value if resume is not None else None


# ---------------------------------------------------------------------------
# 内核面向的判定 / 上报（agent.py 握手期调用）
# ---------------------------------------------------------------------------


def detect_version() -> str | None:
    try:
        import importlib.metadata

        return f"langgraph {importlib.metadata.version('langgraph')}"
    except Exception:
        return None


def probe_capabilities(streaming: bool) -> dict:
    """probe 期静态能力面——握手期 on_initialize overrides 仍是权威。"""
    return {
        "streamingText": bool(streaming),
        "toolEvents": True,
        "durableThreads": True,
        "interrupts": True,
        "mcp": True,
        "usage": "tokens",
    }


def handshake_fields(init: SarpInitialize, graph: Any, *, streaming: bool, has_mcp: bool) -> dict:
    """握手 ready 的 capabilities/model overrides——语义与旧 on_initialize 一致。"""
    # durableThreads：持久 checkpointer 才算（§11.3）
    cp = getattr(graph, "checkpointer", None)
    durable = cp is not None and type(cp).__name__ not in _VOLATILE_CHECKPOINTERS

    model_field: dict = {"overrides": bool(init.model)}
    if init.model:
        model_field["selected"] = init.model
    return {
        "capabilities": {
            "persistentProcess": True,
            "maxConcurrency": 1,
            "streamingText": bool(streaming),
            "toolEvents": True,
            "interrupts": True,
            "durableThreads": durable,
            "mcp": has_mcp,
            "usage": "tokens",
        },
        "model": model_field,
    }


def check_default_input_schema(graph: Any) -> None:
    """§8.4：默认 input mapper 产出 {"messages":[...]}——图输入 schema 必须含
    "messages" 键（graph.get_input_jsonschema()["properties"]）。

    schema 取不到（非 Pregel / 版本不支持 / 抛错）→ 跳过检查；
    取到且缺 "messages" → GRAPH_INPUT_INVALID，握手失败（替代 D2b 运行期
    WORKER_ERROR 'question'）。
    """
    get_schema = getattr(graph, "get_input_jsonschema", None)
    if get_schema is None:
        return
    try:
        schema = get_schema()
    except Exception:
        return
    props = schema.get("properties") if isinstance(schema, dict) else None
    if not isinstance(props, dict):
        return
    if "messages" not in props:
        raise SarpError(
            GRAPH_INPUT_INVALID,
            "graph state has no 'messages' key; pass input_mapper/output_mapper",
            retryable=False,
        )


def _has_async_node(graph: Any, _depth: int = 0) -> bool:
    """best-effort 检测 async-only 节点（§8.3）。

    PregelNode.bound 是 RunnableCallable：sync 节点 func 必填（afunc 由
    func 包出），async 节点只有 afunc。嵌套子图递归一层层看；鸭子类型
    图无 .nodes → False（保持 sync）。
    """
    if _depth > 4:
        return False
    nodes = getattr(graph, "nodes", None)
    if not isinstance(nodes, dict):
        return False
    for node in nodes.values():
        bound = getattr(node, "bound", node)
        if bound is None:
            continue
        if getattr(bound, "afunc", None) is not None and getattr(bound, "func", None) is None:
            return True
        if getattr(bound, "afunc", None) is None and inspect.iscoroutinefunction(bound):
            return True
        inner = getattr(bound, "nodes", None)
        if isinstance(inner, dict) and _has_async_node(bound, _depth + 1):
            return True
    return False


def resolve_execution(graph: Any, execution: str) -> str:
    """§8.3：sync/async 强制模式直返；auto → checkpointer 类名 Async* 开头
    或检测到 async-only 节点 → async，否则 sync（SqliteSaver 保持可用）。"""
    if execution in ("sync", "async"):
        return execution
    cp = getattr(graph, "checkpointer", None)
    if cp is not None and type(cp).__name__.startswith("Async"):
        return "async"
    if _has_async_node(graph):
        return "async"
    return "sync"


# ---------------------------------------------------------------------------
# graph state 访问（sync / async 两族——async 版挂在常驻事件循环上）
# ---------------------------------------------------------------------------


def _get_state_safe(graph: Any, config: dict):
    """get_state 缺失/失败 → None（调用方按「无历史」兜底）。"""
    get_state = getattr(graph, "get_state", None)
    if get_state is None:
        return None
    try:
        return get_state(config)
    except Exception:
        return None


async def _aget_state_safe(graph: Any, config: dict):
    aget_state = getattr(graph, "aget_state", None)
    if aget_state is None:
        return None
    try:
        return await aget_state(config)
    except Exception:
        return None


def _thread_fresh(graph: Any, config: dict) -> bool:
    """thread 是否无 checkpoint 历史。get_state 不可用/失败按 fresh 处理。"""
    snap = _get_state_safe(graph, config)
    if snap is None:
        return True
    return not getattr(snap, "values", None)


async def _athread_fresh(graph: Any, config: dict) -> bool:
    snap = await _aget_state_safe(graph, config)
    if snap is None:
        return True
    return not getattr(snap, "values", None)


def _first_interrupt_value(snap: Any) -> Any:
    """当前 thread 首个 pending interrupt 的 value——resume_mapper 第 3 参
    （§9.2 前瞻）；取不到 → None。"""
    for task in getattr(snap, "tasks", None) or ():
        for intr in getattr(task, "interrupts", None) or ():
            return getattr(intr, "value", intr)
    return None


def _dangling_repair_ops(messages: list) -> list:
    """悬空 tool_call / 孤儿 ToolMessage 的修补 ops——纯函数，sync/async 共用。

    回合中途死亡（崩溃/error/杀进程）会把『带 tool_calls 的 AI 消息』落进
    checkpoint 而对应 ToolMessage 未写——下个回合 provider 400 拒收整个
    messages（assistant tool_calls must be followed by tool messages）。

    provider 要求 tool 应答**紧跟** AI 消息之后——尾部追加无效（实机验证：
    悬空 AI 在历史中段时 append 的 ToolMessage 不构成合法应答，自身还成
    孤儿）。修法：add_messages 按 id upsert，把悬空 AI 原位替换为只保留
    『已被紧邻 tool 块应答』的 tool_calls 的同 id 副本；游离 ToolMessage
    （无紧邻上游 AI tool_calls 认领，含旧版尾部补丁残留）一并 RemoveMessage。
    """
    def _tid(tc: Any) -> str | None:
        t = tc.get("id") if isinstance(tc, dict) else getattr(tc, "id", None)
        return str(t) if t else None

    patches: list = []
    n = len(messages)
    i = 0
    while i < n:
        m = messages[i]
        kind = _msg_kind(m)
        if _is_ai_kind(kind) and (getattr(m, "tool_calls", None) or getattr(m, "invalid_tool_calls", None)):
            # 紧邻其后的连续 tool 块才算合法应答（provider 语义）
            j = i + 1
            block: list = []
            while j < n and _is_tool_kind(_msg_kind(messages[j])):
                block.append(messages[j])
                j += 1
            block_ids = {getattr(t, "tool_call_id", None) for t in block}
            tcs = list(getattr(m, "tool_calls", None) or ())
            ics = list(getattr(m, "invalid_tool_calls", None) or ())
            keep = [tc for tc in tcs if _tid(tc) in block_ids]
            keep_i = [tc for tc in ics if _tid(tc) in block_ids]
            if len(keep) != len(tcs) or len(keep_i) != len(ics):
                mid = getattr(m, "id", None)
                try:
                    patches.append(
                        m.model_copy(update={"tool_calls": keep, "invalid_tool_calls": keep_i})
                        if mid
                        else ("remove", mid)
                    )
                except AttributeError:
                    if mid:
                        patches.append(("remove", mid))  # 改不了就整条删——AI 无 tool_calls 仍合法
            # block 里不属于本 AI 调用集的 tool 消息是孤儿
            call_ids = {_tid(tc) for tc in tcs} | {_tid(tc) for tc in ics}
            for t in block:
                if getattr(t, "tool_call_id", None) not in call_ids:
                    patches.append(("remove", getattr(t, "id", None)))
            i = j
        elif _is_tool_kind(kind):
            # 不在任何 AI tool_calls 紧邻块内的 tool 消息 → 孤儿
            patches.append(("remove", getattr(m, "id", None)))
            i += 1
        else:
            i += 1

    if not patches:
        return []
    from langchain_core.messages import RemoveMessage  # 惰性导入

    return [RemoveMessage(id=p[1]) if isinstance(p, tuple) and p[1] else p for p in patches]


def _snap_messages(snap: Any) -> list:
    values = getattr(snap, "values", None)
    return list(values.get("messages") or []) if isinstance(values, dict) else []


def _repair_dangling_tool_calls(graph: Any, config: dict) -> int:
    """返回改动消息数；细节见 _dangling_repair_ops。"""
    update_state = getattr(graph, "update_state", None)
    snap = _get_state_safe(graph, config)
    if update_state is None or snap is None:
        return 0
    messages = _snap_messages(snap)
    if not messages:
        return 0
    ops = _dangling_repair_ops(messages)
    if not ops:
        return 0
    update_state(config, {"messages": ops})
    return len(ops)


async def _arepair_dangling_tool_calls(graph: Any, config: dict) -> int:
    aupdate_state = getattr(graph, "aupdate_state", None)
    snap = await _aget_state_safe(graph, config)
    if aupdate_state is None or snap is None:
        return 0
    messages = _snap_messages(snap)
    if not messages:
        return 0
    ops = _dangling_repair_ops(messages)
    if not ops:
        return 0
    await aupdate_state(config, {"messages": ops})
    return len(ops)


def _final_values(graph: Any, config: dict, fallback: dict) -> dict:
    snap = _get_state_safe(graph, config)
    values = getattr(snap, "values", None) if snap is not None else None
    return values if isinstance(values, dict) else fallback


async def _afinal_values(graph: Any, config: dict, fallback: dict) -> dict:
    snap = await _aget_state_safe(graph, config)
    values = getattr(snap, "values", None) if snap is not None else None
    return values if isinstance(values, dict) else fallback


def _iter_update_messages(update: Any):
    """node update 负载里的消息对象：{'messages': [...]} / 单条 / 裸消息。"""
    if isinstance(update, dict):
        candidates = update.get("messages")
        if isinstance(candidates, (list, tuple)):
            yield from candidates
        elif candidates is not None:
            yield candidates
    else:
        yield update


# ---------------------------------------------------------------------------
# 图路径 run_turn 组装（agent.py 握手期调用一次）
# ---------------------------------------------------------------------------


def make_run_turn(
    state: dict,
    *,
    input_mapper: Callable[[SarpInitialize, SarpTurnStart, bool], Any] | None = None,
    output_mapper: Callable[[dict], str] | None = None,
    interrupt_mapper: Callable[[Any], str] | None = None,
    resume_mapper: Callable[[SarpInitialize, SarpTurnStart, Any], Any] | None = None,
    custom_event_mapper: Callable[[Any], str | None] | None = None,
    cost_calculator: Callable[[dict], float | None] | None = None,
    system_prompt_mode: str = "prepend",
    exec_mode: str = "sync",
    streaming: bool = True,
    ensure_loop: Callable | None = None,
) -> RunTurn:
    """组装图路径回合函数 run_turn(init, turn, emit, cancelled) -> TurnOutcome。

    state 是内核共享 dict（keys：graph / mcp_client / slock_tool_ops）。
    exec_mode 在握手期经 resolve_execution 判定；ensure_loop 给常驻
    _AsyncLoop（exec_mode="async" 才用）。
    """

    def _usage_out(seen: set, totals: dict, duration_ms: int) -> dict | None:
        usage: dict[str, Any] = {}
        token_keys = (
            ("input_tokens", "inputTokens"),
            ("output_tokens", "outputTokens"),
            ("total_tokens", "totalTokens"),
        )
        for src, dst in token_keys:
            if src in seen:
                usage[dst] = totals[src]
        usage["durationMs"] = duration_ms
        if cost_calculator is not None:
            cost = cost_calculator(usage)
            if cost is not None:
                usage["costUsd"] = cost
        return usage if len(usage) > 1 else None  # 只有 durationMs 等于没数据

    def _interrupt_record(interrupts: Any) -> InterruptRecord:
        first = next(iter(interrupts), None)
        value = getattr(first, "value", first)
        options = None
        if interrupt_mapper is not None:
            # 用户 mapper 优先（§9.1：自带 mapper 时不产出默认 options）；
            # falsy 结果回退默认渲染——与旧 `str(value)` 兜底同语义
            prompt = interrupt_mapper(value)
            if not prompt:
                prompt, options = _default_interrupt_render(value)
        else:
            prompt, options = _default_interrupt_render(value)
        return InterruptRecord(
            interrupt_id=f"lg-{secrets.token_hex(8)}",
            resume_token=new_resume_token(),
            prompt=prompt,
            payload=value if _jsonable(value) else None,
            options=options,
        )

    def _handle_update(data: Any, emit: TurnEmit) -> Any | None:
        """updates 事件：返回捕获到的 Interrupt 元组（若有）。"""
        if not isinstance(data, dict):
            return None
        found = None
        for node, update in data.items():
            if node == "__interrupt__":
                found = update  # tuple/list of Interrupt
                continue
            for msg in _iter_update_messages(update):
                kind = _msg_kind(msg)
                if _is_tool_kind(kind):
                    call_id = getattr(msg, "tool_call_id", None) or getattr(msg, "id", "") or ""
                    ok = getattr(msg, "status", "success") == "success"
                    text = _truncate(getattr(msg, "content", ""))
                    emit.tool_end(
                        str(call_id),
                        ok,
                        name=getattr(msg, "name", None),
                        **tool_provider_fields(getattr(msg, "name", None), state["slock_tool_ops"], "langgraph"),
                        output=text,
                        error=None if ok else text,
                    )
                elif _is_ai_kind(kind):
                    for tc in getattr(msg, "tool_calls", None) or ():
                        if not isinstance(tc, dict):
                            continue
                        emit.tool_start(
                            str(tc.get("id") or ""),
                            str(tc.get("name") or ""),
                            **tool_provider_fields(tc.get("name"), state["slock_tool_ops"], "langgraph"),
                            input=tc.get("args"),
                        )
        return found

    # ---- 输入侧（sync/async 共用） ----

    def _map_input(init: SarpInitialize, turn: SarpTurnStart, fresh: bool) -> Any:
        if input_mapper is None:
            return _default_input_mapper(init, turn, fresh, system_prompt_mode)
        try:
            return input_mapper(init, turn, fresh)
        except SarpError:
            raise
        except KeyError as e:
            raise SarpError(
                GRAPH_INPUT_INVALID,
                f"input_mapper failed: missing key {e}; "
                "graph state has no 'messages' key? pass input_mapper/output_mapper",
                retryable=False,
            ) from e
        except Exception as e:
            raise SarpError(GRAPH_INPUT_INVALID, f"input_mapper failed: {e}", retryable=False) from e

    def _resume_value(init: SarpInitialize, turn: SarpTurnStart, snap: Any) -> Any:
        """resume_mapper(init, turn, interrupt_value)；缺省 → §9.2 默认归约
        （HITLRequest → {"decisions":[…]}，非 HITL → decision/value 原文）。"""
        interrupt_value = _first_interrupt_value(snap)
        if resume_mapper is not None:
            try:
                return resume_mapper(init, turn, interrupt_value)
            except SarpError:
                raise
            except Exception as e:
                raise SarpError(GRAPH_INPUT_INVALID, f"resume_mapper failed: {e}", retryable=False) from e
        return _default_resume_value(turn, interrupt_value)

    def _has_pending(snap: Any) -> bool:
        return bool(getattr(snap, "next", None)) if snap is not None else False

    def _resume_input(init: SarpInitialize, turn: SarpTurnStart, snap: Any) -> Any:
        """孤儿 resume 防护（实机踩坑）：journal 层已验 token 单次有效，
        但 thread 侧可能根本没有 pending interrupt——命名空间漂移
        （entrypoint/revision/model 任一变化即换 thread）、旧 5 段
        格式 thread、checkpoint 丢失都会命中。此时 Command(resume)
        会让 agent 节点拿到空 messages → provider 报 "Empty input
        messages"。显式失败让 daemon 清掉 pending 记录（自愈）。"""
        from langgraph.types import Command  # 惰性导入：无 resume 不碰 langgraph

        if not _has_pending(snap):
            raise SarpError(
                INTERRUPT_NOT_FOUND,
                f"resume for turn {turn.turn_id}: thread has no pending interrupt",
                retryable=False,
            )
        return Command(resume=_resume_value(init, turn, snap))

    # ---- 回合体（sync / async 两版——流事件处理共用 _stream_item） ----

    def _stream_item(ctx: dict, mode: Any, data: Any, emit: TurnEmit) -> Any | None:
        """单个 (mode, data) 事件的归类处理；返回新捕获的 interrupts 或 None。"""
        if mode == "messages":
            if isinstance(data, (tuple, list)) and len(data) == 2:
                chunk, _meta = data
            else:
                chunk, _meta = data, {}
            if _is_ai_kind(_msg_kind(chunk)):
                text = _flatten_content(getattr(chunk, "content", None))
                if text:
                    emit.delta(text)
            um = getattr(chunk, "usage_metadata", None)
            if isinstance(um, dict):
                for k in ctx["totals"]:
                    v = um.get(k)
                    if isinstance(v, (int, float)):
                        ctx["totals"][k] += int(v)
                        ctx["seen"].add(k)
        elif mode == "updates":
            if isinstance(data, dict):
                for node, upd in data.items():
                    if node != "__interrupt__" and isinstance(upd, dict):
                        ctx["last_updates"].update(upd)
            return _handle_update(data, emit)
        elif mode == "custom":
            mapped = custom_event_mapper(data) if custom_event_mapper else None
            if isinstance(mapped, str):
                emit.progress(mapped)
        return None

    def _tail(ctx: dict, graph: Any, config: dict) -> TurnOutcome:
        values = _final_values(graph, config, ctx["last_updates"])
        out_map = output_mapper or _default_output_mapper
        final_text = out_map(values)
        if final_text is not None and not isinstance(final_text, str):
            final_text = str(final_text)
        return TurnOutcome(
            status="success",
            final_text=final_text,
            usage=_usage_out(ctx["seen"], ctx["totals"], ctx["elapsed"]()),
        )

    def _new_ctx(started: float) -> dict:
        return {
            "seen": set(),
            "totals": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0},
            "last_updates": {},
            "elapsed": lambda: int((time.monotonic() - started) * 1000),
        }

    def _stream_tail(ctx: dict, graph: Any, graph_input: Any, config: dict, emit: TurnEmit, cancelled) -> TurnOutcome:
        interrupts = None
        if streaming:
            for mode, data in graph.stream(graph_input, config, stream_mode=_STREAM_MODES):
                if cancelled.is_set():
                    return TurnOutcome(status="cancelled")
                interrupts = _stream_item(ctx, mode, data, emit) or interrupts
                if interrupts:
                    return TurnOutcome(
                        status="interrupted",
                        interrupt=_interrupt_record(interrupts),
                        usage=_usage_out(ctx["seen"], ctx["totals"], ctx["elapsed"]()),
                    )
        else:
            result = graph.invoke(graph_input, config)
            if cancelled.is_set():
                return TurnOutcome(status="cancelled")
            if isinstance(result, dict):
                ctx["last_updates"].update(result)
                intr = result.get("__interrupt__")
                if intr:
                    return TurnOutcome(
                        status="interrupted",
                        interrupt=_interrupt_record(intr),
                        usage=_usage_out(ctx["seen"], ctx["totals"], ctx["elapsed"]()),
                    )
        return _tail(ctx, graph, config)

    async def _astream_tail(
        ctx: dict, graph: Any, graph_input: Any, config: dict, emit: TurnEmit, cancelled
    ) -> TurnOutcome:
        interrupts = None
        if streaming:
            async for mode, data in graph.astream(graph_input, config, stream_mode=_STREAM_MODES):
                if cancelled.is_set():
                    return TurnOutcome(status="cancelled")
                interrupts = _stream_item(ctx, mode, data, emit) or interrupts
                if interrupts:
                    return TurnOutcome(
                        status="interrupted",
                        interrupt=_interrupt_record(interrupts),
                        usage=_usage_out(ctx["seen"], ctx["totals"], ctx["elapsed"]()),
                    )
        else:
            result = await graph.ainvoke(graph_input, config)
            if cancelled.is_set():
                return TurnOutcome(status="cancelled")
            if isinstance(result, dict):
                ctx["last_updates"].update(result)
                intr = result.get("__interrupt__")
                if intr:
                    return TurnOutcome(
                        status="interrupted",
                        interrupt=_interrupt_record(intr),
                        usage=_usage_out(ctx["seen"], ctx["totals"], ctx["elapsed"]()),
                    )
        values = await _afinal_values(graph, config, ctx["last_updates"])
        out_map = output_mapper or _default_output_mapper
        final_text = out_map(values)
        if final_text is not None and not isinstance(final_text, str):
            final_text = str(final_text)
        return TurnOutcome(
            status="success",
            final_text=final_text,
            usage=_usage_out(ctx["seen"], ctx["totals"], ctx["elapsed"]()),
        )

    def _turn_sync(init, turn, emit, cancelled, graph, config, started) -> TurnOutcome:
        ctx = _new_ctx(started)
        graph_input: Any
        if turn.resume is not None:
            snap = _get_state_safe(graph, config)
            graph_input = _resume_input(init, turn, snap)
        else:
            fresh = _thread_fresh(graph, config)
            if not fresh:
                # 上个回合可能死在 tool_call 与 ToolMessage 之间——先补悬空
                # tool_call 的 error ToolMessage，否则 provider 400 拒收整个
                # messages（实机：idempotencyKey 400 崩回合后 thread 永久毒化）。
                _repair_dangling_tool_calls(graph, config)
            graph_input = _map_input(init, turn, fresh)
        return _stream_tail(ctx, graph, graph_input, config, emit, cancelled)

    async def _turn_async(init, turn, emit, cancelled, graph, config, started) -> TurnOutcome:
        ctx = _new_ctx(started)
        graph_input: Any
        if turn.resume is not None:
            snap = await _aget_state_safe(graph, config)
            graph_input = _resume_input(init, turn, snap)
        else:
            fresh = await _athread_fresh(graph, config)
            if not fresh:
                await _arepair_dangling_tool_calls(graph, config)
            graph_input = _map_input(init, turn, fresh)
        return await _astream_tail(ctx, graph, graph_input, config, emit, cancelled)

    def run_turn(init: SarpInitialize, turn: SarpTurnStart, emit: TurnEmit, cancelled) -> TurnOutcome:
        graph = state["graph"]
        client = state["mcp_client"]
        if client is not None:
            client.set_active_turn(turn.turn_id)  # §15.4：写工具幂等键锚定 turnId
        started = time.monotonic()
        # §11.2：thread_id 按 worker 身份命名空间控 checkpoint 连续性
        # （entrypoint/revision/model 变化不复用旧 thread——DEC-10 起
        # runtime.id 不再是分量）；slock_turn_id 供幂等审计。
        config = {
            "configurable": {
                "thread_id": checkpoint_thread_id(init, turn.conversation_id),
                "slock_turn_id": turn.turn_id,
            }
        }
        if exec_mode == "async":
            # §8.3：async 图全程跑在 worker 常驻事件循环上——协程内 emit 的
            # 帧写入有 transport 写锁，跨线程安全；turn.cancel 时
            # future.cancel() 桥成 task.cancel()。
            loop = ensure_loop()
            try:
                return loop.run(_turn_async(init, turn, emit, cancelled, graph, config, started), cancelled)
            except asyncio.CancelledError:
                return TurnOutcome(status="cancelled")
        return _turn_sync(init, turn, emit, cancelled, graph, config, started)

    return run_turn


# ---------------------------------------------------------------------------
# 旧入口（stable 别名）——共享内核在 agent.py，force_path 锁定图路径
# ---------------------------------------------------------------------------


def serve_langgraph(
    graph_or_factory: Any,
    *,
    input_mapper: Callable[[SarpInitialize, SarpTurnStart, bool], Any] | None = None,
    output_mapper: Callable[[dict], str] | None = None,
    interrupt_mapper: Callable[[Any], str] | None = None,
    custom_event_mapper: Callable[[Any], str | None] | None = None,
    cost_calculator: Callable[[dict], float | None] | None = None,
    streaming: bool = True,
    workspace_cwd: bool = False,
    runtime_id: str = "bridge",
    framework_version: str | None = None,
    transport: Any = None,
    journal: Any = None,
) -> int:
    """LangGraph worker 入口。返回进程退出码（0 正常关停，2 协议/初始化失败）。

    `serve_agent(..., force_path="graph")` 的 stable 别名（WP8）——签名与
    语义不变：graph_or_factory 可为 CompiledStateGraph 实例、鸭子类型图
    （stream/get_state），或 `factory(init, tools) -> graph` 工厂（§12.4：
    graph 不能在 import 时就 compile——Slock MCP tools 要等 initialize
    下发后才有；tools 是 list[SlockStructuredTool]）。新代码推荐
    `serve_agent`——按对象类型自动分派。

    workspace_cwd=True 时，initialize 握手期间把进程 cwd 切到
    init.workspace_path（daemon 为该 worker 建好的专属持久工作区）——工厂
    函数与图节点里的相对路径即以工作区为基准。默认 False：cwd 保持
    manifest 里声明的目录（通常是用户代码目录）。工作区不可进入
    （chdir 失败）→ runtime.error(CWD_NOT_FOUND)，握手失败。

    runtime_id：worker 对外上报的 runtime.id，默认 "bridge"；握手按归一值
    比对——initialize.runtime.id 为 "bridge"/"langchain"/"langgraph"
    （大小写不敏感）均接受，其余 → RUNTIME_ID_MISMATCH。

    mapper 签名：
    - input_mapper(init, turn, fresh) -> graph input；fresh = thread 无
      checkpoint 历史。默认规则见 _default_input_mapper。缺省 mapper 时
      握手期校验图输入 schema 含 "messages" 键（§8.4）。
    - output_mapper(state_values) -> str：终态 get_state().values → finalText。
    - interrupt_mapper(interrupt.value) -> str：审批提示文本；缺省走
      §9.1 默认渲染（HITLRequest → 可读提示 + options）。
    - custom_event_mapper(custom_data) -> str|None：返回 str 才发 progress。
    - cost_calculator(usage_dict) -> float|None：仅提供时才产出 costUsd。

    execution 固定走 auto 判定（SqliteSaver/同步图 → sync；Async*/async 节
    点 → 常驻事件循环 async）；强制模式请用 serve_agent(execution=...)。
    """
    from .agent import _serve_impl  # 惰性——避免 import 环

    return _serve_impl(
        graph_or_factory,
        force_path="graph",
        input_mapper=input_mapper,
        output_mapper=output_mapper,
        interrupt_mapper=interrupt_mapper,
        custom_event_mapper=custom_event_mapper,
        cost_calculator=cost_calculator,
        streaming=streaming,
        workspace_cwd=workspace_cwd,
        runtime_id=runtime_id,
        framework_version=framework_version,
        transport=transport,
        journal=journal,
    )
