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

**Evidence the current values rest on** (#3663: the ``[termihub-test-timing]``
lines of the System-Test Harness integration lane — 10 macOS, 10 Windows and
11 Linux jobs of system-integration.yml, 2026-09-30 → 2026-10-06 — plus the 30
serial display-critical jobs of the same runs; full table in the #3663 PR and in
``docs/testing.md`` → "Harness deadlines"). Only *completed* samples count
towards a max (the timing summary excludes expired ones), and ops that time out
because the feature is broken are left at their serial budget, not raised:

- ``APP_CONNECT``: app-connect max 15.1 s macOS / 13.6 s Windows / 3.3 s Linux
  on the 2-worker integration lane (p95 ≤ 7.2 s), 16.0 s on the serial Windows
  display lane. 2 × 16.0 → 35 s for every OS (was 60 s, sized from a 28.3 s
  Linux *class setup*, which includes more than the connect).
- **No blanket factor any more.** On a parallel macOS/Windows worker
  (:func:`contended`) an op keeps its serial budget unless its own contended
  max × ``HEADROOM`` exceeds it; those ops — and only those — are listed in
  :data:`CONTENDED_OP_DEADLINES` with the max they were sized from. Most are
  Windows shell starts and PTY round trips (ConPTY under two WebView2 apps);
  the same waits take ≤ 8.6 s on the serial Windows display lane.
- The two poll loops that bypass ``SystemTest.wait`` — the file-browser row
  wait (:data:`FILE_ROW_OP`) and the SSH host-key prompt loop
  (:data:`HOST_KEY_PROMPT_OP`) — record their own timing lines since #4216.
  They have no contended data yet, so they carry a *provisional* named
  deadline (:data:`PROVISIONAL_CONTENDED_OP_DEADLINES`) equal to the budget the
  retired 2× ``CONTENDED_UI_FACTOR`` gave them; re-size them from data once
  ≥10 macOS and ≥10 Windows integration-lane jobs carry their lines.

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
APP_CONNECT = 35.0
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

#: Op name of ``FilesUi.wait_for_file_row`` (its own poll loop, #4216). Matches
#: its ``timed out waiting for file row '<name>'`` message once normalised.
FILE_ROW_OP = "wait:file row '…'"
#: Op name of ``PasswordPromptUi.accept_host_key_prompt`` (its own poll loop, #4216).
HOST_KEY_PROMPT_OP = "wait:the SSH host-key prompt"

#: Provisional contended deadlines (seconds) for ops that record timing lines but
#: have **no contended samples yet** (#4216). Each is 2 × the call site's 20 s
#: default — exactly the budget the retired blanket ``CONTENDED_UI_FACTOR`` gave
#: it, so dropping the factor changes no effective budget. Re-size each from its
#: contended max × ``HEADROOM`` (or delete it if that fits the serial budget) once
#: ≥10 macOS and ≥10 Windows integration-lane jobs carry its timing lines.
PROVISIONAL_CONTENDED_OP_DEADLINES: dict[str, float] = {
    FILE_ROW_OP: 40.0,
    HOST_KEY_PROMPT_OP: 40.0,
}

#: Contended deadlines per op (seconds): the budget an op gets on a parallel
#: macOS/Windows worker, never below the call site's own serial budget. Each value
#: is the op's slowest completed contended sample × ``HEADROOM``, rounded up to
#: 5 s (#3663). An op not listed keeps its serial budget — its contended max ×
#: ``HEADROOM`` fits. Commands are checked against ``COMMAND`` (the smallest
#: serial budget a command can run under); waits against their call sites' budget.
CONTENDED_OP_DEADLINES: dict[str, float] = {
    # Windows shell start / output under ConPTY (serial display lane: ≤ 8.6 s).
    "wait:'…' in terminal output": 80.0,  # Windows max 39.1 s
    "wait:the shell prompt": 70.0,  # Windows max 34.4 s
    "wait:the terminal to report it exited": 70.0,  # Windows max 34.0 s
    "wait:the '…' row in the terminal buffer": 70.0,  # Windows max 33.3 s
    "wait:the active terminal's shell prompt": 65.0,  # Windows max 32.2 s
    "wait:the shell's echo of the composed line": 55.0,  # Windows max 27.5 s
    "wait:the PTY to report N rows x N cols": 55.0,  # Windows max 25.9 s
    "wait:the PTYSZN stty answer": 55.0,  # Windows max 25.9 s
    "wait:the DOM renderer to paint '…'": 50.0,  # Windows max 24.6 s
    "wait:the new terminal's shell prompt": 35.0,  # Windows max 15.3 s
    "wait:the restored terminals to reach a shell prompt": 25.0,  # Windows max 10.2 s
    # Webview-bound UI waits.
    "wait:connection '…'": 40.0,  # Windows max 19.2 s (p95 0.6 s)
    "wait:'…' in window '…'": 30.0,  # Windows max 13.2 s
    "wait:the editor status to populate": 25.0,  # macOS max 10.1 s
    # Bridge commands (serial budget COMMAND = 10 s).
    "command:projectionSubscribe": 40.0,  # Windows max 18.9 s
    "command:getState": 20.0,  # macOS max 8.6 s
    "command:click": 15.0,  # macOS max 5.3 s
    "command:screenshot": 15.0,  # macOS max 5.2 s
    # Unmeasured so far — see PROVISIONAL_CONTENDED_OP_DEADLINES.
    **PROVISIONAL_CONTENDED_OP_DEADLINES,
}

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
CONTENDED = contended()


def app_connect(seconds: float = APP_CONNECT) -> float:
    """Effective bridge-connect deadline. No slow category — sized absolutely."""
    return seconds * DEBUG_SCALE


def ui_budget(seconds: float, op: str) -> float:
    """Effective budget of a webview-bound op: a bridge command or a UI poll loop.

    ``op`` is the op's timing name (``command:<action>`` / ``wait:<label>``) — every
    caller records one, so there is no unnamed fallback (#4216). On a contended
    worker a listed op gets ``max(seconds, CONTENDED_OP_DEADLINES[op])``; an
    unlisted op keeps ``seconds``.
    """
    if CONTENDED:
        seconds = max(seconds, CONTENDED_OP_DEADLINES.get(op, 0.0))
    return seconds * DEBUG_SCALE
