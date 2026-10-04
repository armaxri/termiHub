"""Browser-only xterm render paths: fit, cell size, painting, scrollbar (#2988).

``src/components/Terminal/Terminal.xterm-integration.test.ts`` runs the real
xterm under jsdom, which has no layout engine and no canvas. There
``FitAddon.proposeDimensions()`` returns ``undefined``, the renderer's cell is
``0`` wide, nothing paints and the gutter scrollbar has a 0-px track. This suite
asserts the same paths in the real WebView, read through the read-only
``measure_terminal`` bridge verb:

- ``FitAddon`` proposes a real, non-degenerate grid for the laid-out container,
  the terminal is sized to it, and the **PTY** reports the same size
  (``stty size``) — before and after a window resize;
- the renderer's measured cell (``xtermDimensions.getRenderedCellWidth``, the
  horizontal-scroll width math) is a real positive size that tiles the container;
- the live renderer paints: the DOM renderer's rows carry the output, or the
  WebGL canvas is sized to the grid; a forced WebGL context loss
  (``lose_terminal_webgl_context``) falls back to the DOM renderer, which then
  paints both the old buffer and new output;
- the ``createTerminalScrollbar`` thumb has the right size and position against
  the real gutter with real scrollback, at the bottom, top and middle.

Every step waits on a condition, never a fixed sleep: renderer measurement,
fit, PTY resize and thumb updates are all asynchronous (rAF / IPC). POSIX shell
only (``stty``, ``seq``, ``$((…))``): Git Bash on Windows, skipped without it.
Runs in the integration lane against the built app (nightly), not per-PR CI.
"""

from __future__ import annotations

import itertools
import re
from typing import Any, Callable, Optional

import pytest

