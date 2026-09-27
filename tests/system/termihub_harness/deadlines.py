"""Per-operation harness deadlines, sized from observed CI timings (#3660, WA-CI-006).

This replaces the old global ``TERMIHUB_WAIT_SCALE=2`` that CI set on the
macOS/Windows legs, which doubled *every* budget: it hid genuinely slow
operations and made a real hang take twice as long to fail. Each deadline here
is instead named per operation, with an explicit slow category only where the
data shows one is needed.

**Headroom rule.** A deadline is at least ``HEADROOM`` × the largest duration
observed for that operation in CI (``scripts/system-test-timing.py`` summarises
the ``[termihub-test-timing]`` lines the harness prints; see :mod:`.timing`),
rounded up to 5 s, and never below the serial-tuned base. Never size a deadline
from a single fast run, and never below observed max × ``HEADROOM``.

**Evidence the current values rest on** (174 job logs of system-integration.yml
runs, 2026-09-05 → 2026-09-26; full tables in issue #3660 and its PR and in
``docs/testing.md`` → "Harness deadlines"):

- ``APP_CONNECT``: the slowest class setup (app launch + bridge connect) in a
  *passing* job was 28.3 s on Linux (``test_csp``), 18.5 s macOS, 10.2 s
  Windows — Linux was within 2 s of the old 30 s budget. 2 × 28.3 → 60 s, one
  value for every OS (it was already 60 s on macOS/Windows via the 2× scale).
- ``CONTENDED_UI_FACTOR`` (the only slow category): on the 2-worker xdist
  macOS/Windows bulk legs, UI poll loops and bridge commands hit their deadline
  5.8 (macOS) / 12.6 (Windows) times per job at 1× but 0.7 / 1.8 at 2× (then
  absorbed by ``--reruns``), incl. 3 Windows command timeouts at 10 s. The
  serial display-critical grades hit 0.4 / 1.2 per job at 1×, and those were
  the real scrollback losses (#2561/#2583) — so the factor applies only to a
  macOS/Windows process running as one of >1 xdist workers.

Per-op timing lines accumulate from every CI run now (:mod:`.timing`), so the
contended factor can be replaced by per-op values once enough runs exist.

**Local debugging override.** ``TERMIHUB_WAIT_SCALE`` still multiplies every
budget, but only outside CI — e.g. ``0.5`` to make a suspected hang fail fast,
or ``3`` on a slow VM. Under ``GITHUB_ACTIONS`` it is ignored (with a warning),
so no CI lane can reintroduce a global multiplier.
"""

from __future__ import annotations

import os
import sys
import warnings

#: Minimum ratio of a deadline to the largest observed duration of its op.
HEADROOM = 2.0

#: Bridge connect after an app launch (``Bridge.wait_for_app``). See module doc.
APP_CONNECT = 60.0
#: Default per-command bridge round trip (``Driver`` default request timeout).
COMMAND = 10.0
#: Command budget for the live-connect / SFTP suites (#2460). A 60 s budget lets a
#: webview that is merely slow under load finish, while a timeout at 60 s is strong
#: evidence of a real hang. Scoped via ``SystemTest.request_timeout``.
LIVE_COMMAND = 60.0
#: Default ``SystemTest.wait`` poll budget.
UI_WAIT = 20.0
#: Budget of a failure-artifact probe — outlives ``LIVE_COMMAND`` so evidence is
#: captured from a slow (not hung) webview (#2460).
DIAGNOSTIC_PROBE = 60.0

#: Slow category: webview-bound ops (bridge commands and UI poll loops) on a
#: macOS/Windows runner that is fanning apps across >1 xdist worker. Each worker
#: runs a full WKWebView / multi-process WebView2 app on a ~3–4 core runner, and
#: the JS thread is starved under that load (#2690). See module doc for the data.
CONTENDED_UI_FACTOR = 2.0
CONTENDED_OS = ("darwin", "win32")

_DEBUG_ENV = "TERMIHUB_WAIT_SCALE"


def _xdist_workers() -> int:
    try:
        return int(os.environ.get("PYTEST_XDIST_WORKER_COUNT", "1"))
    except ValueError:
        return 1


def contended(platform: str | None = None, workers: int | None = None) -> bool:
    """Whether this process is a parallel macOS/Windows worker (the slow category)."""
    platform = sys.platform if platform is None else platform
    workers = _xdist_workers() if workers is None else workers
    return workers > 1 and any(platform.startswith(p) for p in CONTENDED_OS)


def debug_scale(environ: dict | None = None) -> float:
    """The local-only ``TERMIHUB_WAIT_SCALE`` override (1.0 when unset or in CI).

    A non-positive or unparseable value falls back to 1.0 so a typo can never
    zero out a budget.
    """
    environ = os.environ if environ is None else environ
    raw = environ.get(_DEBUG_ENV)
    if raw is None:
        return 1.0
    if environ.get("GITHUB_ACTIONS") == "true":
        warnings.warn(
            f"{_DEBUG_ENV} is a local debugging knob and is ignored in CI (#3660)",
            stacklevel=2,
        )
        return 1.0
    try:
        scale = float(raw)
    except ValueError:
        return 1.0
    return scale if scale > 0 else 1.0


#: Resolved once at import (see :func:`debug_scale` / :func:`contended`).
DEBUG_SCALE = debug_scale()
UI_FACTOR = CONTENDED_UI_FACTOR if contended() else 1.0


def app_connect(seconds: float = APP_CONNECT) -> float:
    """Effective bridge-connect deadline. No slow category — sized absolutely."""
    return seconds * DEBUG_SCALE


def ui_budget(seconds: float) -> float:
    """Effective budget of a webview-bound op: a bridge command or a UI poll loop."""
    return seconds * UI_FACTOR * DEBUG_SCALE
