"""Guided-manual look-and-feel checks: theme, paint, layout at real sizes (#913).

Ported from the retired ``tests/manual/ui-layout.yaml``. These are visual
judgements a DOM/store assertion cannot make: whether a colour reads well,
whether a GPU canvas repainted, whether a toolbar clipped at the minimum
width. The underlying rules are pinned by unit tests (named per item in
``docs/testing.md``); here the harness puts the app in the exact state (theme,
scrollback, zoom, split, a sample file in the editor, the Settings category)
and the operator looks.

Covered: MT-UI-05, MT-UI-13, MT-UI-40..53. MT-UI-54/55 (Settings layout) and
MT-UI-56 (imported workspace confirmations) are automated by the rendered
visual checks and unit tests (#4928).

Run with ``./pytest.sh --manual -k guided_look_and_feel -s``.
"""

from __future__ import annotations

import sys

import pytest

from termihub_harness import (
    SETTINGS_REGION,
    ConnectionsUi,
    EditorUi,
    FilesUi,
    LayoutUi,
    ManualUi,
    NetworkToolsUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = [pytest.mark.integration, pytest.mark.manual]

THEME_SELECT = "appearance-theme-select"
SPLIT_H = "terminal-view-split-horizontal"
NEW_TERMINAL = "terminal-view-new-terminal"
_ZOOM = "Cmd+Shift+Enter" if sys.platform == "darwin" else "Ctrl+Shift+Enter"


class TestGuidedLookAndFeel(
    TerminalUi,
    TabsUi,
    LayoutUi,
    ConnectionsUi,
    SidebarUi,
    SettingsUi,
    EditorUi,
    FilesUi,
    NetworkToolsUi,
    ManualUi,
    SystemTest,
):
    """Harness sets the exact visual state; operator judges the paint."""

    def reset_before_rerun(self) -> None:
        self.reset_tabs()

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _theme(self, theme: str) -> None:
        self.open_settings_category("appearance")
        self.driver.select(THEME_SELECT, theme)
        self.wait(
            lambda: self.projection_region_cache(SETTINGS_REGION).get("theme") == theme,
            what=f"the {theme} theme",
        )

    def _terminal_with_scrollback(self) -> None:
        self.close_all_tabs()
        self.ensure_terminal()
        self.run_command("seq 1 500" if sys.platform != "win32" else "1..500")
        self.wait_for_output("500")

    def _sample_file_in_editor(self) -> str:
        self.ensure_terminal()
        self.open_file_browser()
        name = f"{unique_name('look')}.py"
        self.create_file_via_browser(name)
        self.open_file_in_editor(name)
        return name

    # ── MT-UI-05 / MT-UI-13 ──────────────────────────────────────────────────
    def test_os_theme_toggle_switches_app_live(self):
        """MT-UI-05."""
        self.close_all_tabs()
        self.ensure_terminal()
        self._theme("system")
        self.manual_step(
            "With the System theme selected, toggle the OS between dark and light mode.",
            "termiHub switches theme automatically, without a restart.",
        )
        self._theme("dark")

    def test_single_panel_border_blends_with_sidebar(self):
        """MT-UI-13."""
        self.close_all_tabs()
        self.ensure_terminal()
        self.wait(lambda: self.leaf_count() == 1, what="a single panel")
        self.manual_observe(
            "Look at the left border of the single terminal panel against the sidebar.",
            "It blends naturally against the sidebar edge.",
        )

    # ── MT-UI-40 / MT-UI-41: light/dark sweep and scrollbars ─────────────────
    def test_light_dark_look_sweep(self):
        """MT-UI-40."""
        self._theme("dark")
        self.restart_app()
        self.manual_observe(
            "The harness cold-relaunched the app in Dark.",
            "No white or grey flash on first paint; Dark is deep blue-charcoal with "
            "bright-blue accents.",
        )
        self.create_local_connection(unique_name("toast"))
        self.manual_step(
            "Hover the success toast and Tab to its close X. Then connect a remote agent "
            "(version badge), open a root-owned remote file (Read-only banner) and start a "
            "large SFTP download (Transfer Queue rows).",
            "The close X is top-right with visible hover and focus ring; badges, banner and "
            "queue colours are legible.",
        )
        self._theme("light")
        self.manual_step(
            "Re-check each surface in Light (the harness switched it), then answer.",
            "Every surface stays legible and on-theme in both Light and Dark.",
        )
        self._theme("dark")

    def test_scrollbar_thumb_visible_at_rest_in_every_theme(self):
        """MT-UI-41."""
        self._terminal_with_scrollback()
        for theme in ("dark", "light", "solarized-dark"):
            self._theme(theme)
            self.switch_to_terminal_tab()
            self.manual_step(
                f"Theme {theme}: look at the terminal, sidebar and Settings scrollbars; "
                "hover a thumb, then move away.",
                "The thumb is visible without hovering, brightens on hover and returns; no "
                "layout shift.",
            )
        self._theme("dark")

    # ── MT-UI-42..46: macOS/WebGL paint ──────────────────────────────────────
    @pytest.mark.manual(platforms=["macos"])
    def test_zoomed_terminal_repaints_without_scrolling(self):
        """MT-UI-42."""
        self.close_all_tabs()
        self.ensure_terminal()
        self.run_command("seq 1 200")
        self.wait_for_output("200")
        self.manual_step(
            f"Zoom the tab ({_ZOOM}) and un-zoom a few times; then split the view and drag "
            "the splitter.",
            "Content shows at once at the new size without scrolling; the split terminal "
            "reflows and repaints.",
        )

    @pytest.mark.manual(platforms=["macos"])
    def test_osc133_gutter_bars_and_jump_highlight(self):
        """MT-UI-43 (zsh)."""
        self.close_all_tabs()
        self.ensure_terminal()
        self.run_command("true")
        self.run_command("false")
        self.run_command("seq 1 200")
        self.wait_for_output("200")
        self.manual_step(
            "Look at the gutter next to `true` and `false`, then press Cmd+Up.",
            "A green bar by true, a red bar by false, no overlap; the seq prompt row is "
            "briefly highlighted.",
        )

    @pytest.mark.manual(platforms=["macos", "windows"])
    def test_inline_sixel_and_iterm2_images(self):
        """MT-UI-44."""
        self.close_all_tabs()
        self.ensure_terminal()
        how = (
            "In the default PowerShell tab `cat` a .six file and an iTerm2 image file "
            "(installed MSI, #4121)"
            if sys.platform == "win32"
            else "Run `img2sixel` on a PNG, then `imgcat` on a PNG"
        )
        self.manual_step(
            f"{how}. Scroll the images out of view and back. Repeat with the DOM renderer "
            "(Settings > Terminal).",
            "Both pictures draw inline followed by the prompt and scroll with the text on "
            "WebGL and DOM.",
        )

    @pytest.mark.manual(platforms=["macos"])
    def test_sidebar_paints_fully_on_cold_launch(self):
        """MT-UI-45."""
        self.enable_experimental_features()
        self.manual_step(
            "Save one remote agent (Agents section, + New Agent, any host).",
            "The agent is listed.",
        )
        for _ in range(3):
            self.restart_app()
            self.manual_observe(
                "The harness cold-relaunched the app (narrow the window before one of the "
                "launches).",
                "Headers, filter box and all rows are laid out on first paint; no resize is "
                "needed.",
            )

    def test_cjk_combining_rtl_emoji_on_webgl(self):
        """MT-UI-46 (Git Bash on Windows)."""
        self.close_all_tabs()
        self.ensure_terminal()
        self.run_command(
            "printf '日本語한국|\\ne\\314\\201a\\314\\210x|\\nשלום سلام|\\n"
            "👨\\342\\200\\215👩\\342\\200\\215👧|\\n'"
        )
        self.wait_for_output("שלום")
        self.manual_observe(
            "Look at the four printed lines.",
            "CJK fill two columns each and the '|' lines up; accents sit on é and ä; Hebrew "
            "and Arabic use a real font; the family shows three emoji in six columns.",
        )

    # ── MT-UI-47 / MT-UI-48: zoom overlay modality ───────────────────────────
    def test_zoom_overlay_leaves_escape_to_terminal(self):
        """MT-UI-47."""
        self.close_all_tabs()
        self.ensure_terminal()
        self.manual_step(
            f"Run `vim`, press i, zoom ({_ZOOM}). Press Escape, type `:q!` Enter. Run "
            "`less /etc/hosts`, wheel-scroll, quit. Tab through the overlay; right-click its "
            "title > Set Color…. Press Shift+Escape.",
            "Escape leaves insert mode and vim quits; the wheel scrolls less; Tab never "
            "reaches the panels behind; the menu works; Shift+Escape closes the overlay.",
        )

    def test_context_menu_in_zoomed_terminal_above_overlay(self):
        """MT-UI-48."""
        self.close_all_tabs()
        self.ensure_terminal()
        self.manual_step(
            f"Zoom the tab ({_ZOOM}); right-click its title in the overlay header; hover "
            "each item, pick Rename, press Escape. Close the overlay, open Open Connections "
            "with an SSH host that has monitoring on and click its refresh-interval button.",
            "The menu draws fully above the scrim and every item works; the refresh menu "
            "opens above the dialog and updates the label.",
        )

    # ── MT-UI-49..52: theme follows into editor, charts, scrollbars ──────────
    def test_every_light_theme_gets_a_light_editor(self):
        """MT-UI-49."""
        self.close_all_tabs()
        self._sample_file_in_editor()
        for theme, look in (("solarized-light", "light"), ("light", "light"), ("dark", "dark")):
            self._theme(theme)
            self.manual_step(
                f"Theme {theme}: look at the open editor tab.",
                f"The editor is {look} (background and code text match the theme).",
            )
        self.manual_step(
            "Create a custom theme based on Light, select it and look at the editor.",
            "The editor is light, not a dark block inside a light app.",
        )
        self._theme("dark")

    def test_charts_and_primary_buttons_follow_live_theme(self):
        """MT-UI-50."""
        self.close_all_tabs()
        self._theme("dark")
        self.start_ping("127.0.0.1")
        self.manual_step(
            "Let the latency chart draw, then switch Settings > Appearance to Light without "
            "closing it. Create a custom theme with Accent #ffd700 and watch Save Theme.",
            "The chart line, labels and grid switch to the light palette at once and keep "
            "updating; the yellow-accent button text turns dark and readable.",
        )
        self.stop_ping()
        self._theme("dark")

    def test_terminal_and_breadcrumb_scrollbars_follow_global_style(self):
        """MT-UI-51."""
        self._terminal_with_scrollback()
        self.manual_step(
            "Keep the pointer off the terminal and look at the right edge; print long lines "
            "(`yes $(printf x%.0s {1..300}) | head -50`); enable horizontal scrolling and "
            "scroll right; open the file browser deep enough for the breadcrumb to overflow "
            "and scroll it.",
            "The vertical thumb is visible at rest in its own strip, never over text; the "
            "horizontal thumb is visible and clears the last row; the breadcrumb shows the "
            "app's thin scrollbar.",
        )

    def test_editor_background_matches_panes_in_every_theme(self):
        """MT-UI-52."""
        self.close_all_tabs()
        self._sample_file_in_editor()
        self.driver.click(SPLIT_H)
        self.wait(lambda: self.leaf_count() == 2, what="two panels")
        self.driver.click(NEW_TERMINAL)
        for theme in ("dark", "light", "solarized-dark", "solarized-light"):
            self._theme(theme)
            self.manual_step(
                f"Theme {theme}: compare the editor, its gutter and minimap with the "
                "terminal pane.",
                "They share the terminal background; syntax colours are unchanged.",
            )
        self.manual_step(
            "Create a custom theme and change its Terminal background while watching the "
            "editor.",
            "The editor background repaints live without reopening the file.",
        )
        self._theme("dark")

    # ── MT-UI-53: sidebar rows at real widths ────────────────────────────────
    def test_every_sidebar_at_default_and_minimum_width(self):
        """MT-UI-53 (the row behaviour; fit and clipping are automated).

        The rendered visual checks (#4712, ``tests/visual/surfaces.spec.ts``)
        audit every sidebar at the default and minimum width at three window
        sizes for overflow, clipped controls and over-truncated names, and open
        each collapsed toolbar's overflow menu. They render no tunnel, service,
        HTTP monitor or agent rows and do not hover or focus rows, so the row
        behaviour stays here (#4928).
        """
        self.close_all_tabs()
        self.enable_experimental_features()
        self.manual_step(
            "Create a tunnel, a service, an HTTP monitor and a remote agent. Drag the "
            "sidebar edge to the minimum (or Home on the handle) and open each sidebar; "
            "hover and Tab onto rows; run each '…' overflow menu action.",
            "Names use the full row with a tooltip when cut; row actions show on hover and "
            "focus; the overflow actions run like the buttons.",
        )
