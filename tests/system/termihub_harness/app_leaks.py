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
import weakref
from pathlib import Path
from typing import Iterable, Optional, Protocol

import psutil

from .relaunch import BRIDGE_PORT_ENV

#: Launch variable naming the pytest process (PID) that launched the app.
OWNER_ENV = "TERMIHUB_HARNESS_OWNER"

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
    except psutil.Error:
        port, created, config = "?", "?", "?"
    return f"pid={proc.pid} created={created} {BRIDGE_PORT_ENV}={port} config={config}"


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


def reap_leaks(where: str) -> list[str]:
    """Reap every leaked app; one report line per app (empty when none leaked)."""
    if not _ARMED:
        return []
    try:
        leaked = find_leaked_apps()
    except psutil.Error:
        return []
    lines = [
        f"[termihub-harness] app left running after {where}: {describe(proc)} (#5086)"
        for proc in leaked
    ]
    if leaked:
        reap(leaked)
    return lines
