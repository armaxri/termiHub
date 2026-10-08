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
import threading
import time
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


def _stop_within(instance, seconds: float) -> float:
    """Run ``instance.stop()`` on a thread; fail if it is still blocked after ``seconds``."""
    done = threading.Event()
    started = time.monotonic()

    def run():
        instance.stop()
        done.set()

    threading.Thread(target=run, daemon=True).start()
    assert done.wait(seconds), f"stop() still blocked after {seconds}s"
    return time.monotonic() - started


def test_stop_reaps_an_unadopted_self_restart_without_hanging(tmp_path, monkeypatch):
    """The 2026-10-06 macOS hang (#4017): the app restarted itself, nobody adopted
    the relaunch, and teardown's pipe close waited forever on the relaunch, which
    still held the app's output pipe. stop() must find it, kill it, and return."""
    interpreter = Path(psutil.Process().exe())
    if not interpreter.exists():
        pytest.skip("cannot resolve this interpreter's binary")
    monkeypatch.setattr(orchestrator, "app_binary_path", lambda: interpreter)
    instance = orchestrator.AppInstance(config_dir=tmp_path, echo_logs=False)
    instance.start(orchestrator.free_port(), ["-c", _SELF_RESTARTING_APP])
    launched = instance._process.pid
    assert instance.wait_exited(30)
    relaunched = None
    deadline = time.monotonic() + 30
    while relaunched is None and time.monotonic() < deadline:
        relaunched = find_relaunched_app(
            interpreter, instance._bridge_port, exclude_pid=launched, not_before=0
        )
        time.sleep(0.1)
    assert relaunched is not None, "the stand-in app did not relaunch itself"
    try:
        _stop_within(instance, 20)
    finally:
        if relaunched.is_running():
            relaunched.kill()
    assert not psutil.pid_exists(relaunched.pid) or (
        relaunched.status() == psutil.STATUS_ZOMBIE
    ), "stop() left the unadopted relaunch running"


#: A stand-in app that leaves a stray process of ANOTHER binary holding its output
#: pipe (inherited stdout), prints that process's pid, and exits.
_STRAY_WRITER_APP = (
    "import subprocess, sys\n"
    "p = subprocess.Popen(['/bin/sh', '-c', 'sleep 60'])\n"
    "print('stray-pid', p.pid, flush=True)\n"
    "sys.exit(0)\n"
)


@pytest.mark.skipif(sys.platform == "win32", reason="uses /bin/sh")
def test_stop_does_not_block_on_a_stray_pipe_writer(tmp_path, monkeypatch):
    """A writer the harness cannot attribute must not wedge teardown either."""
    interpreter = Path(psutil.Process().exe())
    if not interpreter.exists():
        pytest.skip("cannot resolve this interpreter's binary")
    monkeypatch.setattr(orchestrator, "app_binary_path", lambda: interpreter)
    instance = orchestrator.AppInstance(config_dir=tmp_path, echo_logs=False)
    instance.start(orchestrator.free_port(), ["-c", _STRAY_WRITER_APP])
    assert instance.wait_exited(30)
    stray_pid = None
    deadline = time.monotonic() + 10
    while stray_pid is None and time.monotonic() < deadline:
        for line in instance.read_log().splitlines():
            if line.startswith("stray-pid "):
                stray_pid = int(line.split()[1])
        time.sleep(0.1)
    try:
        elapsed = _stop_within(instance, 20)
        assert elapsed < 15
    finally:
        if stray_pid is not None:
            try:
                psutil.Process(stray_pid).kill()
            except psutil.Error:
                pass


def test_matches_the_relaunch_by_file_identity_not_spelling(tmp_path: Path):
    # macOS relaunches Contents/MacOS/<CFBundleExecutable>, which can differ in
    # case from the launched path on a case-insensitive volume; a hard link
    # stands in for "same file, other spelling" on any filesystem.
    binary = tmp_path / "termiHub"
    binary.write_text("")
    alias = tmp_path / "relaunched-name"
    alias.hardlink_to(binary)
    relaunched = _Proc(3, str(alias), 1001.0, {BRIDGE_PORT_ENV: "5555"})
    assert _find(binary, [relaunched]) is relaunched


def test_describes_app_like_processes_for_a_failed_adopt(tmp_path: Path):
    from termihub_harness.relaunch import describe_candidates

    binary = tmp_path / "termiHub"
    binary.write_text("")
    lines = describe_candidates(
        binary,
        5555,
        processes=[
            _Proc(3, str(tmp_path / "TERMIHUB"), 1001.0, {BRIDGE_PORT_ENV: "5555"}),
            _Proc(4, str(tmp_path / "other"), 1001.0, {}),
            _Proc(5, str(binary), 1001.0, {}, denied=True),
        ],
    )
    assert len(lines) == 2
    assert "pid=3" in lines[0] and f"{BRIDGE_PORT_ENV}=5555 (want 5555)" in lines[0]
    assert "pid=5" in lines[1] and "<AccessDenied>" in lines[1]
