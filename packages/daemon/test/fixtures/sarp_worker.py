"""daemon e2e fixture：真实 slock_runtime SDK worker（裸 serve() 路径）。

由 sarp-python-worker.test.ts spawn。PYTHONPATH 指向 bridges/python。
行为由 env 控制（与 sarp-worker.mjs 的 SLOCK_FX_* 约定同风格）：

- 默认：delta×2 + usage + success(finalText=f"py:{prompt}", sessionRef=conversationId)
- SLOCK_PY_INTERRUPT=1：无 resume 的回合 → interrupted（runtime 自动签发
  resume token）；带 resume 的回合 → success(finalText=f"resumed:{value}")
- SLOCK_PY_RUNTIME_ID：覆盖 ready 的 runtime.id（mismatch 测试）
- SLOCK_PY_STDOUT_NOISE=1：往 stdout 打一行非帧文本——daemon 应判
  protocol-violation（验证「stdout 协议纯净」纪律在真实 Python 进程上成立）
"""

from __future__ import annotations

import os
import sys

from slock_runtime import InterruptRecord, TurnOutcome, WorkerRuntime, new_resume_token

RUNTIME_ID = os.environ.get("SLOCK_PY_RUNTIME_ID", "langgraph")


def run_turn(init, turn, emit, cancelled):
    if os.environ.get("SLOCK_PY_INTERRUPT") == "1":
        if turn.resume is not None:
            return TurnOutcome(status="success", final_text=f"resumed:{turn.resume.value}")
        emit.progress("等待人工批准")
        return TurnOutcome(
            status="interrupted",
            interrupt=InterruptRecord(
                interrupt_id=f"py-int-{turn.turn_id}",
                resume_token=new_resume_token(),
                prompt="批准执行？",
            ),
        )
    emit.delta("py:")
    emit.delta(turn.prompt)
    usage = {"inputTokens": 1, "outputTokens": 2, "totalTokens": 3}
    emit.usage(usage)
    return TurnOutcome(status="success", final_text=f"py:{turn.prompt}", session_ref=turn.conversation_id, usage=usage)


def on_initialize(init, emit):
    print(f"[sarp_worker] init agent={init.agent.id} runtime={init.runtime_id}", file=sys.stderr)
    return None


def main() -> int:
    if os.environ.get("SLOCK_PY_STDOUT_NOISE") == "1":
        print("NOT-A-FRAME: stdout noise")  # 协议违规注入
    rt = WorkerRuntime(runtime_id=RUNTIME_ID, framework_version="fixture/1")
    return rt.serve(run_turn, on_initialize)


if __name__ == "__main__":
    sys.exit(main())
