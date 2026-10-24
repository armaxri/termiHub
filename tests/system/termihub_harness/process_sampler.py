"""Memory and responsiveness sampling of the app under test, by PID (#4931).

MT-LOCAL-32 used to ask the operator to watch the app in the OS task manager
during an output flood. This samples the same thing: the resident memory of
the test app **and its WebView processes**, found from the app's own PID only
(never by app name — the maintainer runs the harness inside an installed
termiHub, whose processes must never be read or touched):

* **Linux** (WebKitGTK) and **Windows** (WebView2): the web and GPU processes
  are descendants of the app, so ``children(recursive=True)`` finds them.
* **macOS** (WKWebView): the ``com.apple.WebKit.*`` XPC services are children
  of launchd, not of the app. Each one's *responsible* process is the client
  that asked for it, read with ``responsibility_get_pid_responsible_for_pid``
  from libSystem (no root needed). A service counts when the app itself is
  responsible for it — or, for an unbundled debug binary that inherits its
  parent's responsibility, when it shares the app's responsible process and was
  started after the app (so an installed app's older services are excluded).

The statistics helpers are pure and unit-tested in the normal lane
(``tests/test_process_sampler.py``).
"""

from __future__ import annotations

import ctypes
import math
import statistics
import sys
import time
from dataclasses import dataclass, field
from typing import Callable, Iterable, Optional, Sequence

import psutil

#: Name prefix of macOS WebKit XPC services (WebContent, GPU, Networking).
MACOS_WEBKIT_PREFIX = "com.apple.WebKit."

_GONE = (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess)


def responsible_pid(pid: int) -> Optional[int]:
    """macOS: the PID responsible for ``pid`` (``None`` elsewhere or on error)."""
    if sys.platform != "darwin":
        return None
    try:
        lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
        func = lib.responsibility_get_pid_responsible_for_pid
    except (OSError, AttributeError):
        return None
    func.argtypes = [ctypes.c_int]
    func.restype = ctypes.c_int
    result = func(pid)
    return result if result > 0 else None


def attribute_webkit_services(
    app_pid: int,
    app_started: float,
    candidates: Iterable[tuple[int, str, float]],
    responsible: Callable[[int], Optional[int]],
) -> list[int]:
    """PIDs of the macOS WebKit services that belong to the app at ``app_pid``.

    ``candidates`` are ``(pid, name, create_time)`` triples; ``responsible``
    maps a PID to its responsible PID. Pure, so the rule is unit-tested.
    """
    app_responsible = responsible(app_pid)
    owned: list[int] = []
    for pid, name, created in candidates:
        if not name.startswith(MACOS_WEBKIT_PREFIX):
            continue
        owner = responsible(pid)
        if owner == app_pid:
            owned.append(pid)
        elif (
            owner is not None
            and app_responsible not in (None, app_pid)
            and owner == app_responsible
            and created >= app_started
        ):
            owned.append(pid)
    return owned


@dataclass(frozen=True)
class MemorySample:
    """One reading of the app's process tree."""

    at: float
    """``time.monotonic()`` of the reading."""
    rss: int
    """Summed resident set size in bytes."""
    processes: dict[int, str] = field(default_factory=dict)
    """PID → name of every process that was summed."""


class ProcessTreeSampler:
    """Sum the RSS of the app at ``pid`` and its WebView processes."""

    def __init__(self, pid: int) -> None:
        self.app = psutil.Process(pid)
        self._started = self.app.create_time()

    def processes(self) -> list[psutil.Process]:
        """The app plus its WebView processes, rediscovered on every call."""
        found = [self.app]
        try:
            found.extend(self.app.children(recursive=True))
        except _GONE:
            pass
        if sys.platform == "darwin":
            known = {p.pid for p in found}
            candidates = []
            for proc in psutil.process_iter(["pid", "name", "create_time"]):
                info = proc.info
                if info["pid"] not in known and info["name"]:
                    candidates.append((info["pid"], info["name"], info["create_time"] or 0.0))
            for pid in attribute_webkit_services(
                self.app.pid, self._started, candidates, responsible_pid
            ):
                try:
                    found.append(psutil.Process(pid))
                except _GONE:
                    continue
        return found

    def sample(self) -> MemorySample:
        """Read every process's RSS now; vanished processes are skipped."""
        total = 0
        names: dict[int, str] = {}
        for proc in self.processes():
            try:
                total += proc.memory_info().rss
                names[proc.pid] = proc.name()
            except _GONE:
                continue
        return MemorySample(at=time.monotonic(), rss=total, processes=names)

    def webview_process_count(self) -> int:
        """How many processes besides the app itself are being summed."""
        return len(self.processes()) - 1


# ── Statistics (pure) ─────────────────────────────────────────────────────────


def percentile(values: Sequence[float], pct: float) -> float:
    """The ``pct`` percentile (0–100) by nearest rank; ``0.0`` for no values."""
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = max(1, min(len(ordered), math.ceil(pct / 100 * len(ordered))))
    return ordered[rank - 1]


def windowed_growth(
    samples: Sequence[MemorySample], *, window: float
) -> tuple[int, int, int]:
    """``(start_median, end_median, growth)`` in bytes over a sample series.

    Compares the median RSS of the first ``window`` seconds with that of the
    last ``window`` seconds, so a single GC spike or a transient allocation does
    not decide the grade. Needs samples spanning more than ``2 * window``.
    """
    if not samples:
        raise ValueError("no samples")
    first_at = samples[0].at
    last_at = samples[-1].at
    if last_at - first_at <= 2 * window:
        raise ValueError(
            f"samples span {last_at - first_at:.1f}s, need more than {2 * window:.1f}s"
        )
    head = [s.rss for s in samples if s.at - first_at <= window]
    tail = [s.rss for s in samples if last_at - s.at <= window]
    start = int(statistics.median(head))
    end = int(statistics.median(tail))
    return start, end, end - start


def mib(value: float) -> float:
    """Bytes → MiB."""
    return value / (1024 * 1024)
