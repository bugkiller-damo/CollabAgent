"""回合幂等日志 + resume token 登记（§15.4 / §11.4）。

默认落 `<workspace>/.slock/runtime-state.sqlite`（0600）：

- turn_journal: turnId → 终态结果摘要（status/finalText/usage/sessionRef）。
  daemon retry 同一 turnId 时直接回放 turn.end，不重跑 graph（at-least-once
  语义下的 worker 侧幂等）。
- resume_tokens: resumeToken → interruptId/conversationId/used。
  interrupt 签发登记；resume 命中即标记 used——§11.4 单次使用纪律。

安全纪律（§12.1）：不写 provider key、scoped token、完整 prompt 进库。
"""

from __future__ import annotations

import contextlib
import json
import os
import sqlite3
import stat
import threading
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class TurnJournalEntry:
    turn_id: str
    status: str  # success / interrupted / cancelled / error
    final_text: str | None = None
    session_ref: str | None = None
    usage: dict | None = None
    interrupt: dict | None = None
    error: dict | None = None


@dataclass(frozen=True)
class ResumeTokenRecord:
    resume_token: str
    interrupt_id: str
    conversation_id: str
    used: bool


class TurnJournal:
    def __init__(self, workspace_path: str):
        state_dir = Path(workspace_path) / ".slock"
        state_dir.mkdir(parents=True, exist_ok=True)
        self._db_path = state_dir / "runtime-state.sqlite"
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(self._db_path), check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS turn_journal (
                turn_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                final_text TEXT,
                session_ref TEXT,
                usage TEXT,
                interrupt TEXT,
                error TEXT,
                finished_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE TABLE IF NOT EXISTS resume_tokens (
                resume_token TEXT PRIMARY KEY,
                interrupt_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                used INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            """
        )
        self._db.commit()
        # 0600：与 token file / daemon private dir 同纪律
        # Windows NTFS 无 POSIX 位——尽力而为
        with contextlib.suppress(OSError):
            os.chmod(self._db_path, stat.S_IRUSR | stat.S_IWUSR)

    # ---- 回合幂等（§15.4.2-3）----

    def lookup(self, turn_id: str) -> TurnJournalEntry | None:
        with self._lock:
            row = self._db.execute(
                "SELECT turn_id,status,final_text,session_ref,usage,interrupt,error FROM turn_journal WHERE turn_id=?",
                (turn_id,),
            ).fetchone()
        if row is None:
            return None
        return TurnJournalEntry(
            turn_id=row[0],
            status=row[1],
            final_text=row[2],
            session_ref=row[3],
            usage=json.loads(row[4]) if row[4] else None,
            interrupt=json.loads(row[5]) if row[5] else None,
            error=json.loads(row[6]) if row[6] else None,
        )

    def record(self, entry: TurnJournalEntry) -> None:
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO turn_journal"
                "(turn_id,status,final_text,session_ref,usage,interrupt,error) VALUES(?,?,?,?,?,?,?)",
                (
                    entry.turn_id,
                    entry.status,
                    entry.final_text,
                    entry.session_ref,
                    json.dumps(entry.usage) if entry.usage else None,
                    json.dumps(entry.interrupt) if entry.interrupt else None,
                    json.dumps(entry.error) if entry.error else None,
                ),
            )
            self._db.commit()

    # ---- resume token（§11.4 单次使用）----

    def issue_resume_token(self, resume_token: str, interrupt_id: str, conversation_id: str) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO resume_tokens(resume_token,interrupt_id,conversation_id,used) VALUES(?,?,?,0)",
                (resume_token, interrupt_id, conversation_id),
            )
            self._db.commit()

    def consume_resume_token(self, resume_token: str, conversation_id: str) -> ResumeTokenRecord | None:
        """命中且未使用 → 标记 used 并返回记录；否则 None。"""
        with self._lock:
            row = self._db.execute(
                "SELECT resume_token,interrupt_id,conversation_id,used FROM resume_tokens WHERE resume_token=?",
                (resume_token,),
            ).fetchone()
            if row is None or row[3] or row[2] != conversation_id:
                return None
            self._db.execute("UPDATE resume_tokens SET used=1 WHERE resume_token=?", (resume_token,))
            self._db.commit()
        return ResumeTokenRecord(row[0], row[1], row[2], used=False)

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self._db.close()
