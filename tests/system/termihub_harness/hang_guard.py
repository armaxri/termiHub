"""Per-phase hang guard for xdist workers (#4017).

A wait in the harness is always bounded, but a *blocking* call is not: a pipe
``close()`` that waits for an orphaned writer, a socket ``recv`` with no
timeout, a subprocess with no ``timeout=``. One such hang on 2026-10-06 froze
the macOS integration lane from minute 14 until the job's 120-minute ceiling
cancelled it — no failure, no traceback, nothing but "The operation was
canceled", and every later suite unrun.

This guard arms a watchdog around each test phase (setup / call / teardown)
with a generous per-phase budget. When a phase overruns it, the worker dumps
every thread's stack into
``tests/system/artifacts/hang-tracebacks/<worker>-<pid>.txt`` (uploaded with the
failure artifacts), kills its child processes (the apps it launched, so no
orphaned always-on-top window outlives it), and exits. pytest-xdist then reports
"worker crashed while running <test>" — a red, attributed failure instead of a
silent stall — starts a replacement worker, and the rest of the lane still runs.
The watchdog is a Python timer thread (blocking syscalls release the GIL), with
:func:`faulthandler.dump_traceback_later` as a C-level backstop shortly after it
in case the interpreter itself is wedged.

It is armed only on xdist workers (a replacement worker picks up the remaining
tests; exiting a plain, unsharded run would end it), unless forced with
``TERMIHUB_TEST_HANG_GUARD=1``; ``TERMIHUB_TEST_HANG_GUARD=0`` disables it. The
budgets sit far above any legitimate phase: the slowest setup builds the
deployed-agent binary (up to 25 min, ``stage_remote_agent_binary``) plus image
builds; the slowest observed test bodies take a few minutes.
"""

from __future__ import annotations

import faulthandler
import os
import threading
from pathlib import Path
from typing import IO, Mapping, Optional

import psutil

#: Env switch: ``1`` forces the guard on, ``0`` turns it off, unset = auto
#: (on for xdist workers only).
GUARD_ENV = "TERMIHUB_TEST_HANG_GUARD"

#: Per-phase budget in seconds. Overridable per phase with
#: ``TERMIHUB_TEST_HANG_<PHASE>_SECONDS`` (e.g. ``…_CALL_SECONDS=1200``).
DEFAULT_BUDGETS: dict[str, float] = {
    # Session fixtures run inside the first test's setup: the deployed-agent
    # cross-build (1500 s ceiling) plus compose image builds (300 s each).
    "setup": 2700.0,
    "call": 900.0,
    # Class teardown stops the app (5 s terminate + 5 s kill + pump join).
    "teardown": 300.0,
}

#: Seconds after the Python watchdog that the faulthandler backstop fires.
BACKSTOP_GRACE = 60.0

_DISABLED = ("0", "false", "no", "off")
_ENABLED = ("1", "true", "yes", "on")

_stream: Optional[IO[str]] = None
_stream_path: Optional[Path] = None
_timer: Optional[threading.Timer] = None


def enabled(env: Mapping[str, str] = os.environ) -> bool:
    """Whether the guard should arm in this process (see the module note)."""
    value = env.get(GUARD_ENV, "").strip().lower()
    if value in _DISABLED:
        return False
    if value in _ENABLED:
        return True
    return bool(env.get("PYTEST_XDIST_WORKER"))


def budget(phase: str, env: Mapping[str, str] = os.environ) -> float:
    """The budget in seconds for ``phase``, honoring the env override."""
    default = DEFAULT_BUDGETS.get(phase, DEFAULT_BUDGETS["call"])
    raw = env.get(f"TERMIHUB_TEST_HANG_{phase.upper()}_SECONDS")
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def traceback_path(artifact_root: Path, env: Mapping[str, str] = os.environ) -> Path:
    """Where this worker's hang tracebacks go."""
    worker = env.get("PYTEST_XDIST_WORKER") or "main"
    return artifact_root / "hang-tracebacks" / f"{worker}-{os.getpid()}.txt"


def arm(phase: str, artifact_root: Path) -> None:
    """Start the ``phase`` watchdog (replacing any previous one)."""
    global _stream, _stream_path, _timer
    disarm()
    if _stream is None:
        _stream_path = traceback_path(artifact_root)
        _stream_path.parent.mkdir(parents=True, exist_ok=True)
        _stream = open(_stream_path, "a", encoding="utf-8")  # noqa: SIM115 - kept open for faulthandler
    seconds = budget(phase)
    _timer = threading.Timer(seconds, _fire, args=(phase, seconds))
    _timer.daemon = True
    _timer.start()
    faulthandler.dump_traceback_later(seconds + BACKSTOP_GRACE, exit=True, file=_stream)


def disarm() -> None:
    """Cancel the pending watchdog, if any."""
    global _timer
    if _timer is not None:
        _timer.cancel()
        _timer = None
    faulthandler.cancel_dump_traceback_later()


def _fire(phase: str, seconds: float) -> None:
    """The phase overran: dump all stacks, kill child processes, exit the worker."""
    stream = _stream
    try:
        if stream is not None:
            stream.write(
                f"[hang-guard] the {phase} phase exceeded {seconds:.0f}s: dumping all "
                "thread stacks, killing child processes, exiting the worker (#4017)\n"
            )
            stream.flush()
            faulthandler.dump_traceback(file=stream, all_threads=True)
            stream.flush()
    except (OSError, ValueError):
        pass
    kill_child_processes()
    os._exit(1)


def kill_child_processes(timeout: float = 3.0) -> None:
    """Terminate, then kill, every descendant of this process (best effort)."""
    try:
        children = psutil.Process().children(recursive=True)
    except psutil.Error:
        return
    for child in children:
        try:
            child.terminate()
        except psutil.Error:
            pass
    _, alive = psutil.wait_procs(children, timeout=timeout)
    for child in alive:
        try:
            child.kill()
        except psutil.Error:
            pass


def close() -> None:
    """Disarm and close the traceback file, deleting it when nothing was written."""
    global _stream, _stream_path
    disarm()
    if _stream is None:
        return
    try:
        _stream.close()
        if _stream_path is not None and _stream_path.stat().st_size == 0:
            _stream_path.unlink()
            try:
                _stream_path.parent.rmdir()  # only succeeds when empty
            except OSError:
                pass
    except OSError:
        pass
    _stream = None
    _stream_path = None
