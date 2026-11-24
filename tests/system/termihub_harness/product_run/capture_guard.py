"""Refuse a product-run capture that shows the wrong screen (#5857).

Run ``20261123T215628Z`` sent four captures to the UI reviewers that showed a
different screen than their step: the step's end capture ran after the body's
own cleanup had closed the dialog (workflow editor, unlock dialog) or switched
to another settings page (Command marks), so the reviewer graded the screen
*behind* the surface. Every step can therefore declare ``expect_testid``: the
element its main capture must show. Before that capture the harness checks the
element is in the page, rendered and inside the window; when it is not, the
step fails with :class:`WrongScreen`, a *harness* error whose message says so;
its failure capture is kept for debugging but never sent to a reviewer
(:func:`~.review.is_wrong_screen_failure`).
"""

from __future__ import annotations

import time
from typing import Any, Callable, Optional

#: How long a capture waits for the expected element before it gives up.
GUARD_TIMEOUT = 3.0
GUARD_INTERVAL = 0.2
#: Prefix of every wrong-screen failure, so the page and the reviewers can tell
#: a harness error from a product failure.
HARNESS_ERROR = "harness error (wrong screen, not a product failure)"


class WrongScreen(AssertionError):
    """The capture would not show the step's expected element."""


def parse_px(value: Any) -> Optional[float]:
    """``"1280px"`` -> ``1280.0``; ``None`` for anything else."""
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value.strip().endswith("px"):
        try:
            return float(value.strip()[:-2])
        except ValueError:
            return None
    return None


def screen_problem(
    testid: str,
    *,
    exists: bool,
    rect: Optional[dict[str, Any]],
    viewport: Optional[tuple[float, float]],
) -> Optional[str]:
    """Why ``testid`` is not in frame, or ``None`` when it is.

    ``rect`` is the element's viewport box (``measureElement``); ``viewport``
    the window's CSS ``(width, height)``, ``None`` when unknown (then only the
    box's size and its top-left edge are checked).
    """
    if not exists:
        return f"{testid} is not in the page"
    if not isinstance(rect, dict):
        return f"{testid} could not be measured"
    try:
        x, y = float(rect["x"]), float(rect["y"])
        width, height = float(rect["width"]), float(rect["height"])
    except (KeyError, TypeError, ValueError):
        return f"{testid} has an unreadable box {rect!r}"
    if width <= 0 or height <= 0:
        return f"{testid} is in the page but not rendered (box {width:.0f}x{height:.0f})"
    if x + width <= 0 or y + height <= 0:
        return f"{testid} is outside the window (box at {x:.0f},{y:.0f})"
    if viewport is not None:
        view_w, view_h = viewport
        if x >= view_w or y >= view_h:
            return (
                f"{testid} is outside the {view_w:.0f}x{view_h:.0f} window "
                f"(box at {x:.0f},{y:.0f}; scroll it into view first)"
            )
    return None


def wrong_screen_message(testid: str, problem: str, step_expect: str = "") -> str:
    """The step's failure reason for a wrong-screen capture."""
    message = f"{HARNESS_ERROR}: the capture must show {testid}, but {problem}"
    if step_expect:
        message += f"; the step should show: {step_expect}"
    return message


def check_in_frame(
    testid: str,
    probe: Callable[[], Optional[str]],
    *,
    step_expect: str = "",
    timeout: float = GUARD_TIMEOUT,
    interval: float = GUARD_INTERVAL,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    """Poll ``probe`` (a :func:`screen_problem` result) briefly; raise :class:`WrongScreen`.

    A probe that raises (a bridge error mid-render) counts as one failed check.
    """
    started = clock()
    while True:
        try:
            problem = probe()
        except Exception as exc:  # noqa: BLE001 - any probe error is "not yet"
            problem = f"{testid} could not be checked ({exc})"
        if problem is None:
            return
        if clock() - started >= timeout:
            raise WrongScreen(wrong_screen_message(testid, problem, step_expect))
        sleep(interval)

