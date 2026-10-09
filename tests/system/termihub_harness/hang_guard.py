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

Before it kills anything the guard records what a hang post-mortem needs
(#4315): the hung test's node id, every running process (this worker's
descendants with their command lines, then the busiest processes on the host),
and — through the ``on_hang`` callback the conftest passes — the app's failure
bundle (state, terminal, a screenshot over the bridge if it still answers) and
the tail of the app log. The callback runs on its own thread under
:data:`ON_HANG_BUDGET`, so a wedged bridge cannot stop the kill.

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
from typing import IO, Callable, Mapping, Optional

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

#: Seconds the ``on_hang`` diagnostics callback may take before the guard gives
#: up on it and kills anyway (bridge probes inside it use a shorter timeout).
ON_HANG_BUDGET = 90.0

#: Seconds after the Python watchdog that the faulthandler backstop fires. Must
#: exceed :data:`ON_HANG_BUDGET` so the diagnostics get their chance.
BACKSTOP_GRACE = ON_HANG_BUDGET + 60.0

#: How many of the host's busiest processes the dump lists.
TOP_PROCESSES = 25

_DISABLED = ("0", "false", "no", "off")
_ENABLED = ("1", "true", "yes", "on")

_stream: Optional[IO[str]] = None
_stream_path: Optional[Path] = None
_timer: Optional[threading.Timer] = None
_nodeid: Optional[str] = None
_on_hang: Optional[Callable[[], Optional[str]]] = None


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


def arm(
    phase: str,
    artifact_root: Path,
    *,
    nodeid: Optional[str] = None,
    on_hang: Optional[Callable[[], Optional[str]]] = None,
) -> None:
    """Start the ``phase`` watchdog (replacing any previous one).

    ``nodeid`` names the test in the dump; ``on_hang`` is called (bounded by
    :data:`ON_HANG_BUDGET`) when the phase overruns, before anything is killed,
    and whatever text it returns is appended to the dump.
    """
    global _stream, _stream_path, _timer, _nodeid, _on_hang
    disarm()
    _nodeid = nodeid
    _on_hang = on_hang
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
    global _timer, _nodeid, _on_hang
    _nodeid = None
    _on_hang = None
    if _timer is not None:
        _timer.cancel()
        _timer = None
    faulthandler.cancel_dump_traceback_later()


def _fire(phase: str, seconds: float) -> None:
    """The phase overran: dump stacks and diagnostics, kill children, exit."""
    stream = _stream
    _write(
        stream,
        f"[hang-guard] the {phase} phase of {_nodeid or '<unknown test>'} exceeded "
        f"{seconds:.0f}s: dumping all thread stacks and diagnostics, killing child "
        "processes, exiting the worker (#4017, #4315)\n",
    )
    try:
        if stream is not None:
            faulthandler.dump_traceback(file=stream, all_threads=True)
            stream.flush()
    except (OSError, ValueError):
        pass
    _write(stream, describe_processes())
    _write(stream, run_on_hang(_on_hang))
    kill_child_processes()
    os._exit(1)


def _write(stream: Optional[IO[str]], text: str) -> None:
    if stream is None or not text:
        return
    try:
        stream.write(text if text.endswith("\n") else text + "\n")
        stream.flush()
    except (OSError, ValueError):
        pass


def run_on_hang(
    callback: Optional[Callable[[], Optional[str]]], budget: float = ON_HANG_BUDGET
) -> str:
    """Run the diagnostics ``callback`` on its own thread, bounded by ``budget``.

    Returns the text for the dump: the callback's result, its error, or a note
    that it overran (the guard then proceeds to the kill regardless).
    """
    if callback is None:
        return ""
    result: list[str] = []

    def target() -> None:
        try:
            result.append(callback() or "")
        except Exception as exc:  # noqa: BLE001 - diagnostics must never raise
            result.append(f"[hang-guard] diagnostics failed: {exc!r}")

    worker = threading.Thread(target=target, name="hang-guard-diagnostics", daemon=True)
    worker.start()
    worker.join(budget)
    if worker.is_alive():
        return f"[hang-guard] diagnostics still running after {budget:.0f}s; giving up"
    return "[hang-guard] diagnostics:\n" + (result[0] if result else "")


def _process_line(proc: "psutil.Process") -> str:
    try:
        info = proc.as_dict(attrs=["pid", "ppid", "name", "status", "cmdline", "cpu_times"])
    except psutil.Error as exc:
        return f"  <pid {getattr(proc, 'pid', '?')}: {exc}>"
    times = info.get("cpu_times")
    cpu = f"{times.user + times.system:.1f}s" if times else "?"
    cmdline = " ".join(info.get("cmdline") or []) or info.get("name") or "?"
    return (
        f"  pid={info.get('pid')} ppid={info.get('ppid')} status={info.get('status')} "
        f"cpu={cpu} {cmdline[:300]}"
    )


def describe_processes(top: int = TOP_PROCESSES) -> str:
    """This worker's descendants, then the host's ``top`` busiest processes by
    cumulative CPU time — what was running when the phase hung."""
    lines = ["[hang-guard] descendants of this worker:"]
    try:
        children = psutil.Process().children(recursive=True)
    except psutil.Error as exc:
        children = []
        lines.append(f"  <unavailable: {exc}>")
    lines.extend(_process_line(child) for child in children)
    if not children:
        lines.append("  (none)")
    lines.append(f"[hang-guard] top {top} processes on the host by CPU time:")
    ranked = []
    for proc in psutil.process_iter():
        try:
            times = proc.cpu_times()
            ranked.append((times.user + times.system, proc))
        except psutil.Error:
            continue
    ranked.sort(key=lambda pair: pair[0], reverse=True)
    lines.extend(_process_line(proc) for _, proc in ranked[:top])
    return "\n".join(lines) + "\n"


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
