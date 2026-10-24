"""Paint-timing grades on native captures of the app window (#4937).

These replace guided checks about *whether* something painted, which the DOM
screenshot cannot see (it never captures the WebGL canvas, the inline-image
layer, or the native window before the web view's first paint). The window is
captured by the PID the harness launched — never by app name (see
:mod:`termihub_harness.window_capture`):

- MT-UI-01 — a cold launch in the Dark theme never shows a near-white frame:
  the window is captured in a fast loop from the moment the relaunched process
  exists until well after the bridge connects;
- MT-UI-42 — zooming a terminal, un-zooming it and splitting the view repaint
  its content at once: every viewport row with text has ink, every empty row
  none, without scrolling;
- MT-UI-44 — a SIXEL and an iTerm2 inline image paint their pixels inline,
  disappear when scrolled out of view and paint again when scrolled back, on
  the WebGL renderer and again on the DOM renderer.

Runs in the integration lane on every OS.
"""

from __future__ import annotations

import base64
import sys
import threading
import time
from typing import Any, Optional

import pytest

from termihub_harness import (
    ConnectionsUi,
    SettingsUi,
    LayoutUi,
    ShellFsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.pixel_grades import has_color, ink_count, near_white_fraction
from termihub_harness.ui.native_capture import NativeCaptureUi, TerminalCapture, save_capture
from termihub_harness.ui.theme import ThemeUi
from termihub_harness.window_capture import (
    CaptureUnavailable,
    Frame,
    capture_window,
    encode_png,
)

pytestmark = pytest.mark.integration

_WIN = sys.platform.startswith("win")
_ZOOM_MOD = {"meta": True} if sys.platform == "darwin" else {"ctrl": True}
#: Print 1..n then a marker the typed command does not contain (TH_SEQ_2), in
#: the default local shell (PowerShell on Windows).
_SEQ = "1..{n}; 'TH_SEQ_' + (1+1)" if _WIN else "seq 1 {n}; echo TH_SEQ_$((1+1))"
SPLIT_H = "terminal-view-split-horizontal"

#: A frame this much near-white is a white flash (the dark UI has only text).
WHITE_FLASH_FRACTION = 0.3
#: How long to keep capturing after the bridge reconnects (first paint settles).
AFTER_CONNECT_SECONDS = 2.0

MAGENTA, CYAN = (255, 0, 255), (0, 255, 255)
#: A 48x30 px solid magenta SIXEL (5 bands of 6 rows).
SIXEL = b"\x1bPq#0;2;100;0;100" + b"-".join([b"#0!48~"] * 5) + b"\x1b\\"
#: A 40x40 px solid cyan PNG as an iTerm2 inline image.
_PNG = encode_png(Frame.filled(40, 40, CYAN))
IIP = (
    b"\x1b]1337;File=inline=1;size="
    + str(len(_PNG)).encode()
    + b":"
    + base64.b64encode(_PNG)
    + b"\x07"
)
IMAGES_FILE = "th_capture_images.txt"
#: Image pixels that must show (well under each image's area at any scale).
MIN_IMAGE_PIXELS = 400


class TestNativePaintGrades(
    NativeCaptureUi,
    ThemeUi,
    SettingsUi,
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    LayoutUi,
    ShellFsUi,
    SystemTest,
):
    """Whether the window, the terminal canvas and inline images painted."""

    def reset_before_rerun(self) -> None:
        self.dismiss_modals("zoom-overlay")
        self.reset_tabs()

    @pytest.fixture(autouse=True)
    def _dark_theme(self):
        # Unset means Dark (the default); selecting it again would write nothing.
        if self.current_theme() not in (None, "dark"):
            self.set_theme("dark")
        yield
        self.remove_home(IMAGES_FILE)

    def _seq(self, tab: str, n: int) -> None:
        """Print 1..n in the shell and wait until it has finished."""
        done = len(self.driver.read_terminal_cells("TH_SEQ_2", tab_id=tab))
        self.wait(
            lambda: self.driver.terminal_input(_SEQ.format(n=n), tab) is None,
            what="the shell to accept the count",
        )
        self.wait(
            lambda: len(self.driver.read_terminal_cells("TH_SEQ_2", tab_id=tab)) > done,
            what="the count to finish",
        )

    def _shell(self) -> str:
        """A fresh default local shell in the home dir; return its tab id."""
        self.close_all_tabs()
        name = unique_name("paint")
        self.switch_to_connections_sidebar()
        self.create_local_connection(name, connect=True)
        tab = self.wait(lambda: self.find_tab(name), what=f"the {name!r} tab")["id"]
        self.wait(lambda: self.driver.read_terminal(tab).strip(), what="the shell prompt")
        return tab

    # ── MT-UI-01 ────────────────────────────────────────────────────────────
    def test_cold_launch_paints_no_white_frame(self):
        """MT-UI-01: from the window's first frame on, a Dark cold launch is never white."""
        self.close_all_tabs()
        stop = threading.Event()
        seen: dict[str, Any] = {"frames": 0, "early": 0, "worst": 0.0, "frame": None}
        connected = threading.Event()

        def watch() -> None:
            while not stop.is_set():
                try:
                    frame = capture_window(self.app.pid)
                except CaptureUnavailable:
                    time.sleep(0.02)  # no window yet
                    continue
                white = near_white_fraction(frame, step=8)
                seen["frames"] += 1
                if not connected.is_set():
                    seen["early"] += 1
                if white >= seen["worst"]:
                    seen["worst"], seen["frame"] = white, frame

        self.app.restart()
        watcher = threading.Thread(target=watch, daemon=True)
        watcher.start()
        try:
            self._reacquire_driver()
            connected.set()
            time.sleep(AFTER_CONNECT_SECONDS)
        finally:
            stop.set()
            watcher.join(timeout=30)
        if seen["frames"] == 0:
            # Same contract as capture_app_window: unavailable capture skips.
            self.capture_app_window()
        assert seen["early"] > 0, (
            f"no frame was captured before the bridge reconnected ({seen['frames']} after): "
            "the launch itself was not watched"
        )
        if seen["worst"] >= WHITE_FLASH_FRACTION:
            path = save_capture(seen["frame"], "white-flash")
            pytest.fail(
                f"a cold-launch frame was {seen['worst']:.0%} near-white "
                f"({seen['frames']} frames, {seen['early']} before connect; capture: {path})"
            )

    # ── MT-UI-42 ────────────────────────────────────────────────────────────
    def _rows_painted(self, tab: str, label: str) -> None:
        """Wait until every viewport row with text has ink and every empty row none."""

        def grade(cap: TerminalCapture):
            rows = self.driver.read_terminal_cells(tab_id=tab)
            bg, cols = cap.background, int(cap.measure["grid"]["cols"])
            unpainted, stray, rects = [], [], []
            for r in rows:
                rect = cap.buffer_cell_rect(0, r["y"], cols)
                ink = ink_count(cap.frame, rect, bg)
                if r["text"].strip() and ink < len(r["text"].strip()):
                    unpainted.append(r["text"][:12])
                    rects.append(rect)
                elif not r["text"].strip() and ink > 0:
                    stray.append(r["y"])
                    rects.append(rect)
            ok = bool(rows) and not unpainted and not stray
            return ok, rects, f"rows without ink: {unpainted[:5]}; empty rows with ink: {stray[:5]}"

        self.wait_for_terminal_paint(grade, what=f"the terminal to repaint ({label})", tab_id=tab)

    def test_zoom_unzoom_and_split_repaint_without_scrolling(self):
        """MT-UI-42: content shows at once after zoom, un-zoom and a split."""
        tab = self._shell()
        self._seq(tab, 200)
        self._rows_painted(tab, "before zoom")
        for cycle in range(2):
            self.driver.press_key("Enter", shift=True, **_ZOOM_MOD)
            self.wait(
                lambda: self.driver.get_state("zoomedTabId") == tab, what="the tab to zoom"
            )
            self._rows_painted(tab, f"zoomed #{cycle + 1}")
            self.driver.press_key("Escape", shift=True)
            self.wait(lambda: not self.driver.get_state("zoomedTabId"), what="the zoom to close")
            self._rows_painted(tab, f"un-zoomed #{cycle + 1}")
        self.driver.click(SPLIT_H)
        self.wait(lambda: self.leaf_count() == 2, what="the split")
        self._rows_painted(tab, "after the split")

    # ── MT-UI-44 ────────────────────────────────────────────────────────────
    def _images_painted(self, tab: str, want: bool, label: str) -> None:
        def grade(cap: TerminalCapture):
            screen = cap.measure["screenRect"]
            rect = cap.mapping.rect(
                screen["left"], screen["top"], screen["width"], screen["height"]
            )
            found = {
                name: has_color(cap.frame, rect, rgb, tolerance=40, min_pixels=MIN_IMAGE_PIXELS)
                for name, rgb in (("sixel", MAGENTA), ("iterm2", CYAN))
            }
            ok = all(v == want for v in found.values())
            return ok, [rect], f"painted: {found}, want {'both' if want else 'neither'}"

        self.wait_for_terminal_paint(grade, what=f"inline images ({label})", tab_id=tab)

    def _show_images(self, tab: str) -> None:
        self.wait(
            lambda: self.driver.terminal_input(f"cat ~/{IMAGES_FILE}", tab) is None,
            what="the shell to accept the cat",
        )
        self.wait_for_output("TH_IMG_AFTER", tab_id=tab)

    def _scroll_round_trip(self, tab: str, renderer: str) -> None:
        self._images_painted(tab, True, f"{renderer}, inline")
        self._seq(tab, 120)
        self._images_painted(tab, False, f"{renderer}, scrolled out")
        target: Optional[int] = None
        for r in self.driver.read_terminal_cells("TH_IMG_BEFORE", tab_id=tab):
            target = r["y"]
        assert target is not None, "the image marker left the scrollback"
        view = self.driver.terminal_viewport(tab)
        self.driver.scroll_terminal(target - view["viewportY"] - 1, tab_id=tab)
        self._images_painted(tab, True, f"{renderer}, scrolled back")
        self.driver.scroll_terminal(to_bottom=True, tab_id=tab)

    def test_inline_images_paint_scroll_and_repaint_on_both_renderers(self):
        """MT-UI-44: SIXEL and iTerm2 images draw inline and scroll with the text."""
        self.write_home_bytes(
            IMAGES_FILE, b"TH_IMG_BEFORE\n" + SIXEL + b"\n" + IIP + b"\nTH_IMG_AFTER\n"
        )
        tab = self._shell()
        images = self.driver.inspect_terminal(tab)["inlineImages"]
        assert images and images["active"], f"the image addon is not loaded: {images}"
        self._show_images(tab)
        self._scroll_round_trip(tab, "webgl")

        if self.driver.measure_terminal(tab).get("renderer") == "webgl":
            assert self.driver.lose_terminal_webgl_context(tab) is True
        self.wait(
            lambda: self.driver.measure_terminal(tab).get("renderer") == "dom",
            timeout=30,
            what="the DOM renderer",
        )
        self.run_command("clear")
        self._show_images(tab)
        self._scroll_round_trip(tab, "dom")

