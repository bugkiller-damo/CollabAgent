"""Phase 5 §11.2：checkpoint thread_id 命名空间隔离。

runtime/entrypoint/revision/model 任一分量变化 → 不同 thread_id；
身份不变时同一 conversation_id 保持稳定（会话连续性）。
"""

from slock_runtime.langgraph import checkpoint_thread_id
from slock_runtime.protocol import SarpAgentInfo, SarpInitialize


def _init(**over) -> SarpInitialize:
    fields = dict(
        seq=1,
        request_id="r",
        agent=SarpAgentInfo(id="ag", name="bot"),
        runtime_id="langgraph",
        entrypoint="e1",
        model=None,
        revision=None,
        workspace_path="/tmp/ws",
        system_prompt=None,
        server_url=None,
        token_file=None,
        mcp=None,
        max_frame_bytes=1048576,
        silence_timeout_ms=300000,
        shutdown_timeout_ms=None,
    )
    fields.update(over)
    return SarpInitialize(**fields)


def test_namespace_stable_when_identity_unchanged():
    assert checkpoint_thread_id(_init(), "conv-1") == checkpoint_thread_id(_init(), "conv-1")


def test_runtime_change_isolates():
    assert checkpoint_thread_id(_init(runtime_id="langgraph"), "c") != checkpoint_thread_id(
        _init(runtime_id="langchain"), "c"
    )


def test_entrypoint_change_isolates():
    assert checkpoint_thread_id(_init(entrypoint="e1"), "c") != checkpoint_thread_id(_init(entrypoint="e2"), "c")


def test_revision_change_isolates():
    assert checkpoint_thread_id(_init(revision="rev1"), "c") != checkpoint_thread_id(_init(revision="rev2"), "c")


def test_model_change_isolates():
    assert checkpoint_thread_id(_init(model="a"), "c") != checkpoint_thread_id(_init(model="b"), "c")


def test_conversation_id_still_distinguishes():
    assert checkpoint_thread_id(_init(), "c1") != checkpoint_thread_id(_init(), "c2")


def test_separator_chars_sanitized():
    tid = checkpoint_thread_id(_init(entrypoint="ep:weird", revision="r:v"), "conv:1")
    assert tid.count(":") == 4  # 恰好 4 个命名空间分隔符
    assert tid.endswith(":conv_1")
