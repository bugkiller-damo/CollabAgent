"""idempotency.py：回合日志 + resume token 单次使用（§15.4/§11.4）。"""

from __future__ import annotations

import os
import stat

from slock_runtime.idempotency import TurnJournal, TurnJournalEntry


class TestTurnJournal:
    def test_lookup_miss(self, tmp_path):
        j = TurnJournal(str(tmp_path))
        assert j.lookup("nope") is None
        j.close()

    def test_record_and_replay(self, tmp_path):
        j = TurnJournal(str(tmp_path))
        j.record(
            TurnJournalEntry(
                turn_id="t1",
                status="success",
                final_text="done",
                session_ref="ref",
                usage={"inputTokens": 3},
            )
        )
        e = j.lookup("t1")
        assert e is not None and e.status == "success"
        assert e.final_text == "done" and e.usage == {"inputTokens": 3}
        j.close()
        # 重新打开（模拟 worker 重启）——状态仍在
        j2 = TurnJournal(str(tmp_path))
        assert j2.lookup("t1") is not None
        j2.close()

    def test_interrupt_record_roundtrip(self, tmp_path):
        j = TurnJournal(str(tmp_path))
        intr = {"interrupt_id": "i1", "resume_token": "rt", "prompt": "ok?", "payload": None}
        j.record(TurnJournalEntry(turn_id="t2", status="interrupted", interrupt=intr))
        e = j.lookup("t2")
        assert e.interrupt["interrupt_id"] == "i1"
        j.close()

    def test_db_path_and_perms(self, tmp_path):
        j = TurnJournal(str(tmp_path))
        db = tmp_path / ".slock" / "runtime-state.sqlite"
        assert db.exists()
        if os.name != "nt":
            mode = stat.S_IMODE(os.stat(db).st_mode)
            assert mode & 0o777 == 0o600
        j.close()


class TestResumeTokens:
    def test_issue_and_consume_once(self, tmp_path):
        j = TurnJournal(str(tmp_path))
        j.issue_resume_token("rt-1", "int-1", "conv-1")
        rec = j.consume_resume_token("rt-1", "conv-1")
        assert rec is not None and rec.interrupt_id == "int-1"
        # §11.4：单次使用——第二次拒绝
        assert j.consume_resume_token("rt-1", "conv-1") is None
        j.close()

    def test_unknown_token(self, tmp_path):
        j = TurnJournal(str(tmp_path))
        assert j.consume_resume_token("ghost", "conv-1") is None
        j.close()

    def test_wrong_conversation(self, tmp_path):
        j = TurnJournal(str(tmp_path))
        j.issue_resume_token("rt-2", "int-2", "conv-A")
        assert j.consume_resume_token("rt-2", "conv-B") is None
        # 未被消耗——正确 conversation 仍可用
        assert j.consume_resume_token("rt-2", "conv-A") is not None
        j.close()
