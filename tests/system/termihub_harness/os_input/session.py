"""How the OS-input step meets its environment (#6148, TST-002 / TST-012).

- :func:`environment_refusal` tells an environment refusal — the same for every
  OS-input test: global input not allowed, another termiHub alive, a host that
  cannot inject — from a per-test miss. A calibration that found no window, or
  a foreign window in front at one moment, is a per-test miss: a cover is
  stepped around (#6143), never turned into a refusal.
- :func:`stop_on_environment_refusal` ends the session at the first refusal of
  an OS-input test, with one message naming the lane and the cause, instead of
  failing every test the same way (13 identical failures on 2026-11-27).
- :func:`close_leftover_dialogs` closes a native dialog (``#32770``,
  ``NSSavePanel``, a GTK chooser) a failed test left open, so it does not sit
  over the next test's window.
"""

from __future__ import annotations

import time
from typing import Any, Iterable, Optional

from .base import EnvironmentRefusal, OsInput

#: Test files of the OS-input step; a refusal elsewhere never stops a session.
OS_INPUT_TEST_PREFIX = "test_os_input_"
#: Skip-guard lanes of the OS-input step (``os-input-macos``, ``os-input-windows``).
OS_INPUT_LANE_PREFIX = "os-input"


def environment_refusal(exc: BaseException) -> Optional[str]:
    """The cause when ``exc`` is an environment refusal, else ``None``."""
    if isinstance(exc, EnvironmentRefusal):
        return str(exc) or type(exc).__name__
    return None


def stop_on_environment_refusal(item: Any, call: Any, *, lane: Optional[str]) -> bool:
    """Ask the session to stop after an OS-input test failed on an environment refusal.

    Sets ``item.session.shouldstop`` (pytest and pytest-xdist both end the run
    after the current test and print the reason), keeping a reason set earlier.
    Returns whether this call asked for the stop.
    """
    if OS_INPUT_TEST_PREFIX not in str(getattr(item, "nodeid", "")):
        return False
    # Only an OS-input session (or a local run without a lane) stops: Linux runs
    # these files inside its bulk lane, whose other suites must still run.
    if lane is not None and not lane.startswith(OS_INPUT_LANE_PREFIX):
        return False
    excinfo = getattr(call, "excinfo", None)
    if excinfo is None:
        return False
    cause = environment_refusal(excinfo.value)
    if cause is None or item.session.shouldstop:
        return False
    item.session.shouldstop = (
        f"{lane or 'os-input'} lane stopped: the environment refused OS input in "
        f"{item.nodeid}, and every later OS-input test would fail the same way: {cause}"
    )
    return True


def close_leftover_dialogs(
    osi: OsInput, baseline: Iterable[int], *, attempts: int = 2, settle: float = 2.0
) -> list[str]:
    """Close a native dialog of the test instance that is not in ``baseline``.

    Presses Escape into it (``dialog_key``) up to ``attempts`` times, waiting
    ``settle`` seconds after each, and returns what it closed. Never raises: it
    runs in teardown and must not mask the test's own failure.
    """
    known = set(baseline)
    try:
        if not osi.native_dialog_open(known):
            return []
        seen = [w.title or f"window {w.handle}" for w in osi.dialog_windows(known)] or ["a sheet"]
        for _ in range(attempts):
            osi.dialog_key("escape")
            if settle:
                time.sleep(settle)
            if not osi.native_dialog_open(known):
                return [f"{name} (PID {osi.pid})" for name in seen]
    except Exception:  # noqa: BLE001 - teardown never masks the test's failure
        return []
    return []
