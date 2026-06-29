"""Guided-manual tests for visual / rendering verification (issue #915).

Pixel- and timing-level rendering the DOM/store bridge cannot assert: glyph
shaping, ANSI colour fidelity, box-drawing joins, theme colours, scrollbar
styling. Following the guided-manual contract (#914), the harness sets up the
**exact** state — opens a terminal, emits the precise escape sequences, or
switches the theme — and then asks the operator only to *look* and confirm. Each
uses :meth:`manual_observe`, which attaches a screenshot to the report via the
bridge ``screenshot`` verb (#900) so the visual evidence is captured.

Covered: ANSI colours (MT-SSH-02), 256-colour (MT-SSH-02), box-drawing
(MT-UI-31), Nerd Font / Powerline glyphs (MT-SER-01/02), theme colours
(MT-UI-02..09), and vertical scrollbar appearance (MT-UI-35/36). The startup /
connect white-flash items (MT-UI-01, MT-LOCAL-05) and OS-level app-icon checks
remain follow-ups.

Marked ``manual`` + ``integration``, so they **skip** on CI / normal runs and
run only under ``./pytest.sh --manual -k visual -s`` with an operator.
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    ManualUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
)

pytestmark = [pytest.mark.integration, pytest.mark.manual]

# Literal glyphs interpolated into the printf command the harness sends to the
# shell; the operator confirms they render. Powerline separators (U+E0B0/B2) +
# a Nerd Font branch glyph (U+E0A0) for MT-SER; the box uses the U+2500
# box-drawing range, with the newline left escaped for printf to expand.
_POWERLINE = "  "
_BOX = "┌───┐\\n│ hi │\\n└───┘"


class TestVisualRendering(
    TerminalUi, TabsUi, SettingsUi, SidebarUi, ManualUi, SystemTest
):
    """Visual checks: harness emits the exact pixels, operator confirms them."""

    # ── ANSI colours (MT-SSH-02) ─────────────────────────────────────────────
    def test_ansi_colours_render(self):
        self.close_all_tabs()
        self.ensure_terminal()
        self.run_command(
            "printf '\\033[31mRED \\033[32mGREEN \\033[33mYELLOW "
            "\\033[34mBLUE \\033[35mMAGENTA \\033[36mCYAN \\033[1;37mBOLD\\033[0m\\n'"
        )
        self.wait_for_output("BOLD")
        self.manual_observe(
            "Look at the colour words on the output line.",
            "Each word is shown in its own colour (RED red, GREEN green, ...) and "
            "BOLD is bright/bold -- no mojibake or wrong colours.",
            label="ansi-colours",
        )

    # ── 256-colour (MT-SSH-02) ───────────────────────────────────────────────
    def test_256_colour_swatches_render(self):
        self.close_all_tabs()
        self.ensure_terminal()
        self.run_command(
            "printf '\\033[48;5;196m  \\033[48;5;46m  \\033[48;5;21m  "
            "\\033[48;5;226m  \\033[48;5;201m  \\033[0m 256-OK\\n'"
        )
        self.wait_for_output("256-OK")
        self.manual_observe(
            "Look at the row of coloured blocks before '256-OK'.",
            "Five distinct solid blocks (red, green, blue, yellow, magenta) -- "
            "proving 256-colour support, with no gaps between them.",
            label="ansi-256",
        )

    # ── Box-drawing characters (MT-UI-31) ────────────────────────────────────
    def test_box_drawing_characters_render(self):
        self.close_all_tabs()
        self.ensure_terminal()
        # A bordered box; the corners/edges must join into solid lines.
        self.run_command(f"printf '{_BOX}\\n'")
        self.wait_for_output("hi")
        self.manual_observe(
            "Look at the drawn box around 'hi'.",
            "The borders are continuous solid lines that meet cleanly at the "
            "corners -- no gaps, no broken segments between cells.",
            label="box-drawing",
        )

    # ── Nerd Font / Powerline glyphs (MT-SER-01/02) ──────────────────────────
    def test_powerline_glyphs_render(self):
        self.close_all_tabs()
        self.ensure_terminal()
        self.run_command(f"printf 'PL {_POWERLINE} END\\n'")
        self.wait_for_output("END")
        self.manual_observe(
            "Look at the glyphs between 'PL' and 'END'.",
            "If a Nerd Font / Powerline font is configured, they render as the "
            "arrow/branch glyphs (not empty boxes or 'tofu'). Note the configured "
            "font if they don't.",
            label="powerline-glyphs",
        )

    # ── Theme colours (MT-UI-02..09) ─────────────────────────────────────────
    def test_light_theme_applies(self):
        self.close_all_tabs()
        self.ensure_terminal()
        self.open_settings_category("appearance")
        self.driver.select("appearance-theme-select", "light")
        self.wait(
            lambda: self.driver.get_state("settings.theme") == "light",
            what="the light theme to apply",
        )
        try:
            self.manual_observe(
                "Look at the whole app window (sidebar, tabs, panels, status bar).",
                "Everything switched to the light theme -- light backgrounds with "
                "dark, readable text across all chrome, no leftover dark patches.",
                label="theme-light",
            )
        finally:
            # Restore the default so later suites start from a known theme.
            self.driver.select("appearance-theme-select", "dark")
            self.wait(
                lambda: self.driver.get_state("settings.theme") == "dark",
                what="the theme to restore to dark",
            )

    # ── Vertical scrollbar appearance (MT-UI-35/36) ──────────────────────────
    def test_vertical_scrollbar_appearance(self):
        self.close_all_tabs()
        self.ensure_terminal()
        # Fill well past one screen so a scrollbar is warranted, then scroll up.
        self.run_command('for i in $(seq 1 200); do echo "scrollback line $i"; done')
        self.wait_for_output("scrollback line 200")
        self.driver.scroll_terminal(-80)
        self.manual_observe(
            "Look at the terminal's right edge while scrolled up into history.",
            "A vertical scrollbar is visible with the app's unified styling -- no "
            "flicker/flash as it appears, no jarring default-OS scrollbar.",
            label="scrollbar",
        )
        self.driver.scroll_terminal(to_bottom=True)
