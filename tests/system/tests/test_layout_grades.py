"""Layout, scrollbar and zoom-overlay grades from measured geometry (#4930).

These replace guided checks an operator used to judge by eye. They read the
terminal's real render path through ``measure_terminal`` (grid, cell, gutter
thumb, text edge, horizontal bar), computed styles, and the store:

- MT-UI-16 — no black bar under the last terminal row;
- MT-UI-35 / MT-UI-36 — the vertical thumb shows only with scrollback and is
  the same gutter thumb in normal and horizontal-scroll modes;
- MT-UI-51 — the thumb sits in its own strip right of the text, the horizontal
  bar clears the last row, and the breadcrumb keeps the app's thin scrollbar;
- MT-UI-45 — the connections sidebar is laid out at first bridge contact after
  each of three cold launches (one at a narrow window);
- MT-UI-47 — inside the zoom overlay Escape reaches the terminal program, the
  title menu works, and only Shift+Escape closes the overlay;
- MT-UI-48 — the zoomed tab's title menu is live above the modal scrim.

Runs in the integration lane against the built app. Shell commands branch
between POSIX shells and the Windows default PowerShell.
"""

from __future__ import annotations

import sys
from typing import Any, Optional

import pytest

from termihub_harness import (
    ConnectionsUi,
    FilesUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    connection_item_testid,
    unique_name,
)
from termihub_harness.colors import parse_color, px, same_color

pytestmark = pytest.mark.integration

_WIN = sys.platform == "win32"
_ZOOM_MOD = {"meta": True} if sys.platform == "darwin" else {"ctrl": True}
CTX_HSCROLL = "tab-context-horizontal-scroll"
#: Terminal.css `--hscroll-bar`: the horizontal bar's height in that mode.
HSCROLL_BAR_PX = 10
# Prints READY, then reads ONE raw key and prints its code as K:<n> (ESC = 27).
# The READY marker is split in the typed text so only the output matches it.
_READ_ONE_KEY = (
    "Write-Output ('RE'+'ADY'); $k=[Console]::ReadKey($true); 'K:'+[int]$k.KeyChar"
    if _WIN
    else "echo RE''ADY; stty -echo raw; k=$(dd bs=1 count=1 2>/dev/null | od -An -tu1 | "
    "tr -d ' '); stty sane; echo K:$k"
)
_LONG_LINES = (
    # Enough lines to keep scrollback once horizontal mode stops wrapping them.
    "1..120 | ForEach-Object { 'x' * 400 }"
    if _WIN
    else "for i in $(seq 1 120); do printf 'x%.0s' $(seq 1 400); echo; done"
)


