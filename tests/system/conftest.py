"""Shared pytest fixtures for the system-test harness."""

import pytest

from termihub_harness import AgentInstance, AppInstance, Bridge


@pytest.fixture
def bridge():
    """A started bridge server; closed after the test."""
    server = Bridge().start()
    yield server
    server.close()


@pytest.fixture
def app():
    """An (unstarted) :class:`AppInstance`; skipped if the app is not built.

    The test starts it with ``app.start(bridge.port)`` so it can control launch
    ordering; the process tree is torn down afterward.
    """
    try:
        instance = AppInstance()
    except FileNotFoundError as exc:
        pytest.skip(str(exc))
    with instance as started:
        yield started


@pytest.fixture
def agent():
    """An (unstarted) :class:`AgentInstance`; skipped if the agent is not built."""
    try:
        instance = AgentInstance()
    except FileNotFoundError as exc:
        pytest.skip(str(exc))
    with instance as started:
        yield started
