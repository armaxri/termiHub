"""A full-screen TUI always fits the visible pane (#5065).

A full-screen program (Claude Code, Ink, vim) lays out every row to the width
it reads from its terminal. When that width is wider than the grid the pane
shows, each row's tail is cut off at the pane's right edge. This grade runs
such a program — ``tui_width_probe.mjs``: alternate screen, every row placed
with CUP and filled with a ruler of exactly ``process.stdout.columns`` cells,
redrawn on every resize — and compares three widths:

- the PTY width the program sees (its header row ``<tag>:<cols>x<rows>:``);
- xterm's grid (``measure_terminal``), which must equal the fit proposal;
- the columns actually visible in the pane: the grid's left edge to the right
  edge of ``visibleRect`` (the window, clipped by every clipping ancestor).

Each ruler row must read back as exactly the grid's ruler (``…|`` in the last
column) — after the first open, a split, zoom and unzoom, a tab switch and a
window resize. The program is Node (what Claude Code runs on), started from the
platform's default shell: PowerShell under ConPTY on Windows.

Runs in the integration lane against the built app.
"""

from __future__ import annotations

import itertools
import math
import re
import shutil
import sys
from pathlib import Path
from typing import Any, Optional

import pytest

from termihub_harness import SystemTest, TabsUi, TerminalUi

pytestmark = pytest.mark.integration

PROBE = Path(__file__).resolve().parents[1] / "termihub_harness" / "tui_probe" / "tui_width_probe.mjs"
_ZOOM_MOD = {"meta": True} if sys.platform == "darwin" else {"ctrl": True}
SPLIT = "terminal-view-split-horizontal"
LARGE_WINDOW = (1280, 800)
SMALL_WINDOW = (800, 600)
#: Rounding slack when converting the visible px width into whole columns.
PX_EPSILON = 0.5
#: Budget for the program to redraw at the terminal's new grid.
FRAME_TIMEOUT = 30.0

_tags = itertools.count(1)


def ruler(cols: int) -> str:
    """The probe's ruler row for ``cols`` columns (see tui_width_probe.mjs)."""
    return "".join(str(i % 10) for i in range(1, cols)) + "|"


