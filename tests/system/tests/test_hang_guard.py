"""Machinery tests for the per-phase hang guard (#4017).

The guard's decision logic runs against plain env dicts; the watchdog itself is
proven end to end in a throwaway subprocess that hangs in a "test phase" and
must be dumped and killed by the guard instead of blocking forever.
"""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import psutil
import pytest

from termihub_harness import hang_guard


@pytest.mark.parametrize(
    "env, expected",
    [
        ({}, False),
        ({"PYTEST_XDIST_WORKER": "gw0"}, True),
        ({"PYTEST_XDIST_WORKER": "gw0", hang_guard.GUARD_ENV: "0"}, False),
        ({hang_guard.GUARD_ENV: "1"}, True),
        ({hang_guard.GUARD_ENV: "off"}, False),
    ],
    ids=["plain-run", "xdist-worker", "worker-opted-out", "forced-on", "forced-off"],
)
def test_enabled_only_on_xdist_workers_by_default(env, expected):
    assert hang_guard.enabled(env) is expected


def test_budgets_default_per_phase():
    assert hang_guard.budget("setup", {}) == hang_guard.DEFAULT_BUDGETS["setup"]
    assert hang_guard.budget("call", {}) == hang_guard.DEFAULT_BUDGETS["call"]
    assert hang_guard.budget("teardown", {}) == hang_guard.DEFAULT_BUDGETS["teardown"]


def test_setup_budget_covers_the_agent_cross_build():
    """Session fixtures (the 1500 s deployed-agent build) run in a setup phase."""
    assert hang_guard.DEFAULT_BUDGETS["setup"] > 1500 + 300


@pytest.mark.parametrize(
    "raw, expected", [("1200", 1200.0), ("junk", 900.0), ("0", 900.0), ("-5", 900.0)]
)
def test_budget_env_override(raw, expected):
    assert hang_guard.budget("call", {"TERMIHUB_TEST_HANG_CALL_SECONDS": raw}) == expected


def test_traceback_path_is_per_worker(tmp_path):
    path = hang_guard.traceback_path(tmp_path, {"PYTEST_XDIST_WORKER": "gw1"})
    assert path.parent == tmp_path / "hang-tracebacks"
    assert path.name.startswith("gw1-")


def test_close_removes_an_unused_traceback_file(tmp_path):
    # Isolate from a guard the conftest may have armed for this very test, and
    # hand its stream back before this test's teardown phase re-arms it.
    saved = (hang_guard._stream, hang_guard._stream_path)
    hang_guard._stream = hang_guard._stream_path = None
    try:
        hang_guard.arm("call", tmp_path)
        hang_guard.disarm()
        assert (tmp_path / "hang-tracebacks").is_dir()
        hang_guard.close()
        assert not (tmp_path / "hang-tracebacks").exists()
    finally:
        hang_guard._stream, hang_guard._stream_path = saved


def test_an_overrunning_phase_dumps_stacks_kills_children_and_exits(tmp_path):
    """A phase that blocks forever is dumped and killed within its budget, and
    the processes it launched (the app, in a real run) die with it."""
    harness_root = Path(hang_guard.__file__).resolve().parents[1]
    pid_file = tmp_path / "child.pid"
    script = textwrap.dedent(
        f"""
        import subprocess, sys, threading
        sys.path.insert(0, {str(harness_root)!r})
        from pathlib import Path
        from termihub_harness import hang_guard
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
        Path({str(pid_file)!r}).write_text(str(child.pid))
        hang_guard.arm("call", Path({str(tmp_path)!r}))
        threading.Event().wait()  # a blocking call with no timeout
        """
    )
    env = {
        **os.environ,
        "PYTEST_XDIST_WORKER": "gw7",
        "TERMIHUB_TEST_HANG_CALL_SECONDS": "1",
    }
    env.pop(hang_guard.GUARD_ENV, None)
    result = subprocess.run(
        [sys.executable, "-c", script], env=env, capture_output=True, text=True, timeout=60
    )
    assert result.returncode != 0
    dumps = list((tmp_path / "hang-tracebacks").glob("gw7-*.txt"))
    assert len(dumps) == 1
    text = dumps[0].read_text(encoding="utf-8")
    assert "the call phase exceeded 1s" in text
    assert "in wait" in text  # the blocked frame is in the dump
    child_pid = int(pid_file.read_text())
    deadline = time.monotonic() + 10
    while psutil.pid_exists(child_pid) and time.monotonic() < deadline:
        try:
            if psutil.Process(child_pid).status() == psutil.STATUS_ZOMBIE:
                break
        except psutil.Error:
            break
        time.sleep(0.1)
    else:
        if psutil.pid_exists(child_pid):
            psutil.Process(child_pid).kill()
            pytest.fail("the guard left the launched child process running")