class TestLayoutGrades(ConnectionsUi, FilesUi, SidebarUi, TerminalUi, TabsUi, SystemTest):
    def reset_before_rerun(self) -> None:
        self.dismiss_modals("rename-dialog-cancel", "zoom-overlay")
        self.reset_tabs()

    # ── helpers ──────────────────────────────────────────────────────────────
    def _fresh_terminal(self) -> str:
        self.close_all_tabs()
        self.ensure_terminal()
        return self.switch_to_terminal_tab()["id"]

    def _measure_when(self, tab: str, ok, what: str) -> dict[str, Any]:
        last: dict[str, Any] = {}

        def probe() -> Optional[dict[str, Any]]:
            last.clear()
            last.update(self.driver.measure_terminal(tab))
            return dict(last) if ok(last) else None

        try:
            return self.wait(probe, what=what)
        except AssertionError as exc:
            raise AssertionError(f"{exc}; last measurement: {last}") from None

    def _settled(self, tab: str) -> dict[str, Any]:
        return self._measure_when(
            tab,
            lambda m: (m.get("cell") or {}).get("height")
            and m.get("proposed")
            and m["grid"] == m["proposed"],
            "the terminal fit to settle",
        )

    def _with_thumb(self, tab: str) -> dict[str, Any]:
        return self._measure_when(
            tab,
            lambda m: (m.get("scrollbar") or {}).get("thumbVisible") and m["baseY"] > 0,
            "the scrollbar thumb to show over real scrollback",
        )

    def _set_hscroll(self, tab: str, on: bool) -> None:
        def state() -> bool:
            return bool((self.driver.get_state("tabHorizontalScrolling") or {}).get(tab))

        if state() is on:
            return
        self.driver.context_menu(f"tab-{tab}")
        self.wait(lambda: self.driver.exists(CTX_HSCROLL), what="the tab context menu")
        self.driver.click(CTX_HSCROLL)
        self.wait(lambda: state() is on, what=f"horizontal scrolling {'on' if on else 'off'}")

    def _zoom(self, tab: str) -> None:
        self.driver.press_key("Enter", shift=True, **_ZOOM_MOD)
        self.wait(
            lambda: self.driver.get_state("zoomedTabId") == tab
            and self.driver.exists("zoom-overlay"),
            what="the zoom overlay",
        )

    # ── MT-UI-16 ─────────────────────────────────────────────────────────────
    def test_no_black_bar_at_terminal_bottom(self):
        """MT-UI-16: the grid fills the pane; spare pixels show the terminal background."""
        tab = self._fresh_terminal()
        self.run_command("echo bottom-bar-check")
        self.wait_for_output("bottom-bar-check")
        m = self._settled(tab)
        cell_h, rows, height = m["cell"]["height"], m["grid"]["rows"], m["container"]["height"]
        spare = height - rows * cell_h
        assert 0 <= spare < cell_h, f"{spare:.1f}px under the last row (cell {cell_h:.1f}px): {m}"
        paint = m["paint"]
        assert paint["rowsBottom"] is not None and paint["rowsBottom"] <= height + 0.5, paint
        assert paint["themeBackground"], paint
        assert same_color(
            parse_color(paint["containerBackground"]), parse_color(paint["themeBackground"])
        ), f"the strip under the rows is {paint['containerBackground']}, not the terminal bg"

    # ── MT-UI-35 / MT-UI-36 ──────────────────────────────────────────────────
    def test_vertical_scrollbar_only_with_scrollback_and_same_in_both_modes(self):
        """MT-UI-35 / MT-UI-36: thumb appears with scrollback; one gutter in both modes."""
        tab = self._fresh_terminal()
        self.run_command("clear" if not _WIN else "Clear-Host")
        before = self._measure_when(
            tab, lambda m: m.get("scrollbar") is not None and m["baseY"] == 0, "an empty buffer"
        )
        assert not before["scrollbar"]["thumbVisible"], before["scrollbar"]
        self.run_command("1..300" if _WIN else "seq 1 300")
        self.wait_for_output("300")
        normal = self._with_thumb(tab)["scrollbar"]
        self._set_hscroll(tab, True)
        try:
            wide = self._with_thumb(tab)["scrollbar"]
        finally:
            self._set_hscroll(tab, False)
        for key in ("gutterLeft", "gutterWidth", "thumbWidth", "thumbColor"):
            assert wide[key] == normal[key], f"{key}: {normal[key]} -> {wide[key]}"

    # ── MT-UI-51 ─────────────────────────────────────────────────────────────
    def test_terminal_and_breadcrumb_scrollbars_follow_global_style(self):
        """MT-UI-51: thumb in its own strip, horizontal bar clears the last row."""
        tab = self._fresh_terminal()
        self.run_command(_LONG_LINES)
        self.wait_for_output("x" * 60)
        self._settled(tab)
        m = self._with_thumb(tab)
        bar, paint = m["scrollbar"], m["paint"]
        assert bar["thumbLeft"] >= paint["textRight"] - 0.5, f"thumb over text: {bar} {paint}"
        self._set_hscroll(tab, True)
        try:
            m = self._measure_when(
                tab,
                lambda m: m["paint"]["horizontalScroll"]
                and m.get("proposed")
                and m["grid"]["cols"] > m["proposed"]["cols"],
                "the long lines to overflow the viewport horizontally",
            )
            bar, paint = m["scrollbar"], m["paint"]
            assert bar["thumbVisible"], bar
            assert bar["thumbLeft"] >= paint["textRight"] - 0.5, f"thumb over text: {bar} {paint}"
            # The strip under the last row holds the whole horizontal bar, whether
            # the engine lays it out (classic: it shrinks the client area) or
            # overlays it (GTK overlay scrollbars: client area unchanged).
            strip = paint["viewportClientBottom"] + paint["hscrollBarHeight"] - paint["rowsBottom"]
            assert strip >= HSCROLL_BAR_PX - 0.5, f"the horizontal bar covers the last row: {paint}"
        finally:
            self._set_hscroll(tab, False)
        self.open_file_browser()
        crumbs = "file-browser-current-path"
        self.wait(lambda: self.driver.exists(crumbs), what="the file browser breadcrumb")
        assert self.driver.get_computed_style("overflow-x", crumbs) == "auto"
        # The global `* { scrollbar-width: thin }` rule, where the engine exposes
        # it (WebKit before 18.2 resolves only ::-webkit-scrollbar, same tokens).
        width = self.driver.get_computed_style("scrollbar-width", crumbs)
        assert width in ("", "thin"), f"breadcrumb overrides the app scrollbar: {width!r}"

    # ── MT-UI-45 ─────────────────────────────────────────────────────────────
    def test_sidebar_paints_fully_on_cold_launch(self):
        """MT-UI-45: headers, filter and rows are laid out at first contact, 3 launches."""
        self.switch_to_connections_sidebar()  # the view a relaunch restores
        name = unique_name("cold")
        conn = self.create_local_connection(name)
        row = connection_item_testid(self.require_connection(conn)["id"])
        parts = ("sidebar", "connection-list-group-connections", "connection-filter-input", row)
        try:
            for launch in range(3):
                if launch == 1:
                    self.driver.resize_window(800, 600)  # one launch at a narrow window
                self.restart_app()
                self.wait(lambda: self.driver.exists(row), what="the saved connection row")
                for part in parts:
                    h = px(self.driver.get_computed_style("height", part))
                    w = px(self.driver.get_computed_style("width", part))
                    assert h > 0 and w > 0, f"launch {launch + 1}: {part} is {w}x{h} at first paint"
        finally:
            self.driver.resize_window(1280, 800)

    # ── MT-UI-47 ─────────────────────────────────────────────────────────────
    def test_zoom_overlay_leaves_escape_to_terminal(self):
        """MT-UI-47: Escape reaches the program; title menu works; Shift+Escape closes."""
        tab = self._fresh_terminal()
        self._zoom(tab)
        self.run_command(_READ_ONE_KEY)
        self.wait_for_output("READY", tab_id=tab)
        self.driver.press_key("Escape", f"terminal-input-{tab}")
        self.wait_for_output("K:27", tab_id=tab)
        assert self.driver.exists("zoom-overlay"), "plain Escape closed the zoom overlay"
        assert self.driver.get_state("zoomedTabId") == tab
        self.driver.context_menu("zoom-overlay-title")
        self.wait(lambda: self.driver.exists("zoom-context-set-color"), what="the title menu")
        self.driver.press_key("Escape")  # dismiss the menu only
        self.wait(lambda: not self.driver.exists("zoom-context-set-color"), what="menu closed")
        assert self.driver.exists("zoom-overlay"), "dismissing the title menu closed the overlay"
        self.driver.press_key("Escape", f"terminal-input-{tab}", shift=True)
        self.wait(
            lambda: not self.driver.exists("zoom-overlay")
            and not self.driver.get_state("zoomedTabId"),
            what="Shift+Escape to close the zoom overlay",
        )

    # ── MT-UI-48 ─────────────────────────────────────────────────────────────
    def test_context_menu_in_zoomed_terminal_above_overlay(self):
        """MT-UI-48: the zoomed title menu is live above the scrim and Rename works."""
        tab = self._fresh_terminal()
        self._zoom(tab)
        self.driver.context_menu("zoom-overlay-title")
        self.wait(lambda: self.driver.exists("zoom-context-rename"), what="the title menu")
        for item in ("zoom-context-rename", "zoom-context-set-color"):
            style = self.driver.get_computed_style
            # A menu portalled outside the modal inherits its pointer-events:none
            # and is dead under the scrim (#1868).
            assert style("pointer-events", item) != "none", f"{item} is under the scrim"
            assert style("visibility", item) == "visible", item
        self.driver.click("zoom-context-rename")
        self.wait(lambda: self.driver.exists("rename-dialog-cancel"), what="the rename dialog")
        self.driver.click("rename-dialog-cancel")
        self.wait(lambda: not self.driver.exists("rename-dialog-cancel"), what="rename closed")
        assert self.driver.exists("zoom-overlay"), "renaming closed the zoom overlay"
        self.driver.press_key("Escape", f"terminal-input-{tab}", shift=True)
        self.wait(lambda: not self.driver.exists("zoom-overlay"), what="the overlay to close")
