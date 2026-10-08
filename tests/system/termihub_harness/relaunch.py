"""Find the process an app started when it restarted itself (#4127).

Some app flows end in a self-restart: a backup restore stages the restored
stores and calls ``AppHandle::request_restart``, which spawns the same binary
again (same arguments, inherited environment) and exits. The harness launched
the first process, but the relaunched one is not its child once the parent has
exited, so :class:`~termihub_harness.orchestrator.AppInstance` has to look it up
to track it (and to kill it on teardown).

The relaunched process inherits the launch environment, including the
per-instance ``TERMIHUB_TEST_BRIDGE_PORT``. That is what tells it apart from
other app instances running the same binary at the same time (xdist workers).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable, Optional

import psutil

#: The launch variable that names the instance's bridge port (set by ``start``).
BRIDGE_PORT_ENV = "TERMIHUB_TEST_BRIDGE_PORT"

#: Slack on the creation-time filter: process start times are rounded and the
#: harness clock and the process table can disagree by a little.
_CREATE_TIME_SLACK = 2.0


def _same_file(a: Optional[str], b: Path) -> bool:
    """Whether path ``a`` names the same file as ``b``.

    Compared by file identity (device + inode), not by spelling: on macOS the
    app relaunches ``Contents/MacOS/<CFBundleExecutable>``, which can differ in
    case from the path the harness launched (``termiHub`` vs ``termihub``) on a
    case-insensitive volume, and ``realpath`` does not fold case. A spelling
    mismatch made the harness miss the relaunched app (nightly 2026-10-07).
    Falls back to comparing resolved paths when either file cannot be stat'ed.
    """
    if not a:
        return False
    try:
        return os.path.samefile(a, b)
    except OSError:
        pass
    try:
        return os.path.realpath(a) == os.path.realpath(b)
    except OSError:
        return False


def describe_candidates(
    binary: Path,
    bridge_port: int,
    processes: Optional[Iterable[psutil.Process]] = None,
) -> list[str]:
    """One line per process that looks like the app, for a failed adopt.

    Lists every process whose executable name matches ``binary``'s (ignoring
    case) with what the finder checks — the executable, whether it is the same
    file, its start time and its bridge port — so a nightly that still misses a
    relaunch shows which check rejected it.
    """
    candidates = processes if processes is not None else psutil.process_iter()
    stem = binary.name.lower()
    lines = []
    for proc in candidates:
        try:
            exe = proc.exe()
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess) as exc:
            exe, error = None, type(exc).__name__
        else:
            error = ""
        if not exe or Path(exe).name.lower() != stem:
            continue
        try:
            port = proc.environ().get(BRIDGE_PORT_ENV)
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess) as exc:
            port = f"<{type(exc).__name__}>"
        try:
            created = f"{proc.create_time():.1f}"
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            created = "?"
        lines.append(
            f"pid={proc.pid} exe={exe} same_file={_same_file(exe, binary)} "
            f"created={created} {BRIDGE_PORT_ENV}={port} (want {bridge_port}){error}"
        )
    return lines


def find_relaunched_app(
    binary: Path,
    bridge_port: int,
    *,
    exclude_pid: int,
    not_before: float,
    processes: Optional[Iterable[psutil.Process]] = None,
) -> Optional[psutil.Process]:
    """The app process the instance on ``bridge_port`` relaunched, or ``None``.

    A match runs ``binary``, is not ``exclude_pid`` (the process that restarted
    itself), started no earlier than ``not_before`` (epoch seconds), and carries
    ``TERMIHUB_TEST_BRIDGE_PORT=<bridge_port>`` in its environment. Processes
    that vanish or deny access while being inspected are skipped.

    ``processes`` replaces the live process table (for tests); each entry needs
    ``pid``, ``exe()``, ``create_time()`` and ``environ()``.
    """
    candidates = processes if processes is not None else psutil.process_iter()
    wanted = str(bridge_port)
    for proc in candidates:
        try:
            if proc.pid == exclude_pid:
                continue
            if not _same_file(proc.exe(), binary):
                continue
            if proc.create_time() < not_before - _CREATE_TIME_SLACK:
                continue
            if proc.environ().get(BRIDGE_PORT_ENV) != wanted:
                continue
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue
        return proc
    return None
