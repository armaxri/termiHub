"""Find and reap app processes a test left running (#5086).

A test app that outlives its test stays on the desktop, pinned always-on-top
(#957), for the rest of the job. The OS-input grades run in their own pytest
session after the bulk one (#5031), so a stray app from the bulk session sat
over their windows: a real click landed on it, it took the foreground between
the button's press and release, and every later grade missed its calibration.

Every app the harness launches (and every one-shot CLI run, which can fall
through to a full launch) carries :data:`OWNER_ENV` set to the PID of the
pytest process that launched it. A **leak** is a running process of the app
binary that carries this process's tag but belongs to no live
:class:`~termihub_harness.orchestrator.AppInstance`: neither its PID nor its
``TERMIHUB_TEST_BRIDGE_PORT`` is one a running instance holds.

The tag is what makes this safe: a process is only ever matched by the tag in
its own environment, never by its name alone, so a developer's own termiHub,
another checkout's test app or another xdist worker's app is never touched.
"""

from __future__ import annotations

import os
import tempfile
import time
import weakref
from pathlib import Path
from typing import Iterable, Optional, Protocol

import psutil

from .relaunch import BRIDGE_PORT_ENV

#: Launch variable naming the pytest process (PID) that launched the app.
OWNER_ENV = "TERMIHUB_HARNESS_OWNER"

#: Launch variable naming the test whose launch it was (pytest's own
#: ``PYTEST_CURRENT_TEST`` at that moment), for the report of a leak.
OWNER_TEST_ENV = "TERMIHUB_HARNESS_OWNER_TEST"

#: Prefix of the temp config dir the harness makes for each app it launches.
CONFIG_DIR_PREFIX = "termihub-app-config-"

#: Where this checkout's app binaries are built (a symlink is followed).
TARGET_DIR = Path(__file__).resolve().parents[3] / "target"

#: Executable stem of the app binary on every OS (``termihub``, ``termihub.exe``,
#: the macOS bundle's ``termiHub``). Only a cheap pre-filter; the tag decides.
APP_STEM = "termihub"


class _Tracked(Protocol):
    @property
    def pid(self) -> Optional[int]: ...

    def tracked_bridge_port(self) -> Optional[int]: ...


_INSTANCES: "weakref.WeakSet[_Tracked]" = weakref.WeakSet()
#: Whether this process ever launched a tagged app; until then there is nothing
#: to look for, so the per-test check costs nothing in the machinery lanes.
_ARMED = False


def owner_tag() -> str:
    """This process's tag (its PID), as set in :data:`OWNER_ENV`."""
    return str(os.getpid())


def launch_tag() -> str:
    """:func:`owner_tag` for a launch environment; arms :func:`reap_leaks`."""
    global _ARMED
    _ARMED = True
    return owner_tag()


def launch_env() -> dict[str, str]:
    """The launch variables that name this session and the running test."""
    return {
        OWNER_ENV: launch_tag(),
        OWNER_TEST_ENV: os.environ.get("PYTEST_CURRENT_TEST", "outside a test"),
    }


def register(instance: _Tracked) -> None:
    """Track ``instance``: its running app is never a leak."""
    _INSTANCES.add(instance)


def _live() -> tuple[set[int], set[str]]:
    pids: set[int] = set()
    ports: set[str] = set()
    for instance in list(_INSTANCES):
        pid = instance.pid
        port = instance.tracked_bridge_port()
        if pid is not None:
            pids.add(pid)
        if port is not None:
            ports.add(str(port))
    return pids, ports


def _is_app(proc: psutil.Process) -> bool:
    return Path(proc.name()).stem.lower() == APP_STEM


def find_leaked_apps(
    processes: Optional[Iterable[psutil.Process]] = None,
    *,
    owner: Optional[str] = None,
    live_pids: Optional[set[int]] = None,
    live_ports: Optional[set[str]] = None,
) -> list[psutil.Process]:
    """App processes tagged with ``owner`` (default: this process) that no live
    instance tracks. ``processes`` and the live sets replace the real ones in tests.
    """
    owner = owner or owner_tag()
    if live_pids is None or live_ports is None:
        pids, ports = _live()
        live_pids = pids if live_pids is None else live_pids
        live_ports = ports if live_ports is None else live_ports
    candidates = processes if processes is not None else psutil.process_iter()
    leaked = []
    for proc in candidates:
        try:
            if proc.pid in live_pids or not _is_app(proc):
                continue
            env = proc.environ()
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue
        if env.get(OWNER_ENV) != owner:
            continue
        if env.get(BRIDGE_PORT_ENV) in live_ports:
            continue  # e.g. a self-relaunch its instance has not adopted yet
        leaked.append(proc)
    return leaked


