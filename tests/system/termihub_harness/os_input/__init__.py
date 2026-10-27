"""OS-level input injection aimed at the test instance by PID (#4935).

The bridge drives the app with *synthetic* DOM events. Some release checks are
about what the OS delivers — a dead key composed by the keyboard layout, a
click into an inactive window, Caps Lock, Cmd+Q, a tab torn off the window, a
focus switch to another app. This package injects those as real OS events:

- Linux: ``xdotool`` (XTEST) on the harness's Xvfb display (:mod:`.linux`);
- macOS: ``CGEventPostToPid`` keys, HID-tap pointer events and Apple events by
  PID (:mod:`.macos`);
- Windows: ``SendInput`` into the PID's foreground window (:mod:`.windows`).

Targets are PIDs only; see :mod:`.base` for the safety contract (by-name
targets refused, global injection gated to CI/opt-in and frontmost-checked).

Typical use from a test::

    osi = os_input.for_pid(self.app.pid)
    screen = os_input.ScreenMapper.calibrate(osi, self.driver)
    osi.click(*screen.point("terminal-view-split-horizontal"))
    osi.type_text("echo hi\\n")
"""

from __future__ import annotations

import itertools
import sys
import time
from dataclasses import dataclass
from typing import Any, Optional

from .base import (
    GLOBAL_OPT_IN_ENV,
    ByNameTargetRefused,
    GlobalInjectionRefused,
    OsInput,
    OsInputUnavailable,
    OsWindow,
    global_injection_allowed,
    parse_combo,
    require_pid,
)
from .helper import HelperWindow

__all__ = [
    "GLOBAL_OPT_IN_ENV",
    "ByNameTargetRefused",
    "GlobalInjectionRefused",
    "HelperWindow",
    "OsInput",
    "OsInputUnavailable",
    "OsWindow",
    "ScreenMapper",
    "for_pid",
    "global_injection_allowed",
    "parse_combo",
    "primary_modifier",
    "require_pid",
    "unavailable_reason",
]


def _backend() -> Any:
    if sys.platform == "darwin":
        from .macos import MacOsInput

        return MacOsInput
    if sys.platform == "win32":
        from .windows import WindowsOsInput

        return WindowsOsInput
    from .linux import LinuxOsInput

    return LinuxOsInput


def unavailable_reason() -> Optional[str]:
    """Why this host cannot inject OS input, or ``None`` when it can."""
    reason = _backend().unavailable_reason()
    if reason is None and not global_injection_allowed():
        return (
            "OS input injection runs only on a GitHub runner or with "
            f"{GLOBAL_OPT_IN_ENV}=1 (it drives the real keyboard and pointer)"
        )
    return reason


def for_pid(pid: int, **kwargs: Any) -> OsInput:
    """The OS backend aimed at ``pid`` (raises :class:`ByNameTargetRefused` for a name)."""
    return _backend()(require_pid(pid), **kwargs)


def primary_modifier() -> str:
    """``cmd`` on macOS, ``ctrl`` elsewhere — the app's CmdOrCtrl."""
    return "cmd" if sys.platform == "darwin" else "ctrl"


#: Offsets from a window's center for successive calibration rounds.
CALIBRATION_NUDGES = ((0, 0), (23, 17), (-19, 29))

#: How long (s) one calibration move waits for the webview to report it.
CALIBRATION_MOVE_WAIT = 2.0


