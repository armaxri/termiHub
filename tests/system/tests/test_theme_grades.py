"""Theme grades from computed styles, measured paint and canvas samples (#4930).

These replace guided look-and-feel checks an operator used to judge by eye.
Each reads what the WebView actually resolved — computed colours of the real
chrome, the terminal's measured gutter thumb, Monaco's root and gutter, the
latency chart's painted pixels — and grades it with the WCAG helpers in
:mod:`termihub_harness.colors`:

- MT-UI-02..09 — the Light theme reaches every piece of chrome (light
  surfaces, readable text);
- MT-UI-05 — the System theme follows an OS light/dark switch live (the OS
  appearance is flipped by :mod:`termihub_harness.os_appearance`, which only
  acts on a CI runner or with ``TERMIHUB_ALLOW_OS_APPEARANCE=1`` and always
  restores it);
- MT-UI-13 — the single panel's edge does not double against the sidebar;
- MT-UI-41 — scrollbar thumbs are visible at rest in every built-in theme;
- MT-UI-49 / MT-UI-52 — the editor follows the theme (light themes get a
  light editor; editor and gutter share the terminal background, live);
- MT-UI-50 — the latency chart and primary buttons follow a live theme switch.

Runs in the integration lane against the built app.
"""

from __future__ import annotations

import os
import re
import sys

import pytest

