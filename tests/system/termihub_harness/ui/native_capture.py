"""Grade what the app's window really painted, from a native capture (#4937).

:class:`NativeCaptureUi` captures the test app's own window — located by the
PID the harness launched, never by name (see
:mod:`termihub_harness.window_capture`) — and maps the terminal's cell grid
onto it, so a grade can ask "what colour did cell (3, 0) paint?" of the real
GPU output rather than of the DOM.

:meth:`NativeCaptureUi.wait_for_terminal_paint` polls capture + grade until
the grade passes (the WebGL renderer paints on a later animation frame than
the buffer write), and on timeout saves the last capture with the graded
rects outlined under the test's artifacts dir, so a red run shows exactly
which pixels were judged.

On macOS the text grades read the WebGL renderer's own frames through the
bridge instead (:meth:`NativeCaptureUi.capture_terminal_webgl`): no window
server image on the hosted runners contains the WebGL canvas (#4970).
"""

from __future__ import annotations

import os
import sys
import time
from typing import Any, Callable, Iterable, NamedTuple, Optional, TypeVar

import pytest

from ..artifacts import ARTIFACT_ROOT, sanitize_nodeid
from ..bridge import BridgeError
from ..display_runner import bring_app_foreground
from ..pixel_grades import RGB, hex_rgb
from ..window_capture import (
    CaptureUnavailable,
    Frame,
    PageMapping,
    Rect,
    capture_window,
    contact_sheet,
    frame_from_rgb_base64,
    map_page,
    save_png,
)
from .base import HarnessMixin

_T = TypeVar("_T")

#: How long a paint grade may take to pass before it fails.
PAINT_TIMEOUT = 20.0


class _NoWebglFrame(RuntimeError):
    """A WebGL readback was asked of a terminal on the DOM renderer."""


class TerminalCapture(NamedTuple):
    """A capture of the app window plus where the terminal's cells sit in it."""

    frame: Frame
    mapping: PageMapping
    measure: dict[str, Any]

    @property
    def css_cell(self) -> tuple[float, float]:
        """One cell's CSS size: the grid's laid-out size over its cols x rows.

        The renderer's own cell metric is not used: the DOM renderer lays rows
        out at its line height, which can differ from the measured glyph cell,
        while the ``.xterm-screen`` box always spans exactly the grid.
        """
        screen, grid = self.measure["screenRect"], self.measure["grid"]
        return screen["width"] / grid["cols"], screen["height"] / grid["rows"]

    @property
    def cell_size(self) -> tuple[float, float]:
        """One cell's size in capture pixels."""
        w, h = self.css_cell
        return w * self.mapping.scale, h * self.mapping.scale

    def cell_rect(self, col: int, row: int, cols: int = 1) -> Rect:
        """The capture rect of ``cols`` cells from ``(col, row)`` (viewport row)."""
        screen = self.measure["screenRect"]
        w, h = self.css_cell
        return self.mapping.rect(screen["left"] + col * w, screen["top"] + row * h, cols * w, h)

    def buffer_cell_rect(self, col: int, y: int, cols: int = 1) -> Rect:
        """Like :meth:`cell_rect` for absolute buffer line ``y``."""
        return self.cell_rect(col, y - int(self.measure["viewportY"]), cols)

    def row_visible(self, y: int) -> bool:
        """Whether absolute buffer line ``y`` is inside the viewport."""
        row = y - int(self.measure["viewportY"])
        return 0 <= row < int(self.measure["grid"]["rows"])

    @property
    def background(self) -> RGB:
        """The terminal theme background (what an unpainted cell shows)."""
        return hex_rgb(self.measure["paint"]["themeBackground"] or "#000000")


def current_nodeid() -> str:
    """The running test's node id (from ``PYTEST_CURRENT_TEST``)."""
    return os.environ.get("PYTEST_CURRENT_TEST", "capture").split(" (")[0]


def save_capture(frame: Frame, label: str, rects: Iterable[Rect] = ()) -> Optional[str]:
    """Save ``frame`` (``rects`` outlined) under the test's artifacts dir; return the path."""
    try:
        shown = frame.with_outlines(list(rects))
        dest = ARTIFACT_ROOT / sanitize_nodeid(current_nodeid()) / f"capture-{label}.png"
        return str(save_png(shown, dest))
    except OSError:
        return None


def save_sheet(frames: list[Optional[Frame]], label: str) -> Optional[str]:
    """Save ``frames`` side by side as a contact sheet under the test's artifacts dir.

    Returns ``None`` (no sheet) when any frame is missing.
    """
    if not frames or any(f is None for f in frames):
        return None
    dest = ARTIFACT_ROOT / sanitize_nodeid(current_nodeid()) / f"sheet-{label}.png"
    return str(save_png(contact_sheet([f for f in frames if f is not None]), dest))


