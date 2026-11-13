"""Hover an element for a product-run grade and its screenshot (#5538).

Two ways, best first:

1. **The real OS pointer** (:mod:`termihub_harness.os_input`), when global input
   is allowed (a GitHub runner, or the runner's ``--real-pointer`` opt-in that
   sets ``TERMIHUB_OS_INPUT_GLOBAL=1``). It keeps the whole os-input safety
   contract: the target is the test instance's PID, calibration refuses while
   any other termiHub process is alive (the installed app included), and every
   pointer event first checks that the test window is frontmost.
2. **A forced hover through the bridge** (the ``forceHover`` verb): the app's
   own ``:hover`` rules are applied by attribute, so the browser paints and
   computes the hovered look — no pointer moves.

Either way the hovered state is *rendered*, so the grade reads the real computed
background and the screenshot shows it; the evidence line says which way it was.
"""

from __future__ import annotations

import contextlib
import time
from typing import Any, Iterator, NamedTuple, Optional

#: How long a real pointer hover gets to reach the webview before the grade reads it.
POINTER_SETTLE = 0.4


class Hover(NamedTuple):
    mode: str  # "pointer" | "forced"
    note: str


def _first_line(text: str, limit: int = 200) -> str:
    line = (text.strip().splitlines() or [""])[0]
    return line[:limit]


def _pointer_blocker() -> Optional[str]:
    """Why the real pointer cannot be used here, or ``None``."""
    from .. import os_input  # noqa: PLC0415 - keeps the OS backends off the import path

    return os_input.unavailable_reason() or os_input.shared_session_reason()


def _pointer_hover(driver: Any, pid: int, test_id: str) -> str:
    from .. import os_input  # noqa: PLC0415

    osi = os_input.for_pid(pid)
    screen = os_input.ScreenMapper.calibrate(osi, driver, pid=pid)
    x, y = screen.point(test_id)
    osi.pointer_move(x, y)
    time.sleep(POINTER_SETTLE)
    return f"real OS pointer on {test_id} at screen ({x:.0f}, {y:.0f}) (test window PID {pid})"


def hover(driver: Any, pid: Optional[int], test_id: str) -> Hover:
    """Hover ``test_id``: the real pointer when allowed, else a forced bridge hover."""
    from ..os_input import GlobalInjectionRefused, OsInputUnavailable  # noqa: PLC0415

    reason = _pointer_blocker() if pid else "no app PID"
    if reason is None and pid:
        try:
            return Hover("pointer", _pointer_hover(driver, pid, test_id))
        except (OsInputUnavailable, GlobalInjectionRefused) as exc:
            reason = str(exc)
    rules = driver.force_hover(test_id)
    return Hover(
        "forced",
        f"hover forced through the bridge ({rules} :hover rules painted); "
        f"real pointer not used: {_first_line(reason or '')}",
    )


def unhover(driver: Any, how: Hover) -> None:
    """Undo a :func:`hover` (a forced hover is cleared; the pointer stays put)."""
    if how.mode == "forced":
        driver.force_hover(None)


@contextlib.contextmanager
def hovered(driver: Any, pid: Optional[int], test_id: str) -> Iterator[Hover]:
    """``with hovered(driver, pid, testid) as how:`` — hovered for the block's duration."""
    how = hover(driver, pid, test_id)
    try:
        yield how
    finally:
        unhover(driver, how)
