"""Guided-manual look-and-feel checks: theme, paint, layout at real sizes (#913).

Ported from the retired ``tests/manual/ui-layout.yaml``. These are visual
judgements a DOM/store assertion cannot make: whether a colour reads well,
whether a GPU canvas repainted, whether a toolbar clipped at the minimum
width. The underlying rules are pinned by unit tests (named per item in
``docs/testing.md``); here the harness puts the app in the exact state (theme,
scrollback, zoom, split, a sample file in the editor, the Settings category)
and the operator looks.

Covered: MT-UI-40, MT-UI-42, MT-UI-44, MT-UI-46. The theme, layout and
scrollbar items (MT-UI-05, 13, 41, 43, 45, 47..52) are graded automatically by
``test_theme_grades.py`` / ``test_layout_grades.py`` /
``test_terminal_command_marks.py`` since #4930. MT-UI-54/55 (Settings layout)
and MT-UI-56 (imported workspace confirmations) are automated by the rendered
visual checks and unit tests (#4928), and MT-UI-53 (sidebar rows at real
widths) by the rendered visual checks (#4954).

Run with ``./pytest.sh --manual -k guided_look_and_feel -s``.
"""

from __future__ import annotations

import sys

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

pytestmark = [pytest.mark.integration, pytest.mark.manual]

THEME_SELECT = "appearance-theme-select"
_ZOOM = "Cmd+Shift+Enter" if sys.platform == "darwin" else "Ctrl+Shift+Enter"


class TestGuidedLookAndFeel(
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

    # ── MT-UI-42 / 44 / 46: macOS/WebGL paint ────────────────────────────────
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
