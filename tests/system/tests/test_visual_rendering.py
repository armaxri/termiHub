"""Guided-manual tests for visual / rendering verification (issues #915, #1003).

Pixel- and timing-level rendering the DOM/store bridge cannot assert: glyph
shaping, ANSI colour fidelity, box-drawing joins, theme colours, scrollbar
styling and the startup white-flash. Following the guided-manual contract (#914),
the harness sets up the **exact** state — opens a terminal, emits the precise
escape sequences, switches the theme, or performs a cold relaunch — and then asks
the operator only to *look* and confirm. Each uses :meth:`manual_observe`, which
attaches a screenshot to the report via the bridge ``screenshot`` verb (#900) so
the visual evidence is captured.

Covered (#915): ANSI colours (MT-SSH-02), 256-colour (MT-SSH-02), box-drawing
(MT-UI-31) and Nerd Font / Powerline glyphs (MT-SER-01/02).

Added (#1003): no startup white-flash (MT-UI-01). It is a timing-level check
that stays operator-confirmed, but the harness still automates everything around
it — the cold relaunch and showing the screen — so the operator only has to
*look*. The OS-level app icon (MT-UI-19) is graded on the shipped artifacts by
the release install smokes since #4933, and the SSH connect / setup-command flash
(MT-LOCAL-05) is automated since #4931 by the raw output tap
(``test_output_flash_and_flood.py``). Theme colours (MT-UI-02..09), the vertical
scrollbar (MT-UI-35/36) and the black bar at the terminal bottom (MT-UI-16) are
graded automatically since #4930 (``test_theme_grades.py`` /
``test_layout_grades.py``).

Marked ``manual`` + ``integration``, so they **skip** on CI / normal runs and
run only under ``./pytest.sh --manual -k visual -s`` with an operator.
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    ConnectionsUi,
    ManualUi,
    PasswordPromptUi,
    SidebarUi,
    SshUi,
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
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SshUi,
    ManualUi,
    SystemTest,
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

    # ── No startup white-flash (MT-UI-01) ────────────────────────────────────
    def test_no_startup_white_flash(self):
        """Cold-relaunch the app; the operator watches the window background.

        The white-flash is a paint-timing artefact between the OS window
        appearing and the web view's first paint — invisible to the DOM/store
        bridge, so it stays operator-confirmed. The harness still automates the
        only setup that matters: a real kill-and-relaunch via ``restart_app``,
        so the operator just has to watch the window come up. They should keep
        their eyes on the window *before* triggering the prompt response, as the
        relaunch already happened — re-run the case if they missed it.
        """
        self.close_all_tabs()
        # A genuine cold start: kill the app and bring it back up. This is the
        # exact event MT-UI-01 checks; everything the operator needs is now on
        # screen, so they only have to recall what they just saw.
        self.restart_app()
        self.manual_observe(
            "Recall the window you just watched relaunch (re-run if you looked "
            "away — the app was killed and relaunched a moment ago).",
            "The window came up with the dark background (#1e1e1e) already "
            "painted -- no white flash between the OS window appearing and the "
            "app's first paint.",
            label="startup-no-white-flash",
        )