class TestTuiWidthGrades(TerminalUi, TabsUi, SystemTest):
    def reset_before_rerun(self) -> None:
        self.dismiss_modals("zoom-overlay")
        self.driver.resize_window(*LARGE_WINDOW)
        self.reset_tabs()

    # ── helpers ──────────────────────────────────────────────────────────────
    def _start_tui(self) -> tuple[str, str]:
        """Open a fresh terminal, start the probe in it; return (tab id, tag)."""
        if shutil.which("node") is None:
            pytest.fail("node is not on PATH; the TUI probe needs it")
        self.close_all_tabs()
        self.ensure_terminal()
        tab = self.switch_to_terminal_tab()["id"]
        tag = f"TUIW{next(_tags)}"
        self.run_command(f"node '{PROBE}' {tag}")
        self.wait(lambda: self._header(tab, tag), what="the TUI probe's first frame")
        return tab, tag

    def _quit_tui(self, tab: str, tag: str) -> None:
        self.driver.terminal_input("q", tab)
        self.wait_for_output(f"{tag}:done", tab_id=tab)

    def _header(self, tab: str, tag: str) -> Optional[tuple[int, int]]:
        rows = self.driver.read_terminal_cells(tab_id=tab)
        match = re.match(rf"{tag}:(\d+)x(\d+):", rows[0]["text"]) if rows else None
        return (int(match.group(1)), int(match.group(2))) if match else None

    def _reading(self, tab: str, tag: str) -> dict[str, Any]:
        """One reading of the three widths and the drawn frame."""
        m = self.driver.measure_terminal(tab)
        rows = [r["text"] for r in self.driver.read_terminal_cells(tab_id=tab)]
        grid = m["grid"]
        cell = (m.get("cell") or {}).get("width") or 0
        screen, visible = m.get("screenRect"), m.get("visibleRect")
        visible_cols = None
        right = visible["left"] + visible["width"] if visible else None
        if cell > 0 and screen and right is not None:
            visible_cols = math.floor((right - screen["left"] + PX_EPSILON) / cell)
        # The DOM renderer paints glyphs, not cells, and clips each row at the
        # grid's edge: text wider than its cells is cut off there even when the
        # grid itself fits the pane.
        text_right = m.get("domTextRight")
        overflow = 0.0
        if text_right is not None and right is not None and screen and cell > 0:
            edge = min(right, screen["left"] + grid["cols"] * cell)
            overflow = round(text_right - edge, 1)
        match = re.match(rf"{tag}:(\d+)x(\d+):", rows[0]) if rows else None
        program = (int(match.group(1)), int(match.group(2))) if match else None
        expected = ruler(grid["cols"])
        rulers = rows[1 : grid["rows"] - 1]
        bad = [(i + 2, r) for i, r in enumerate(rulers) if r != expected]
        return {
            "program": program,
            "grid": (grid["cols"], grid["rows"]),
            "proposed": m.get("proposed"),
            "visibleCols": visible_cols,
            "textOverflowPx": overflow,
            "cell": cell,
            "renderer": m.get("renderer"),
            "dpr": (m.get("page") or {}).get("devicePixelRatio"),
            "rulerRows": len(rulers),
            "badRows": bad[:3],
        }

    @staticmethod
    def _fits(r: dict[str, Any]) -> bool:
        cols, rows = r["grid"]
        return (
            r["program"] == (cols, rows)
            and r["proposed"] == {"cols": cols, "rows": rows}
            and r["visibleCols"] is not None
            and cols <= r["visibleCols"]
            and r["rulerRows"] > 0
            and not r["badRows"]
            and r["textOverflowPx"] <= PX_EPSILON
        )

    def _assert_fits(self, tab: str, tag: str, when: str) -> dict[str, Any]:
        """Wait until the program's width, the grid and the visible pane agree."""
        last: dict[str, Any] = {}

        def probe() -> Optional[dict[str, Any]]:
            last.clear()
            last.update(self._reading(tab, tag))
            return dict(last) if self._fits(last) else None

        try:
            return self.wait(probe, timeout=FRAME_TIMEOUT, what=f"the TUI to fit the pane {when}")
        except AssertionError as exc:
            raise AssertionError(f"{exc}; last reading {when}: {last}") from None

    # ── grades ───────────────────────────────────────────────────────────────
    def test_tui_fits_the_pane_on_first_open(self):
        tab, tag = self._start_tui()
        self._assert_fits(tab, tag, "on first open")
        self._quit_tui(tab, tag)

    def test_tui_fits_the_pane_after_a_split(self):
        tab, tag = self._start_tui()
        before = self._assert_fits(tab, tag, "before the split")
        self.driver.click(SPLIT)
        after = self.wait(
            lambda: (lambda r: r if self._fits(r) and r["grid"][0] < before["grid"][0] else None)(
                self._reading(tab, tag)
            ),
            timeout=FRAME_TIMEOUT,
            what="the TUI to fit the narrower split pane",
        )
        assert after["grid"][0] < before["grid"][0], (before, after)
        self._quit_tui(tab, tag)

    def test_tui_fits_the_pane_through_zoom_and_unzoom(self):
        tab, tag = self._start_tui()
        self._assert_fits(tab, tag, "before zoom")
        self.driver.press_key("Enter", shift=True, **_ZOOM_MOD)
        self.wait(lambda: self.driver.get_state("zoomedTabId") == tab, what="the zoom overlay")
        self._assert_fits(tab, tag, "while zoomed")
        self.driver.press_key("Escape", f"terminal-input-{tab}", shift=True)
        self.wait(lambda: not self.driver.get_state("zoomedTabId"), what="the zoom to close")
        self._assert_fits(tab, tag, "after unzoom")
        self._quit_tui(tab, tag)

    def test_tui_fits_the_pane_after_a_tab_switch(self):
        tab, tag = self._start_tui()
        self._assert_fits(tab, tag, "before the tab switch")
        self.open_new_terminal()
        self.wait(lambda: (self.active_tab() or {}).get("id") != tab, what="the second tab")
        self.switch_to_tab(tab)
        self._assert_fits(tab, tag, "after switching back")
        self._quit_tui(tab, tag)

    def test_tui_fits_the_pane_after_a_resize_while_hidden(self):
        tab, tag = self._start_tui()
        try:
            self.driver.resize_window(*LARGE_WINDOW)
            self._assert_fits(tab, tag, "before hiding the tab")
            self.open_new_terminal()
            self.wait(lambda: (self.active_tab() or {}).get("id") != tab, what="the second tab")
            self.driver.resize_window(*SMALL_WINDOW)
            self.switch_to_tab(tab)
            self._assert_fits(tab, tag, "when shown after a resize while hidden")
        finally:
            self.driver.resize_window(*LARGE_WINDOW)
        self._quit_tui(tab, tag)

    def test_tui_fits_the_pane_on_the_dom_renderer(self):
        """The DOM renderer (no WebGL: VMs, remote sessions, a lost context) fits too."""
        tab, tag = self._start_tui()
        self._assert_fits(tab, tag, "before the renderer swap")
        if self.driver.measure_terminal(tab).get("renderer") == "webgl":
            assert self.driver.lose_terminal_webgl_context(tab), "no WebGL context to lose"
            self.wait(
                lambda: self.driver.measure_terminal(tab).get("renderer") == "dom",
                timeout=30.0,
                what="the DOM renderer fallback",
            )
        self._assert_fits(tab, tag, "on the DOM renderer")
        self._quit_tui(tab, tag)

    def test_tui_fits_the_pane_after_window_resizes(self):
        tab, tag = self._start_tui()
        try:
            self.driver.resize_window(*LARGE_WINDOW)
            self._assert_fits(tab, tag, "at the large window")
            self.driver.resize_window(*SMALL_WINDOW)
            self._assert_fits(tab, tag, "after shrinking the window")
            self.driver.resize_window(*LARGE_WINDOW)
            self._assert_fits(tab, tag, "after growing the window back")
        finally:
            self.driver.resize_window(*LARGE_WINDOW)
        self._quit_tui(tab, tag)