from termihub_harness import (
    EditorUi,
    FilesUi,
    NetworkToolsUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.colors import contrast, is_light, parse_color, px, same_color
from termihub_harness.os_appearance import AppearanceUnavailable, os_appearance
from termihub_harness.ui.theme import BUILTIN_THEMES, LIGHT_THEMES, ThemeUi, near

pytestmark = pytest.mark.integration

#: A thumb this far from its surface is distinguishable at rest. Every built-in
#: theme clears it (lowest: Solarized Light thumb over the sidebar, ~1.5:1);
#: a transparent-at-rest thumb (the #3144 regression) reads 1.0.
MIN_THUMB_CONTRAST = 1.4
#: WCAG AA for body text.
AA_TEXT = 4.5
#: WCAG AA for large text / UI components: the floor for the secondary-text
#: chrome (status bar), which sits at ~4.3:1 in Light.
UI_TEXT = 3.0
#: A border this close to its own surface is not a visible second line.
MAX_INVISIBLE_EDGE = 1.25

_LATENCY_CANVAS = "latency-chart-canvas"


class TestThemeGrades(
    ThemeUi,
    TerminalUi,
    TabsUi,
    SidebarUi,
    SettingsUi,
    EditorUi,
    FilesUi,
    NetworkToolsUi,
    SystemTest,
):
    def reset_before_rerun(self) -> None:
        self.dismiss_modals("theme-editor-dialog")
        self.reset_tabs()

    @pytest.fixture(autouse=True)
    def _restore_dark_theme(self):
        yield
        # Leave the default theme for the next test, whatever a grade did.
        try:
            if self.current_theme() not in ("dark", None):
                if self.current_theme() not in (*BUILTIN_THEMES, "system"):
                    self.delete_active_custom_theme()
                else:
                    self.set_theme("dark")
        except Exception:  # noqa: BLE001 - best effort; the next suite resets too
            pass

    # ── helpers ──────────────────────────────────────────────────────────────
    def _terminal_with_scrollback(self) -> str:
        self.close_all_tabs()
        self.ensure_terminal()
        self.run_command("1..300" if sys.platform == "win32" else "seq 1 300")
        self.wait_for_output("300")
        return self.switch_to_terminal_tab()["id"]

    def _visible_thumb(self, tab_id: str) -> dict:
        return self.wait(
            lambda: (lambda m: m if (m.get("scrollbar") or {}).get("thumbVisible") else None)(
                self.driver.measure_terminal(tab_id)
            ),
            what="the terminal's scrollbar thumb to show",
        )

    def _editor_tab(self) -> str:
        self.close_all_tabs()
        self.ensure_terminal()
        self.open_file_browser()
        name = f"{unique_name('look')}.py"
        self.create_file_via_browser(name)
        self.open_file_in_editor(name)
        self.wait(lambda: self.driver.exists("editor-surface"), what="the Monaco editor")
        tab = self.active_tab()
        assert tab is not None
        return tab["id"]

    def _show(self, tab_id: str) -> None:
        self.switch_to_tab(tab_id)
        self.wait(lambda: (self.active_tab() or {}).get("id") == tab_id, what="the tab to show")

    # ── MT-UI-02..09 ─────────────────────────────────────────────────────────
    def test_light_theme_applies_to_all_chrome(self):
        """MT-UI-02..09: every chrome surface turns light with readable text."""
        tab = self._terminal_with_scrollback()
        self.set_theme("light")
        self._show(tab)
        page = self.root_color("--bg-primary")
        assert is_light(page), f"--bg-primary {page} is not light"
        # Each surface paints its Light token (the theme reached it, no stale
        # dark value). The activity bar is dark in Light by design (VS Code
        # style), so only the content surfaces must also read as light.
        for surface, token, light in (
            ("activity-bar", "--activity-bar-bg", None),
            ("sidebar", "--sidebar-bg", True),
            ("tab-bar", "--tab-bg", True),
            ("status-bar", "--bg-secondary", True),
        ):
            bg = self.opaque_background(surface, page)
            assert same_color(bg, self.root_color(token)), f"{surface} {bg.hex()} is not {token}"
            if light:
                assert is_light(bg), f"{surface} background {bg.hex()} stayed dark in Light"
        for surface, minimum in (("sidebar", AA_TEXT), ("status-bar", UI_TEXT)):
            bg = self.opaque_background(surface, page)
            ratio = contrast(self.style_color("color", surface), bg)
            assert ratio >= minimum, f"{surface} text is {ratio:.2f}:1 on {bg.hex()}"
        tab_bg = self.opaque_background(f"tab-{tab}", self.opaque_background("tab-bar", page))
        ratio = contrast(self.style_color("color", f"tab-{tab}"), tab_bg)
        assert ratio >= AA_TEXT, f"active tab title is {ratio:.2f}:1 on {tab_bg.hex()}"
        paint = self.driver.measure_terminal(tab)["paint"]
        assert is_light(parse_color(paint["containerBackground"])), paint

    # ── MT-UI-05 ─────────────────────────────────────────────────────────────
    def test_os_theme_toggle_switches_app_live(self):
        """MT-UI-05: with the System theme, an OS appearance flip re-themes live."""
        try:
            with os_appearance() as appearance:
                appearance.set_dark(False)
                self.set_theme("system")
                for dark in (True, False, True):
                    appearance.set_dark(dark)
                    want = "dark" if dark else "light"
                    self.wait(
                        lambda: is_light(self.root_color("--bg-primary")) is not dark,
                        what=f"the System theme to turn {want} after the OS switch",
                    )
        except AppearanceUnavailable as exc:
            if sys.platform == "darwin" or not _on_ci():
                # macOS runners may refuse System Events automation, and a local
                # run without the opt-in must never touch the OS appearance.
                pytest.skip(f"OS appearance toggle unavailable: {exc}")
            raise AssertionError(f"the CI runner must be able to flip the OS appearance: {exc}")
        finally:
            self.set_theme("dark")

    # ── MT-UI-13 ─────────────────────────────────────────────────────────────
    def test_single_panel_border_blends_with_sidebar(self):
        """MT-UI-13: the lone panel's left edge and the sidebar edge read as one line."""
        self.close_all_tabs()
        self.ensure_terminal()
        self.switch_to_connections_sidebar()
        panel = self.driver.get_state("activePanelId")
        tid = f"panel-content-{panel}"
        for theme in BUILTIN_THEMES:
            self.set_theme(theme)
            style = self.driver.get_computed_style
            assert style("border-left-style", tid) == "solid"
            assert px(style("border-left-width", tid)) == 1.0
            assert same_color(
                self.style_color("border-left-color", tid), self.root_color("--panel-border")
            ), f"{theme}: the panel edge is not the panel-border token"
            sidebar_edge = px(style("border-right-width", "sidebar"))
            assert sidebar_edge <= 1.0, f"{theme}: sidebar edge {sidebar_edge}px"
            side_bg = self.opaque_background("sidebar", self.root_color("--bg-primary"))
            side_line = self.style_color("border-right-color", "sidebar")
            # At most one visible line: the sidebar's own edge either melts into
            # the sidebar or is the very same colour as the panel edge.
            invisible = contrast(side_line, side_bg) <= MAX_INVISIBLE_EDGE
            assert invisible or same_color(side_line, self.root_color("--panel-border")), (
                f"{theme}: two distinct lines (sidebar {side_line.hex()} + panel edge)"
            )

    # ── MT-UI-41 ─────────────────────────────────────────────────────────────
    def test_scrollbar_thumb_visible_at_rest_in_every_theme(self):
        """MT-UI-41: terminal, sidebar and Settings thumbs are visible without hover."""
        tab = self._terminal_with_scrollback()
        for theme in BUILTIN_THEMES:
            self.set_theme(theme)
            self._show(tab)
            m = self._visible_thumb(tab)
            bar, bg = m["scrollbar"], parse_color(m["paint"]["containerBackground"])
            ratio = contrast(parse_color(bar["thumbColor"]), bg)
            assert ratio >= MIN_THUMB_CONTRAST, f"{theme}: terminal thumb {ratio:.2f}:1"
            # The thumb lives inside its reserved gutter (no layout shift on hover).
            assert bar["gutterWidth"] > 0 and bar["thumbWidth"] > 0, bar
            assert bar["thumbLeft"] >= bar["gutterLeft"] - 0.5, bar
            assert bar["thumbLeft"] + bar["thumbWidth"] <= bar["gutterLeft"] + bar["gutterWidth"] + 0.5
            # Sidebar and Settings use the global ::-webkit-scrollbar rules with
            # the same tokens; grade the tokens against those surfaces.
            thumb, hover = self.root_color("--scrollbar-thumb"), self.root_color(
                "--scrollbar-thumb-hover"
            )
            for surface, base in (
                ("sidebar", self.root_color("--sidebar-bg")),
                ("settings", self.root_color("--bg-primary")),
            ):
                rest = contrast(thumb, base)
                assert rest >= MIN_THUMB_CONTRAST, f"{theme}: {surface} thumb {rest:.2f}:1"
                assert contrast(hover, base) > rest, f"{theme}: {surface} hover is not brighter"

    # ── MT-UI-49 / MT-UI-52 ──────────────────────────────────────────────────
    def test_every_light_theme_gets_a_light_editor(self):
        """MT-UI-49: Monaco is light in every light theme, dark in dark, incl. custom."""
        editor = self._editor_tab()
        for theme in ("solarized-light", "light", "dark", "solarized-dark"):
            self.set_theme(theme)
            self._show(editor)
            bg = self.style_color("background-color", "editor-surface")
            assert is_light(bg) is (theme in LIGHT_THEMES), f"{theme}: editor bg {bg.hex()}"
        self.set_theme("light")
        self.open_new_theme_editor()  # based on Light
        self.save_theme_editor()
        self._show(editor)
        bg = self.style_color("background-color", "editor-surface")
        assert is_light(bg), f"custom-from-Light theme gave a dark editor ({bg.hex()})"
        self.delete_active_custom_theme()

    def test_editor_background_matches_panes_in_every_theme(self):
        """MT-UI-52: editor and gutter share the terminal background, repainting live."""
        editor = self._editor_tab()
        for theme in BUILTIN_THEMES:
            self.set_theme(theme)
            self._show(editor)
            terminal_bg = self.root_color("--terminal-bg")
            for part in ("editor-surface", "editor-gutter"):
                bg = self.style_color("background-color", part)
                assert same_color(bg, terminal_bg), f"{theme}: {part} {bg.hex()} != {terminal_bg.hex()}"
        self.open_new_theme_editor()
        self.set_theme_token("terminalBg", "#123456")
        # Live preview: the open editor repaints without being reopened.
        self.wait(
            lambda: same_color(self.style_color("background-color", "editor-surface"), "#123456"),
            what="the open editor to repaint with the edited terminal background",
        )
        self.cancel_theme_editor()

    # ── MT-UI-50 ─────────────────────────────────────────────────────────────
    def test_charts_and_primary_buttons_follow_live_theme(self):
        """MT-UI-50: the live latency chart and Save Theme re-colour on a theme switch."""
        self.close_all_tabs()
        self.set_theme("dark")
        dark_accent, dark_grid = self.root_color("--accent-color"), self.root_color("--border-primary")
        self.start_ping("127.0.0.1")
        ping_tab = (self.active_tab() or {}).get("id")
        assert ping_tab, "the ping panel opened no tab"
        try:
            self.wait(lambda: self.driver.exists(_LATENCY_CANVAS), what="the latency chart")
            self.wait(
                lambda: near(self.canvas_pixels(_LATENCY_CANVAS), dark_accent) > 0,
                what="the chart to draw its trace in the dark accent",
            )
            received = _received(self.driver.get_text("ping-stats"))
            self.set_theme("light")
            light_accent = self.root_color("--accent-color")
            light_grid = self.root_color("--border-primary")
            self._show(ping_tab)

            def recoloured() -> bool:
                pixels = self.canvas_pixels(_LATENCY_CANVAS)
                return (
                    near(pixels, light_accent) > 0
                    and near(pixels, light_grid, 12) > 0
                    and near(pixels, dark_accent, 12) == 0
                    and near(pixels, dark_grid, 12) == 0
                )

            self.wait(recoloured, what="the chart to repaint in the light palette")
            self.wait(
                lambda: _received(self.driver.get_text("ping-stats")) > received,
                what="the chart to keep receiving samples after the switch",
            )
        finally:
            self.stop_ping()
        self.open_new_theme_editor()
        self.set_theme_token("accentColor", "#ffd700")
        self.wait(
            lambda: same_color(self.style_color("background-color", "theme-editor-save"), "#ffd700"),
            what="Save Theme to preview the yellow accent",
        )
        ratio = contrast(
            self.style_color("color", "theme-editor-save"),
            self.style_color("background-color", "theme-editor-save"),
        )
        assert ratio >= AA_TEXT, f"Save Theme text on #ffd700 is {ratio:.2f}:1"
        self.cancel_theme_editor()


def _received(stats: str | None) -> int:
    m = re.search(r"Received:\s*(\d+)", stats or "")
    return int(m.group(1)) if m else 0


def _on_ci() -> bool:
    return os.environ.get("GITHUB_ACTIONS", "").lower() == "true"
