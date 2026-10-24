"""Guided-manual look-and-feel checks: theme, paint, layout at real sizes (#913).

Ported from the retired ``tests/manual/ui-layout.yaml``. These are visual
judgements a DOM/store assertion cannot make: whether a colour reads well,
whether a GPU canvas repainted, whether a toolbar clipped at the minimum
width. The underlying rules are pinned by unit tests (named per item in
``docs/testing.md``); here the harness puts the app in the exact state (theme,
scrollback, zoom, split, a sample file in the editor, the Settings category)
and the operator looks.

Covered: MT-UI-40, MT-UI-46, MT-UI-53. The theme, layout and scrollbar items
(MT-UI-05, 13, 41, 43, 45, 47..52) are graded automatically by
``test_theme_grades.py`` / ``test_layout_grades.py`` /
``test_terminal_command_marks.py`` since #4930. MT-UI-54/55 (Settings layout)
and MT-UI-56 (imported workspace confirmations) are automated by the rendered
visual checks and unit tests (#4928).

Native window capture (#4937, ``test_native_paint_grades.py``) automates the
zoom / split repaint (MT-UI-42), the inline images (MT-UI-44) and the
cold-launch white flash that MT-UI-40 used to open with. MT-UI-40 and MT-UI-46
are reduced to judging a saved image: the harness captures the window (by the
test app's PID) and attaches a Dark | Light contact sheet, or the WebGL | DOM
pair, so the operator confirms legibility and font choice from evidence that
shows the GPU canvas.

Run with ``./pytest.sh --manual -k guided_look_and_feel -s``.
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    SETTINGS_REGION,
    ConnectionsUi,
    ManualUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.ui.native_capture import NativeCaptureUi, save_sheet

pytestmark = [pytest.mark.integration, pytest.mark.manual]

THEME_SELECT = "appearance-theme-select"


class TestGuidedLookAndFeel(
    NativeCaptureUi,
    TerminalUi,
    TabsUi,
    ConnectionsUi,
    SidebarUi,
    SettingsUi,
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

    # ── MT-UI-40: light/dark sweep ───────────────────────────────────────────
    def test_light_dark_look_sweep(self):
        """MT-UI-40 (the cold-launch flash is graded automatically since #4937)."""
        self._theme("dark")
        self.create_local_connection(unique_name("toast"))
        self.manual_step(
            "Hover the success toast and Tab to its close X. Then connect a remote agent "
            "(version badge), open a root-owned remote file (Read-only banner) and start a "
            "large SFTP download (Transfer Queue rows).",
            "The close X is top-right with visible hover and focus ring; badges, banner and "
            "queue colours are legible.",
        )
        dark = self.try_capture_app_window()
        self._theme("light")
        sheet = save_sheet([dark, self.try_capture_app_window()], "dark-light")
        self.manual_observe(
            "Re-check each surface in Light (the harness switched it)"
            + (f"; the Dark | Light contact sheet is at {sheet}." if sheet else "."),
            "Every surface stays legible and on-theme in both Light and Dark.",
            evidence=sheet,
        )
        self._theme("dark")

    def test_cjk_combining_rtl_emoji_on_webgl(self):
        """MT-UI-46 (Git Bash on Windows).

        The cell layout is asserted by ``test_terminal_glyph_shaping.py``; this
        judges the fonts the renderers chose, from a WebGL | DOM contact sheet
        of the native window capture (#4937).
        """
        self.close_all_tabs()
        self.ensure_terminal()
        self.run_command(
            "printf '日本語한국|\\ne\\314\\201a\\314\\210x|\\nשלום سلام|\\n"
            "👨\\342\\200\\215👩\\342\\200\\215👧|\\n'"
        )
        self.wait_for_output("שלום")
        webgl = self.try_capture_app_window()
        tab = self.switch_to_terminal_tab()["id"]
        if self.driver.measure_terminal(tab).get("renderer") == "webgl":
            self.driver.lose_terminal_webgl_context(tab)
        self.wait(
            lambda: self.driver.measure_terminal(tab).get("renderer") == "dom",
            timeout=30,
            what="the DOM renderer",
        )
        sheet = save_sheet([webgl, self.try_capture_app_window()], "webgl-dom")
        self.manual_observe(
            "Look at the four printed lines"
            + (f" in the WebGL | DOM contact sheet ({sheet})." if sheet else " (now on DOM)."),
            "CJK fill two columns each and the '|' lines up; accents sit on é and ä; Hebrew "
            "and Arabic use a real font; the family shows three emoji in six columns — in "
            "both halves.",
            evidence=sheet,
        )

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
