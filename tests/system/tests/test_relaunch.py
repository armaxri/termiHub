"""Unit tests for following an app that restarts itself (#4127).

:func:`termihub_harness.relaunch.find_relaunched_app` picks the relaunched
process out of the process table, and
:meth:`~termihub_harness.orchestrator.AppInstance.adopt_self_restart` waits for
the launched process to exit and tracks its replacement. Machinery tests (no
``integration`` marker): the finder runs against fake processes, and the adopt
test uses a tiny Python "app" that respawns itself the way Tauri's
``request_restart`` does (same binary, inherited environment, then exit).
"""

from __future__ import annotations

import sys
from pathlib import Path

import psutil
import pytest

from termihub_harness import orchestrator
from termihub_harness.relaunch import BRIDGE_PORT_ENV, find_relaunched_app


class _Proc:
    """A psutil.Process stand-in for the finder."""

    def __init__(self, pid, exe, created, env, *, denied=False):
        self.pid = pid
        self._exe = exe
        self._created = created
        self._env = env
        self._denied = denied

    def exe(self):
        return self._exe

    def create_time(self):
        return self._created

    def environ(self):
        if self._denied:
            raise psutil.AccessDenied(self.pid)
        return self._env


def _find(binary: Path, procs, *, port=5555, exclude=1, not_before=1000.0):
    return find_relaunched_app(
        binary, port, exclude_pid=exclude, not_before=not_before, processes=procs
    )


def test_finds_the_relaunch_with_this_instances_bridge_port(tmp_path: Path):
    binary = tmp_path / "termihub"
    binary.write_text("")
    other_port = _Proc(2, str(binary), 1001.0, {BRIDGE_PORT_ENV: "6666"})
    relaunched = _Proc(3, str(binary), 1001.0, {BRIDGE_PORT_ENV: "5555"})
    assert _find(binary, [other_port, relaunched]) is relaunched


def test_skips_the_old_pid_other_binaries_and_older_processes(tmp_path: Path):
    binary = tmp_path / "termihub"
    binary.write_text("")
    env = {BRIDGE_PORT_ENV: "5555"}
    old = _Proc(1, str(binary), 1001.0, env)  # the process that restarted itself
    other_binary = _Proc(2, str(tmp_path / "other"), 1001.0, env)
    stale = _Proc(3, str(binary), 900.0, env)  # older than this launch
    no_exe = _Proc(4, None, 1001.0, env)
    assert _find(binary, [old, other_binary, stale, no_exe]) is None


def test_skips_processes_that_deny_access(tmp_path: Path):
    binary = tmp_path / "termihub"
    binary.write_text("")
    denied = _Proc(2, str(binary), 1001.0, {}, denied=True)
    relaunched = _Proc(3, str(binary), 1001.0, {BRIDGE_PORT_ENV: "5555"})
    assert _find(binary, [denied, relaunched]) is relaunched


def test_matches_the_binary_through_a_symlink(tmp_path: Path):
    binary = tmp_path / "termihub"
    binary.write_text("")
    link = tmp_path / "link"
    try:
        link.symlink_to(binary)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks are not available here")
    relaunched = _Proc(3, str(binary), 1001.0, {BRIDGE_PORT_ENV: "5555"})
    assert _find(link, [relaunched]) is relaunched


#: A stand-in "app" that restarts itself like ``request_restart``: it spawns its
#: own interpreter again (inheriting the environment) and exits at once.
_SELF_RESTARTING_APP = (
    "import subprocess, sys\n"
    "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])\n"
    "sys.exit(0)\n"
)


def test_adopt_self_restart_tracks_and_reaps_the_relaunched_process(tmp_path, monkeypatch):
    interpreter = Path(psutil.Process().exe())
    if not interpreter.exists():
        pytest.skip("cannot resolve this interpreter's binary")
    monkeypatch.setattr(orchestrator, "app_binary_path", lambda: interpreter)
    instance = orchestrator.AppInstance(config_dir=tmp_path, echo_logs=False)
    instance.start(orchestrator.free_port(), ["-c", _SELF_RESTARTING_APP])
    launched = instance._process.pid
    try:
        instance.adopt_self_restart(timeout=30)
        relaunched = instance.pid
        assert relaunched is not None and relaunched != launched
        assert instance.is_running()
        assert psutil.Process(relaunched).environ().get(BRIDGE_PORT_ENV) == str(
            instance._bridge_port
        )
    finally:
        instance.stop()
    assert not psutil.pid_exists(relaunched) or (
        psutil.Process(relaunched).status() == psutil.STATUS_ZOMBIE
    ), "stop() left the relaunched app running"
    assert not instance.is_running()


def test_adopt_self_restart_fails_when_the_app_does_not_exit(tmp_path, monkeypatch):
    interpreter = Path(psutil.Process().exe())
    monkeypatch.setattr(orchestrator, "app_binary_path", lambda: interpreter)
    instance = orchestrator.AppInstance(config_dir=tmp_path, echo_logs=False)
    instance.start(orchestrator.free_port(), ["-c", "import time; time.sleep(120)"])
    try:
        with pytest.raises(AssertionError, match="did not exit"):
            instance.adopt_self_restart(timeout=1)
    finally:
        instance.stop()


def test_adopt_self_restart_needs_a_started_app(tmp_path, monkeypatch):
    monkeypatch.setattr(orchestrator, "app_binary_path", lambda: Path(sys.executable))
    instance = orchestrator.AppInstance(config_dir=tmp_path, echo_logs=False)
    with pytest.raises(RuntimeError, match="never started"):
        instance.adopt_self_restart(timeout=1)
