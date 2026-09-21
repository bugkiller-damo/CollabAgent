"""公开 API 分层与单一版本源回归（P0.1：发布前的 API 契约锁）。"""

from __future__ import annotations

import importlib.metadata

import pytest

import slock_runtime
from slock_runtime._version import BRIDGE_VERSION, __version__

STABLE = {"serve_langchain", "serve_langgraph", "SARP_PROTOCOL", "SARP_VERSION"}

ADVANCED = {
    "serve",
    "WorkerRuntime",
    "TurnOutcome",
    "TurnEmit",
    "TurnJournal",
    "InterruptRecord",
    "SarpTransport",
    "SarpInitialize",
    "SarpTurnStart",
    "SarpTurnCancel",
    "SarpShutdown",
    "SarpTurnSource",
    "SarpResume",
    "SarpMcpDescriptor",
    "SarpError",
    "SarpProtocolError",
    "WireError",
    "map_provider_error",
    "new_resume_token",
}


def test_single_version_source():
    """__init__ / runtime / mcp / 包元数据共用 _version.py 一处定义。"""
    assert slock_runtime.__version__ == __version__
    assert BRIDGE_VERSION.endswith(__version__) and BRIDGE_VERSION.startswith("slock-runtime/")

    import slock_runtime.mcp as mcp
    import slock_runtime.runtime as rt

    assert rt.BRIDGE_VERSION == BRIDGE_VERSION
    expected_client = {"name": "slock-runtime", "version": __version__}
    assert expected_client == mcp.CLIENT_INFO


def test_version_matches_distribution_metadata():
    """pyproject dynamic version 与 _version.py 一致（需 pip install -e）。"""
    try:
        dist_version = importlib.metadata.version("slock-runtime")
    except importlib.metadata.PackageNotFoundError:
        pytest.skip("slock-runtime 未以发行包形式安装")
    assert dist_version == __version__


def test_api_surface_is_exact():
    """__all__ 恰好 = stable ∪ advanced ∪ {__version__}——增删导出即破约。"""
    assert set(slock_runtime.__all__) == STABLE | ADVANCED | {"__version__"}


def test_stable_entries_resolve():
    """stable 面可访问且不引入框架依赖（惰性加载生效）。"""
    assert slock_runtime.SARP_PROTOCOL == "slock.agent-runtime"
    assert slock_runtime.SARP_VERSION == 1
    assert callable(slock_runtime.serve_langchain)
    assert callable(slock_runtime.serve_langgraph)