@dataclass
class ScreenMapper:
    """Maps one app window's CSS client coordinates to OS screen coordinates.

    Built by :meth:`calibrate`: the OS pointer is moved to a known screen point
    inside each window of the PID until a window's bridge sees a *trusted*
    ``pointermove``; the event's client coordinates fix the offset. This covers
    title bars, menus and window-manager offsets without guessing them.
    """

    os_input: OsInput
    driver: Any
    window: OsWindow
    offset: tuple[float, float]
    scale: float

    @classmethod
    def calibrate(
        cls, os_input: OsInput, driver: Any, *, pid: Optional[int] = None, timeout: float = 10.0
    ) -> "ScreenMapper":
        """Find the window whose webview sees a real pointer move, and its offset.

        Retries until ``timeout``: each round re-reads the PID's windows (one
        may still be moving into place), brings each to the front, and moves
        the pointer to a point inside it (nudged per round, since a freshly
        shown webview can miss a move). A move counts only once the bridge
        reports it as a *trusted* ``pointermove``. On failure the error says
        what was under the pointer each time and lists every window on the
        desktop, so a covering or input-grabbing window is named (#4993).
        """
        try:
            windows = os_input._wait(  # noqa: SLF001 — same package
                lambda: os_input.windows(pid), timeout, "a visible window"
            )
        except OsInputUnavailable:
            raise OsInputUnavailable(f"PID {pid or os_input.pid} has no visible window") from None
        deadline = time.monotonic() + timeout
        misses: list[str] = []
        for round_index in itertools.count():
            dx, dy = CALIBRATION_NUDGES[round_index % len(CALIBRATION_NUDGES)]
            for window in windows:
                try:
                    os_input.activate(window=window, timeout=min(timeout, 5.0))
                except OsInputUnavailable as exc:
                    misses.append(f"{window}: not activated ({exc})")
                    continue  # e.g. a hidden helper window that cannot take focus
                cx, cy = window.center
                x, y = cx + dx, cy + dy
                probe = driver.os_input_probe(reset=True)
                os_input.pointer_move(x - 7, y - 7)
                os_input.pointer_move(x, y)
                event = _wait_trusted_move(driver, timeout=min(timeout, CALIBRATION_MOVE_WAIT))
                if event is not None:
                    scale = (
                        probe["devicePixelRatio"] if os_input.scale_is_device_pixel_ratio else 1.0
                    )
                    offset = (x - event["clientX"] * scale, y - event["clientY"] * scale)
                    if misses:
                        print(f"[os-input] calibrated after {len(misses)} miss(es): {misses}")
                    return cls(os_input, driver, window, offset, scale)
                under = os_input.describe_point(x, y) or "?"
                misses.append(f"({x}, {y}) in {window}: under the pointer {under}")
            out_of_time = time.monotonic() >= deadline
            if out_of_time and round_index + 1 >= len(CALIBRATION_NUDGES):
                break
            windows = os_input.windows(pid) or windows
        desktop = os_input.describe_desktop()
        raise OsInputUnavailable(
            f"no window of PID {pid or os_input.pid} received the calibration pointer move "
            f"(windows: {windows})\n"
            + "\n".join(f"  miss: {m}" for m in misses[-6:])
            + (f"\n{desktop}" if desktop else "")
        )

    def for_window(self, driver: Any, window: OsWindow) -> "ScreenMapper":
        """A mapper for another window of the same app with identical chrome.

        Its webview sits at the same offset inside its frame, so only the frame
        position differs — for a second window the pointer cannot reach
        uncovered (one of two stacked windows on macOS).
        """
        dx, dy = window.x - self.window.x, window.y - self.window.y
        return ScreenMapper(
            self.os_input, driver, window, (self.offset[0] + dx, self.offset[1] + dy), self.scale
        )

    def to_screen(self, client_x: float, client_y: float) -> tuple[float, float]:
        return (
            self.offset[0] + client_x * self.scale,
            self.offset[1] + client_y * self.scale,
        )

    def rect(self, test_id: str) -> dict[str, float]:
        rect = self.driver.os_input_probe(test_id).get("rect")
        if not rect or rect["width"] <= 0 or rect["height"] <= 0:
            raise AssertionError(f"element {test_id!r} has no laid-out box: {rect}")
        return rect

    def point(self, test_id: str, fx: float = 0.5, fy: float = 0.5) -> tuple[float, float]:
        """Screen point at fraction ``(fx, fy)`` of the element's box (center by default)."""
        rect = self.rect(test_id)
        return self.to_screen(rect["left"] + rect["width"] * fx, rect["top"] + rect["height"] * fy)

    def outside_point(self, margin: float = 60.0) -> tuple[float, float]:
        """An on-screen point just outside the window (for a drag released outside it).

        Tries below, right, left and above the window, in that order; raises
        when the window covers the whole screen.
        """
        win = self.window
        cx, cy = win.center
        width, height = self.os_input.screen_size()
        candidates = [
            (cx, win.y + win.height + margin),
            (win.x + win.width + margin, cy),
            (win.x - margin, cy),
            (cx, win.y - margin),
        ]
        for x, y in candidates:
            if 0 <= x < width and 0 <= y < height:
                return x, y
        raise OsInputUnavailable(f"window {win} leaves no screen space ({width}x{height}) outside it")


def _wait_trusted_move(driver: Any, *, timeout: float) -> Optional[dict]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        events = driver.os_input_probe()["events"]
        moves = [
            e for e in events if e.get("type") == "pointermove" and e.get("isTrusted")
        ]
        if moves:
            # Let the second calibration move land too, then use the latest.
            time.sleep(0.3)
            events = driver.os_input_probe()["events"]
            return [e for e in events if e.get("type") == "pointermove" and e.get("isTrusted")][-1]
        time.sleep(0.1)
    return None
