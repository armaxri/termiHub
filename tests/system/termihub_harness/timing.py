"""Per-operation timing recorder for the harness chokepoints (#3660, WA-CI-006).

Every harness deadline is sized from observed timings (see :mod:`.deadlines`),
so the harness records how long each operation actually took:

- ``app-connect`` — :meth:`Bridge.wait_for_app` (until a launched app's bridge
  client connects);
- ``command:<action>`` — one bridge round trip in :meth:`Driver._call`;
- ``wait:<label>`` — one :meth:`SystemTest.wait` poll loop, labelled by its
  ``what=`` description with the dynamic parts collapsed.

Recording is always on and cheap (a list append per operation). The summary is
printed when :func:`enabled` (always in CI, locally with ``TERMIHUB_TEST_TIMING=1``):
one ``[termihub-test-timing] {json}`` line per operation at session end,
which ``scripts/system-test-timing.py`` aggregates across runs. Under
pytest-xdist each worker hands its samples to the controller (see ``conftest``),
so the summary covers the whole run.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
import threading
from typing import Iterable, Optional

TIMING_TAG = "[termihub-test-timing]"

_lock = threading.Lock()
#: ``{op: [[elapsed, deadline, timed_out], …]}`` — plain lists so the payload
#: crosses the xdist worker → controller channel (execnet) unchanged.
_samples: dict[str, list[list]] = {}


def enabled(environ: Optional[dict] = None) -> bool:
    """Whether the session-end summary is printed.

    On by default in CI (``GITHUB_ACTIONS=true``) so every run — including the
    scheduled nightly, whose workflow file lives on ``main`` — feeds the timing
    data; locally only with ``TERMIHUB_TEST_TIMING=1``. ``TERMIHUB_TEST_TIMING=0``
    turns it off either way.
    """
    environ = os.environ if environ is None else environ
    flag = environ.get("TERMIHUB_TEST_TIMING", "").lower()
    if flag in ("0", "false", "no"):
        return False
    return flag in ("1", "true", "yes") or environ.get("GITHUB_ACTIONS") == "true"


def os_name(platform: Optional[str] = None) -> str:
    """``linux`` / ``macos`` / ``windows`` for the timing records."""
    platform = sys.platform if platform is None else platform
    if platform.startswith("darwin"):
        return "macos"
    if platform.startswith("win"):
        return "windows"
    return "linux" if platform.startswith("linux") else platform


def wait_label(what: str) -> str:
    """Collapse the dynamic parts of a ``wait(what=…)`` label into an op name.

    Mirrors ``normalize_label`` in ``scripts/system-test-timing.py`` so an op's
    timing line and its timeout message group under the same name.
    """
    label = re.sub(r"'[^']*'", "'…'", what)
    label = re.sub(r'"[^"]*"', '"…"', label)
    label = re.sub(r"\d+", "N", label)
    return "wait:" + label.strip()[:80]


def record(op: str, elapsed: float, deadline: float, *, timed_out: bool = False) -> None:
    """Record one completed (or expired) operation."""
    with _lock:
        _samples.setdefault(op, []).append([float(elapsed), float(deadline), bool(timed_out)])


def snapshot() -> dict[str, list[list]]:
    """A copy of every recorded sample (for the xdist worker hand-off)."""
    with _lock:
        return {op: [list(s) for s in samples] for op, samples in _samples.items()}


def merge(samples: dict[str, list[list]]) -> None:
    """Fold another process's :func:`snapshot` into this one (controller side)."""
    with _lock:
        for op, rows in samples.items():
            _samples.setdefault(op, []).extend(list(row) for row in rows)


def reset() -> None:
    """Drop every sample (unit tests)."""
    with _lock:
        _samples.clear()


def _nearest_rank(ordered: list[float], pct: float) -> float:
    return ordered[max(1, math.ceil(pct / 100.0 * len(ordered))) - 1]


def summarize(os_name: Optional[str] = None) -> list[dict]:
    """One summary record per op: ``n``/``p50``/``p95``/``max``/``deadline``/``timeouts``.

    ``deadline`` is the largest budget the op ran under; ``max`` covers only the
    samples that completed, so an expired op does not masquerade as a timing.
    """
    records = []
    with _lock:
        items = sorted(_samples.items())
    for op, rows in items:
        done = sorted(r[0] for r in rows if not r[2])
        entry = {
            "op": op,
            "n": len(rows),
            "timeouts": sum(1 for r in rows if r[2]),
            "deadline": round(max(r[1] for r in rows), 2),
        }
        if done:
            entry.update(
                p50=round(_nearest_rank(done, 50), 3),
                p95=round(_nearest_rank(done, 95), 3),
                max=round(done[-1], 3),
            )
        else:
            entry.update(p50=None, p95=None, max=None)
        if os_name:
            entry["os"] = os_name
        records.append(entry)
    return records


def format_lines(records: Iterable[dict]) -> list[str]:
    """``[termihub-test-timing] {json}`` lines for :func:`summarize` records."""
    return [f"{TIMING_TAG} {json.dumps(r, ensure_ascii=False, sort_keys=True)}" for r in records]