class NativeCaptureUi(HarnessMixin):
    """Capture the test app's window by PID and grade the painted terminal."""

    app: Any

    def capture_app_window(self) -> Frame:
        """Capture the launched app's window; skip the test if the OS cannot.

        An unexpected skip still fails the nightly lane through the skip guard
        (``skip-allowlist.json`` has no entry for it), so a CI runner losing
        the capture tooling is loud; a developer box without ``xdotool`` /
        Screen Recording permission just skips.
        """
        try:
            return capture_window(self.app.pid)
        except CaptureUnavailable as exc:
            pytest.skip(f"native window capture unavailable: {exc}")
            raise  # unreachable; for type checkers

    def try_capture_app_window(self) -> Optional[Frame]:
        """Capture the launched app's window, or ``None`` when the OS cannot.

        For guided tests, where a missing capture only loses evidence.
        """
        try:
            return capture_window(self.app.pid)
        except CaptureUnavailable:
            return None

    def grades_webgl_readback(self, tab_id: Optional[str] = None) -> bool:
        """Whether text grades read the WebGL canvas in-process instead of a capture.

        On the hosted macOS runners no window server image contains the xterm
        WebGL canvas — ``screencapture -l`` / ``-R``, ``CGWindowListCreateImage``
        (every image option) and ScreenCaptureKit all show the bare terminal
        background, while the canvas itself holds the right pixels (#4970). So
        on macOS a live WebGL renderer is graded from its own readback
        (:meth:`capture_terminal_webgl`). Linux and Windows grade the capture.
        """
        if sys.platform != "darwin":
            return False
        return self.driver.measure_terminal(tab_id).get("renderer") == "webgl"

    def capture_terminal(self, tab_id: Optional[str] = None) -> TerminalCapture:
        """Capture the window and map the terminal ``tab_id`` (active tab) onto it."""
        measure = self.driver.measure_terminal(tab_id)
        if not measure.get("screenRect") or not measure.get("page"):
            raise AssertionError(
                "measureTerminal has no screenRect/page — the app under test predates #4937"
            )
        frame = self.capture_app_window()
        page = measure["page"]
        try:
            mapping = map_page(
                frame.width,
                frame.height,
                inner_width=page["innerWidth"],
                inner_height=page["innerHeight"],
                device_pixel_ratio=page["devicePixelRatio"],
            )
        except CaptureUnavailable as exc:
            save_capture(frame, "unmapped")
            raise AssertionError(f"cannot map the page onto the capture: {exc}") from exc
        return TerminalCapture(frame, mapping, measure)

    def capture_terminal_webgl(
        self, tab_id: Optional[str] = None, *, repaint: bool = True
    ) -> Optional[TerminalCapture]:
        """Read back the WebGL renderer's own pixels, mapped like a capture (#4970).

        The bridge copies the WebGL canvas in the animation frame the renderer
        draws in, so this sees the GPU output in-process — on macOS too, where
        the window server's image lacks the canvas. The canvas spans the
        ``.xterm-screen`` box, so the page maps onto it with that box's
        top-left at the origin. Returns ``None`` on the DOM renderer.
        ``repaint=False`` reads what the app drew without forcing a repaint.
        """
        measure = self.driver.measure_terminal(tab_id)
        value = self.driver.read_terminal_webgl_frame(tab_id, repaint=repaint)
        if value is None:
            return None
        if not measure.get("screenRect"):
            raise AssertionError("measureTerminal has no screenRect — the app predates #4937")
        frame = frame_from_rgb_base64(value["width"], value["height"], value["rgb"])
        scale = float(value["devicePixelRatio"])
        screen = measure["screenRect"]
        mapping = PageMapping(-screen["left"] * scale, -screen["top"] * scale, scale)
        return TerminalCapture(frame, mapping, measure)

    def _paint_capture(self, tab_id: Optional[str], source: str) -> TerminalCapture:
        if source == "capture":
            return self.capture_terminal(tab_id)
        cap = self.capture_terminal_webgl(tab_id, repaint=False)
        if cap is None:
            raise _NoWebglFrame("the terminal is not on the WebGL renderer")
        return cap

    def wait_for_terminal_paint(
        self,
        grade: Callable[[TerminalCapture], tuple[Optional[_T], list[Rect], str]],
        *,
        what: str,
        tab_id: Optional[str] = None,
        timeout: float = PAINT_TIMEOUT,
        label: Optional[str] = None,
        text_layer: bool = True,
        source: str = "auto",
    ) -> _T:
        """Capture and ``grade`` until it passes; on timeout fail with evidence.

        ``grade`` returns ``(result, rects, detail)``: a truthy ``result``
        passes; otherwise ``rects`` (the graded cells) and ``detail`` (what was
        seen) go into the failure and the saved capture.

        ``source`` picks the pixels: ``"capture"`` the native window capture,
        ``"webgl"`` the WebGL renderer's own frames (``readTerminalWebglFrame``
        without a forced repaint, so a renderer that stops drawing fails the
        grade), ``"auto"`` the readback for a text grade on macOS (see
        :meth:`grades_webgl_readback`) and the capture otherwise.
        ``text_layer=False`` marks a grade of a layer the macOS capture does
        see (the inline-image canvas), which always uses the capture.
        """
        if source not in ("auto", "capture", "webgl"):
            raise ValueError(f"unknown paint source {source!r}")
        if source == "auto":
            webgl = text_layer and self.grades_webgl_readback(tab_id)
            source = "webgl" if webgl else "capture"
        # macOS stops painting an occluded WKWebView: make the test app (by its
        # PID, never its name) the frontmost one first. A no-op elsewhere.
        bring_app_foreground(self.app.pid)
        deadline = time.monotonic() + timeout
        last: Optional[TerminalCapture] = None
        rects: list[Rect] = []
        detail = "no capture was graded"
        while True:
            try:
                last = self._paint_capture(tab_id, source)
                result, rects, detail = grade(last)
                if result:
                    return result
            except BridgeError as exc:
                detail = f"bridge: {exc}"
            except _NoWebglFrame as exc:
                detail = str(exc)
            if time.monotonic() >= deadline:
                break
            time.sleep(0.3)
        path = save_capture(last.frame, label or what.replace(" ", "-"), rects) if last else None
        raise AssertionError(
            f"timed out after {timeout:.0f}s waiting for {what}: {detail}"
            + (f" (capture: {path})" if path else "")
            + (
                f"; capture {last.frame.width}x{last.frame.height}, page mapped at "
                f"{tuple(round(v, 1) for v in last.mapping)}, renderer "
                f"{last.measure.get('renderer')}, source {source}"
                if last
                else ""
            )
        )