def describe(proc: psutil.Process) -> str:
    """One line naming a leaked process (for the report)."""
    try:
        env = proc.environ()
        port = env.get(BRIDGE_PORT_ENV, "<none: a CLI run>")
        created = f"{proc.create_time():.1f}"
        config = env.get("TERMIHUB_CONFIG_DIR", "?")
        test = env.get(OWNER_TEST_ENV, "?")
    except psutil.Error:
        port, created, config, test = "?", "?", "?", "?"
    return (
        f"pid={proc.pid} created={created} {BRIDGE_PORT_ENV}={port} config={config} "
        f"launched by {test}"
    )


def reap(procs: list[psutil.Process], timeout: float = 5.0) -> None:
    """Terminate each leaked app with its process tree, escalating to a kill."""
    victims: list[psutil.Process] = []
    for proc in procs:
        try:
            victims.extend(proc.children(recursive=True))
        except psutil.Error:
            pass
        victims.append(proc)
    for proc in victims:
        try:
            proc.terminate()
        except psutil.Error:
            pass
    _, alive = psutil.wait_procs(victims, timeout=timeout)
    for proc in alive:
        try:
            proc.kill()
        except psutil.Error:
            pass


def reap_leaks(where: str, *, session_over: bool = False) -> list[str]:
    """Reap every leaked app; one report line per app (empty when none leaked).

    ``session_over``: no instance is live any more, so every app of this process
    is a leak, one whose teardown never ran included (#6046).
    """
    if not _ARMED:
        return []
    nothing_live: dict = {"live_pids": set(), "live_ports": set()} if session_over else {}
    try:
        leaked = find_leaked_apps(**nothing_live)
    except psutil.Error:
        return []
    lines = [
        f"[termihub-harness] app left running after {where}: {describe(proc)} (#5086)"
        for proc in leaked
    ]
    if leaked:
        reap(leaked)
    return lines


# ── Foreign apps on the desktop (#5467) ──────────────────────────────────────
#: How long (s) the OS-input guard waits for a foreign app to finish exiting
#: (an app the previous test stopped can still be tearing down).
FOREIGN_EXIT_WAIT = 10.0


def find_foreign_apps(
    allowed_pids: Iterable[int],
    processes: Optional[Iterable[psutil.Process]] = None,
    *,
    live_pids: Optional[set[int]] = None,
    live_ports: Optional[set[str]] = None,
) -> list[psutil.Process]:
    """Every running app process that is neither allowed nor this process's own.

    Unlike :func:`find_leaked_apps` this matches **any** owner, untagged apps
    included: it is read-only and only feeds the OS-input grades' refusal to
    run (#5467). Global OS input goes to whatever window is in front, and every
    test app is pinned always-on-top at the same spot (#957), so *any* other
    termiHub on the desktop — a leaked app of an earlier session, a parallel
    xdist worker's app, an installed termiHub — can take the input. An app of a
    live instance of this process (or its unadopted relaunch) is the test's own.
    """
    allowed = set(allowed_pids)
    if live_pids is None or live_ports is None:
        pids, ports = _live()
        live_pids = pids if live_pids is None else live_pids
        live_ports = ports if live_ports is None else live_ports
    candidates = processes if processes is not None else psutil.process_iter()
    foreign = []
    for proc in candidates:
        try:
            if proc.pid in allowed or proc.pid in live_pids or not _is_app(proc):
                continue
        except psutil.Error:
            continue  # gone, or a protected process whose name is unreadable
        try:
            env = proc.environ()
        except (psutil.NoSuchProcess, psutil.ZombieProcess):
            continue
        except psutil.AccessDenied:
            env = {}
        if env.get(OWNER_ENV) == owner_tag() and env.get(BRIDGE_PORT_ENV) in live_ports:
            continue  # this process's unadopted self-relaunch
        foreign.append(proc)
    return foreign


def _owner_gone(tag: str, app_created: Optional[float]) -> bool:
    """Whether the pytest process ``tag`` is over (its PID free, or reused since)."""
    try:
        owner = psutil.Process(int(tag))
        return app_created is not None and owner.create_time() > app_created
    except psutil.NoSuchProcess:
        return True
    except psutil.Error:
        return False  # there, but not readable: not proven gone


