"""Phase 5 §11.2 + WP6/DEC-10：checkpoint thread_id 命名空间隔离。

entrypoint/revision/model 任一分量变化 → 不同 thread_id；runtime.id 不再是
命名空间分量（entrypoint 已唯一标识 worker——旧 5 段格式一次性废弃）。
身份不变时同一 conversation_id 保持稳定（会话连续性）。
"""

from slock_runtime.langgraph import checkpoint_thread_id
from slock_runtime.protocol import SarpAgentInfo, SarpInitialize


def _init(**over) -> SarpInitialize:
    fields = dict(
        seq=1,
        request_id="r",
        agent=SarpAgentInfo(id="ag", name="bot"),
        runtime_id="bridge",
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


def test_runtime_id_not_part_of_namespace():
    """DEC-10：runtime.id（含旧别名差异）不再切分 thread 命名空间。"""
    assert checkpoint_thread_id(_init(runtime_id="bridge"), "c") == checkpoint_thread_id(
        _init(runtime_id="langgraph"), "c"
    )


def test_entrypoint_change_isolates():
    assert checkpoint_thread_id(_init(entrypoint="e1"), "c") != checkpoint_thread_id(_init(entrypoint="e2"), "c")


def test_revision_change_isolates():
    assert checkpoint_thread_id(_init(revision="rev1"), "c") != checkpoint_thread_id(_init(revision="rev2"), "c")


def test_model_change_isolates():
    assert checkpoint_thread_id(_init(model="a"), "c") != checkpoint_thread_id(_init(model="b"), "c")


def test_conversation_id_still_distinguishes():
    assert checkpoint_thread_id(_init(), "c1") != checkpoint_thread_id(_init(), "c2")


def test_four_component_format():
    """新格式：entrypoint:revision:model:conversation_id（无 runtime 前缀）。"""
    tid = checkpoint_thread_id(_init(entrypoint="e1", revision="r1", model="m1"), "c")
    assert tid == "e1:r1:m1:c"


def test_separator_chars_sanitized():
    tid = checkpoint_thread_id(_init(entrypoint="ep:weird", revision="r:v"), "conv:1")
    assert tid.count(":") == 3  # 恰好 3 个命名空间分隔符（4 分量）
    assert tid.endswith(":conv_1")
