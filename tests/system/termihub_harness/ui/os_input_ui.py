"""Real OS input from a suite: keys, clicks, drags at the test instance's PID (#4935).

:class:`OsInputUi` wraps :mod:`termihub_harness.os_input` for the automated
OS-input grades. It aims every event at ``self.app.pid`` (following a relaunch),
maps a ``data-testid`` to a screen point through a calibrated
:class:`~termihub_harness.os_input.ScreenMapper`, and proves an injected event
arrived with the bridge's ``osInputProbe`` (``isTrusted`` events only).

On a machine that cannot inject — no display, no Accessibility permission, or
simply not a GitHub runner without the explicit opt-in — the suite skips with
that reason; on CI a missing capability fails instead, so the grade can never
silently turn into a skip.
"""

from __future__ import annotations

import contextlib
import os
import re
import sys
from typing import Any, Iterator, Optional

import pytest

from .. import os_input
from ..bridge import Driver
from ..os_input import OsInput, ScreenMapper
from .base import HarnessMixin


class OsInputUi(HarnessMixin):
    """Mixin: OS-level input aimed at the test instance by PID."""

    app: Any
    _osi: Optional[OsInput] = None

    def os_input(self) -> OsInput:
        """The backend aimed at the current test-instance PID (skips/fails if unusable)."""
        reason = os_input.unavailable_reason()
        if reason is not None:
            if os.environ.get("GITHUB_ACTIONS") == "true":
                pytest.fail(f"OS input unavailable on the CI runner: {reason}")
            pytest.skip(reason)
        pid = self.app.pid
        if pid is None:
            raise AssertionError("the test instance is not running")
        if self._osi is None:
            type(self)._osi = os_input.for_pid(pid)
        elif self._osi.pid != pid:
            self._osi.retarget(pid)
        return self._osi  # type: ignore[return-value]

    def screen(self, driver: Optional[Driver] = None) -> ScreenMapper:
        """Calibrate the window behind ``driver`` (default: the main window)."""
        return ScreenMapper.calibrate(self.os_input(), driver or self.driver)

    def os_activate(self, driver: Optional[Driver] = None) -> ScreenMapper:
        """Bring the window behind ``driver`` to the front; return its mapper."""
        screen = self.screen(driver)
        self.os_input().activate(window=screen.window)
        return screen

    def os_click(
        self,
        test_id: str,
        *,
        screen: Optional[ScreenMapper] = None,
        button: str = "left",
        count: int = 1,
        fx: float = 0.5,
        fy: float = 0.5,
    ) -> None:
        """A real OS click on the element tagged ``test_id``."""
        screen = screen or self.screen()
        self.os_input().click(*screen.point(test_id, fx, fy), button=button, count=count)

    def trusted_events(self, driver: Optional[Driver] = None, kind: Optional[str] = None) -> list:
        """The OS-delivered (``isTrusted``) events ``driver``'s window recorded."""
        events = (driver or self.driver).os_input_probe()["events"]
        return [e for e in events if e.get("isTrusted") and (kind is None or e["type"] == kind)]

    def reset_input_probe(self, driver: Optional[Driver] = None) -> None:
        (driver or self.driver).os_input_probe(reset=True)

    def has_focus(self, driver: Optional[Driver] = None) -> bool:
        return bool((driver or self.driver).os_input_probe()["hasFocus"])

    def os_select_terminal_word(self, tab_id: str, word: str, screen: ScreenMapper) -> None:
        """Double-click ``word`` where it fills a terminal row of its own (real pointer)."""
        rows = [
            row
            for row in self.driver.read_terminal_cells(word, tab_id=tab_id)
            if row["text"].strip() == word
        ]
        assert rows, f"{word!r} has no output row of its own in the terminal buffer"
        row = rows[-1]
        measure = self.driver.measure_terminal(tab_id)
        col = row["text"].index(word) + len(word) / 2
        pad = float(self.driver.get_computed_style("--spacing-sm").rstrip("px") or 0)
        rect = screen.rect(f"terminal-renderer-{tab_id}")
        point = cell_point(screen, rect, measure, row["y"] - measure["viewportY"], col, pad)
        self.os_input().click(*point, count=2)


@contextlib.contextmanager
def linux_window_manager() -> Iterator[None]:
    """Run a window manager on the CI Xvfb display while a suite runs (Linux only)."""
    if not sys.platform.startswith("linux") or not os_input.global_injection_allowed():
        yield
        return
    from ..os_input.linux import XWindowManager

    manager = XWindowManager().start()
    try:
        yield
    finally:
        manager.stop()


def terminal_echo(text: str, tag: str) -> Optional[str]:
    """What ``echo {tag}_<x>_`` printed: ``<x>`` from the output line, else None.

    Matches only a line that *starts* with the tag, so the echoed command line
    (prompt + ``echo …``) never counts.
    """
    pattern = re.compile(rf"^{re.escape(tag)}_(.*)_$")
    for line in text.splitlines():
        match = pattern.match(line.strip())
        if match:
            return match.group(1)
    return None


def has_line(text: str, line: str) -> bool:
    """Whether ``text`` has a row that is exactly ``line`` (an output line)."""
    return any(row.strip() == line for row in text.splitlines())


def cell_point(
    screen: ScreenMapper, renderer_rect: dict, measure: dict, row: int, col: float, pad_x: float
) -> tuple[float, float]:
    """Screen point of terminal cell ``(row, col)`` (viewport row, fractional column)."""
    cell_w = measure["cell"]["width"]
    cell_h = measure["cell"]["height"]
    rows = measure["grid"]["rows"]
    top = renderer_rect["top"] + measure["paint"]["rowsBottom"] - rows * cell_h
    x = renderer_rect["left"] + pad_x + (col + 0.5) * cell_w
    y = top + (row + 0.5) * cell_h
    return screen.to_screen(x, y)