def _owner_state(tag: Optional[str], app_created: Optional[float]) -> str:
    if tag is None:
        return "untagged: not launched by the harness (an installed termiHub?)"
    if tag == owner_tag():
        return f"owner={tag} (this pytest process; no live instance tracks it)"
    if not tag.isdecimal():
        return f"owner={tag} (not a PID)"
    if _owner_gone(tag, app_created):
        return f"owner={tag} (gone: leaked by an earlier pytest session or a crashed worker)"
    return f"owner={tag} (alive: another pytest process, e.g. a parallel xdist worker)"


def describe_foreign(proc: psutil.Process) -> str:
    """One line naming a foreign app: PID, who launched it and whether they still run."""
    try:
        env = proc.environ()
    except psutil.Error:
        env = {}
    try:
        created: Optional[float] = proc.create_time()
    except psutil.Error:
        created = None
    try:
        exe = proc.exe()
    except psutil.Error:
        exe = "?"
    owner = _owner_state(env.get(OWNER_ENV), created)
    port = env.get(BRIDGE_PORT_ENV, "<none>")
    config = env.get("TERMIHUB_CONFIG_DIR", "?")
    test = env.get(OWNER_TEST_ENV, "?")
    when = f"{created:.1f}" if created is not None else "?"
    return (
        f"pid={proc.pid} exe={exe} created={when} {owner} "
        f"{BRIDGE_PORT_ENV}={port} config={config} launched by {test}"
    )


# ── Our own leaked instances (#6046) ─────────────────────────────────────────
#: One line per app :func:`end_leaks_of_gone_sessions` ended in this process.
ENDED_LEAKS: list[str] = []


def is_leak_of_a_gone_session(proc: psutil.Process) -> bool:
    """Whether ``proc`` is provably a test app that a finished session left behind.

    All of it must hold, read from the process itself: the app binary, run from
    this checkout's ``target/``; tagged by a pytest process that is over; a test
    bridge port; and a config dir the harness made. An installed termiHub, a
    developer's build, another checkout's app or a running session's fails at
    least one, and whatever cannot be read counts as not ours.
    """
    try:
        if not _is_app(proc):
            return False
        env = proc.environ()
        exe = os.path.realpath(proc.exe())
        created = proc.create_time()
    except (psutil.Error, OSError):
        return False
    tag = env.get(OWNER_ENV, "")
    if not tag.isdecimal() or tag == owner_tag() or not _owner_gone(tag, created):
        return False
    if not env.get(BRIDGE_PORT_ENV, "").isdecimal():
        return False
    config = os.path.realpath(env.get("TERMIHUB_CONFIG_DIR") or os.curdir)
    in_temp = os.path.dirname(config) == os.path.realpath(tempfile.gettempdir())
    if not in_temp or not os.path.basename(config).startswith(CONFIG_DIR_PREFIX):
        return False
    target = os.path.realpath(TARGET_DIR)
    try:
        return bool(exe) and os.path.commonpath([exe, target]) == target
    except ValueError:  # another drive (Windows)
        return False


def end_leaks_of_gone_sessions(
    allowed_pids: Iterable[int] = (),
    processes: Optional[Iterable[psutil.Process]] = None,
    *,
    end=reap,
) -> list[str]:
    """End every :func:`is_leak_of_a_gone_session`, by its process handle.

    Returns (and keeps in :data:`ENDED_LEAKS`) one line per app, naming the test
    that launched it. Nothing else is touched.
    """
    allowed = set(allowed_pids)
    candidates = processes if processes is not None else psutil.process_iter()
    leaked = [p for p in candidates if p.pid not in allowed and is_leak_of_a_gone_session(p)]
    lines = [describe_foreign(proc) for proc in leaked]
    if leaked:
        end(leaked)
        ENDED_LEAKS.extend(lines)
    return lines


def wait_for_foreign_apps(
    allowed_pids: Iterable[int],
    timeout: float = FOREIGN_EXIT_WAIT,
    *,
    find=find_foreign_apps,
    poll: float = 0.25,
) -> list[str]:
    """Wait up to ``timeout`` for every foreign app to exit; describe the rest.

    Empty when the desktop belongs to the allowed PIDs alone. Read-only: a
    foreign app is never touched, only named.
    """
    allowed = set(allowed_pids)
    deadline = time.monotonic() + timeout
    while True:
        try:
            foreign = find(allowed)
        except psutil.Error:
            foreign = []
        if not foreign:
            return []
        if time.monotonic() >= deadline:
            return [describe_foreign(proc) for proc in foreign]
        time.sleep(poll)


def describe_app_pid(pid: int) -> str:
    """:func:`describe_foreign` for ``pid`` when it is a termiHub app; else empty."""
    try:
        proc = psutil.Process(pid)
        if not _is_app(proc):
            return ""
    except psutil.Error:
        return ""
    return describe_foreign(proc)