from termihub_harness import (
    ConnectionsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration

#: ``MIN_SAFE_FIT_COLS`` in ``safeFit.ts`` — below this a fit is degenerate.
MIN_SAFE_FIT_COLS = 20
#: ``MIN_THUMB_PX`` in ``terminalScrollbar.ts``.
MIN_THUMB_PX = 20
#: Layout tolerance for sub-pixel rounding of laid-out geometry, in CSS px.
PX_TOLERANCE = 1.5
#: Horizontal space the fit reserves besides whole cells: the ``.xterm`` side
#: padding (2 x ``--spacing-sm``) plus xterm's scrollbar allowance. Generous on
#: purpose; the assertion is that the cells fill the container, not the exact px.
FIT_SLACK_PX = 48
#: xterm waits ~3 s for a context restore before firing ``onContextLoss``.
CONTEXT_LOSS_TIMEOUT = 30.0
#: Window sizes for the resize check; both comfortably above a degenerate fit.
#: SMALL is the app's minimum window (tauri.conf ``minWidth``/``minHeight``): a
#: hosted macOS runner's screen clamps LARGE's height to roughly 680 px, so a
#: 680-px "small" window was no shorter at all and the rows never changed.
LARGE_WINDOW = (1280, 900)
SMALL_WINDOW = (800, 600)

_pty_probe_ids = itertools.count(1)


class TestTerminalRenderPaths(TerminalUi, TabsUi, SidebarUi, ConnectionsUi, SystemTest):
    # -- setup -------------------------------------------------------------

    def _open_shell(self) -> str:
        """Open a fresh POSIX local shell and return its tab id."""
        self.close_all_tabs()
        shell = self.posix_shell_name()
        name = unique_name("render")
        self.switch_to_connections_sidebar()
        self.create_local_connection(name, shell=shell, connect=True)
        tab = self.wait(lambda: self.find_tab(name), what=f"the {name!r} terminal tab")
        tab_id = tab["id"]
        self.wait(
            lambda: self.driver.read_terminal(tab_id).strip(),
            what="the shell prompt",
        )
        return tab_id

    def _measure(self, tab_id: str) -> dict[str, Any]:
        return self.driver.measure_terminal(tab_id)

    def _settled(self, tab_id: str) -> Optional[dict[str, Any]]:
        """A measurement once the fit has settled, else None (keep waiting).

        Settled means the renderer measured a real cell, ``FitAddon`` proposes
        a non-degenerate grid, and the terminal is sized to exactly that grid.
        """
        m = self._measure(tab_id)
        proposed = m.get("proposed")
        width = (m.get("cell") or {}).get("width") or 0
        if not proposed or width <= 0:
            return None
        if proposed["cols"] < MIN_SAFE_FIT_COLS or proposed["rows"] < 1:
            return None
        return m if m["grid"] == proposed else None

    def _wait_settled(self, tab_id: str, what: str = "the terminal fit to settle") -> dict:
        """Wait for :meth:`_settled`; on timeout, name the last measurement.

        A bare "timed out" hides *why* the fit never settled (degenerate cell,
        grid != proposed, …), so the failure carries the final reading.
        """
        try:
            return self.wait(lambda: self._settled(tab_id), what=what)
        except AssertionError as exc:
            raise AssertionError(f"{exc}; last measurement: {self._measure(tab_id)!r}") from exc

    def _pty_size(self, tab_id: str) -> tuple[int, int]:
        """Ask the shell for its PTY size (``stty size``) → ``(rows, cols)``.

        The probe tag is unique per call and the echoed command line carries
        ``$(stty size)`` unexpanded, so only the shell's answer matches.
        """
        tag = f"PTYSZ{next(_pty_probe_ids)}"
        self.run_command(f'echo "{tag}:$(stty size)"')
        pattern = re.compile(rf"{tag}:(\d+) (\d+)")
        match = self.wait(
            lambda: pattern.search(self.driver.read_terminal(tab_id)),
            what=f"the {tag} stty answer",
        )
        return int(match.group(1)), int(match.group(2))

    def _wait_pty_matches(self, tab_id: str, grid: dict[str, int]) -> None:
        """Wait until the PTY reports ``grid`` (a resize reaches it via IPC)."""
        expected = (grid["rows"], grid["cols"])
        self.wait(
            lambda: self._pty_size(tab_id) == expected,
            what=f"the PTY to report {expected[0]} rows x {expected[1]} cols",
        )

    # -- fit + PTY ---------------------------------------------------------

    def test_fit_proposes_a_real_grid_and_the_pty_matches_it(self):
        """FitAddon measures the laid-out container; terminal and PTY use it."""
        tab_id = self._open_shell()
        m = self._wait_settled(tab_id)
        assert m["grid"]["cols"] >= MIN_SAFE_FIT_COLS, m
        assert m["grid"]["rows"] >= 5, m
        assert m["container"]["width"] > 0 and m["container"]["height"] > 0, m
        self._wait_pty_matches(tab_id, m["grid"])

    def test_window_resize_refits_the_terminal_and_resizes_the_pty(self):
        """A smaller window re-fits to a smaller real grid and the PTY follows."""
        tab_id = self._open_shell()
        try:
            self.driver.resize_window(*LARGE_WINDOW)
            large = self._wait_settled(tab_id, what="the fit at the large window")

            self.driver.resize_window(*SMALL_WINDOW)
            small = self.wait(
                lambda: (lambda m: m if m and m["grid"]["cols"] < large["grid"]["cols"] else None)(
                    self._settled(tab_id)
                ),
                what="the terminal to re-fit to the smaller window",
            )
            assert small["container"]["width"] < large["container"]["width"], (large, small)
            # Rows follow the container height. The OS may clamp the large
            # window to the screen, so only demand fewer rows when the container
            # really lost at least one cell of height.
            lost_px = large["container"]["height"] - small["container"]["height"]
            if lost_px >= large["cell"]["height"]:
                assert small["grid"]["rows"] < large["grid"]["rows"], (large, small)
            else:
                assert small["grid"]["rows"] <= large["grid"]["rows"], (large, small)
            self._wait_pty_matches(tab_id, small["grid"])
        finally:
            self.driver.resize_window(*LARGE_WINDOW)

    # -- cell measurement --------------------------------------------------

    def test_rendered_cell_is_a_real_size_that_tiles_the_container(self):
        """The renderer's measured cell is positive and the grid fills the box.

        ``getRenderedCellWidth`` feeds the horizontal-scroll width math; it is
        ``0`` under jsdom. Here it must be a real size with which the fitted
        columns/rows fill the container without overflowing it.
        """
        tab_id = self._open_shell()
        m = self._wait_settled(tab_id)
        cell_w, cell_h = m["cell"]["width"], m["cell"]["height"]
        box_w, box_h = m["container"]["width"], m["container"]["height"]
        cols, rows = m["grid"]["cols"], m["grid"]["rows"]

        assert 2 < cell_w < 64, m
        assert cell_h is not None and 4 < cell_h < 128, m
        # The fitted grid never overflows the container…
        assert cols * cell_w <= box_w + PX_TOLERANCE, m
        assert rows * cell_h <= box_h + PX_TOLERANCE, m
        # …and fills it up to less than one cell plus the reserved padding.
        assert box_w - cols * cell_w < cell_w + FIT_SLACK_PX, m
        assert box_h - rows * cell_h < cell_h + FIT_SLACK_PX, m

    # -- painting ----------------------------------------------------------

    def _wait_dom_painted(self, tab_id: str, text: str) -> None:
        self.wait(
            lambda: any(text in row for row in (self._measure(tab_id).get("domRows") or [])),
            what=f"the DOM renderer to paint {text!r}",
        )

    def test_live_renderer_paints_output(self):
        """The DOM renderer paints the bytes, or the WebGL canvas spans the grid."""
        tab_id = self._open_shell()
        # `$((…))` keeps the painted answer off the echoed command line.
        self.run_command("echo PAINTED_$((40+2))")
        self.wait_for_output("PAINTED_42", tab_id=tab_id)
        m = self._wait_settled(tab_id)

        if m["renderer"] == "dom":
            self._wait_dom_painted(tab_id, "PAINTED_42")
            return

        assert m["renderer"] == "webgl", m
        canvas = m["webglCanvas"]
        assert canvas is not None, "webgl renderer is live but has no canvas"
        assert m["domRows"] is None, "the DOM renderer still mounted under WebGL"
        # The backing store is in device px (>= CSS px) and covers the grid.
        assert canvas["width"] + PX_TOLERANCE >= m["grid"]["cols"] * m["cell"]["width"], m
        assert canvas["height"] + PX_TOLERANCE >= m["grid"]["rows"] * m["cell"]["height"], m

    def test_webgl_context_loss_falls_back_to_a_painting_dom_renderer(self):
        """A real GPU context loss swaps in the DOM renderer, which keeps painting."""
        tab_id = self._open_shell()
        m = self._wait_settled(tab_id)
        if m["renderer"] != "webgl":
            pytest.skip(
                "this WebView provides no WebGL2 context, so the DOM renderer is "
                "already live (painting covered by test_live_renderer_paints_output)"
            )

        self.run_command("echo BEFORE_LOSS_$((1+1))")
        self.wait_for_output("BEFORE_LOSS_2", tab_id=tab_id)
        assert self.driver.lose_terminal_webgl_context(tab_id) is True

        self.wait(
            lambda: (lambda r: r["renderer"] == "dom" and r["webglCanvas"] is None)(
                self._measure(tab_id)
            ),
            timeout=CONTEXT_LOSS_TIMEOUT,
            what="the renderer to fall back to DOM after the context loss",
        )
        # The DOM renderer repaints the existing buffer…
        self._wait_dom_painted(tab_id, "BEFORE_LOSS_2")
        # …and paints new output.
        self.run_command("echo AFTER_LOSS_$((2+1))")
        self._wait_dom_painted(tab_id, "AFTER_LOSS_3")
        # The fallback keeps a real measured fit.
        self._wait_settled(tab_id, what="the fit to stay settled on the DOM renderer")

    # -- scrollbar ---------------------------------------------------------

    @staticmethod
    def _expected_thumb(m: dict[str, Any]) -> tuple[float, float]:
        """``computeThumbGeometry`` for a measurement → ``(height, top)``."""
        track = m["scrollbar"]["trackHeight"]
        rows, base_y, viewport_y = m["grid"]["rows"], m["baseY"], m["viewportY"]
        if base_y <= 0 or track <= 0:
            return 0.0, 0.0
        height = min(track, max(MIN_THUMB_PX, track * rows / (base_y + rows)))
        travel = track - height
        return height, (travel * viewport_y / base_y if travel > 0 else 0.0)

    def _thumb_matches(self, tab_id: str, at: Callable[[dict[str, Any]], bool]) -> Optional[dict]:
        """The measurement once the scroll position satisfies ``at`` and the
        thumb's laid-out geometry matches what that position implies."""
        m = self._measure(tab_id)
        bar = m.get("scrollbar")
        if not bar or not bar["thumbVisible"] or not at(m):
            return None
        height, top = self._expected_thumb(m)
        if abs(bar["thumbHeight"] - height) > PX_TOLERANCE:
            return None
        return m if abs(bar["thumbTop"] - top) <= PX_TOLERANCE else None

    def _wait_thumb(self, tab_id: str, at: Callable[[dict[str, Any]], bool], what: str) -> dict:
        return self.wait(lambda: self._thumb_matches(tab_id, at), what=what)

    def test_scrollbar_thumb_tracks_real_scrollback(self):
        """The gutter thumb is sized and placed right against a laid-out track."""
        tab_id = self._open_shell()
        m = self._wait_settled(tab_id)
        bar = m["scrollbar"]
        assert bar is not None, "the scrollbar gutter is not mounted"
        assert bar["trackHeight"] > 0, "the gutter track was not laid out"

        # The `$((…))` sentinel prints only after seq finished.
        self.run_command("seq 1 400; echo SEQ_DONE_$((9*9))")
        self.wait_for_output("SEQ_DONE_81", tab_id=tab_id)
        self.wait(
            lambda: self._measure(tab_id)["baseY"] >= 300,
            what="real scrollback above the viewport",
        )

        # Pinned to the bottom: the thumb sits at the end of the track.
        self.driver.scroll_terminal(to_bottom=True, tab_id=tab_id)
        bottom = self._wait_thumb(
            tab_id, lambda r: r["viewportY"] == r["baseY"], "the thumb at the bottom of the track"
        )
        bar = bottom["scrollbar"]
        assert MIN_THUMB_PX - PX_TOLERANCE <= bar["thumbHeight"] < bar["trackHeight"], bottom
        assert abs(bar["thumbTop"] + bar["thumbHeight"] - bar["trackHeight"]) <= PX_TOLERANCE

        # Scrolled to the top: the thumb sits at the start of the track.
        self.driver.scroll_terminal(-(bottom["baseY"] + 100), tab_id=tab_id)
        top = self._wait_thumb(
            tab_id, lambda r: r["viewportY"] == 0, "the thumb at the top of the track"
        )
        assert abs(top["scrollbar"]["thumbTop"]) <= PX_TOLERANCE, top

        # Halfway: the thumb is placed proportionally in between.
        half = top["baseY"] // 2
        self.driver.scroll_terminal(half, tab_id=tab_id)
        middle = self._wait_thumb(
            tab_id, lambda r: r["viewportY"] == half, "the thumb halfway down the track"
        )
        mid_bar = middle["scrollbar"]
        assert 0 < mid_bar["thumbTop"] < mid_bar["trackHeight"] - mid_bar["thumbHeight"], middle

        self.driver.scroll_terminal(to_bottom=True, tab_id=tab_id)
