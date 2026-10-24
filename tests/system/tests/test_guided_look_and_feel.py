"""Guided-manual look-and-feel checks: theme, paint, layout at real sizes (#913).

Ported from the retired ``tests/manual/ui-layout.yaml``. These are visual
judgements a DOM/store assertion cannot make: whether a colour reads well,
whether a GPU canvas repainted, whether a toolbar clipped at the minimum
width. The underlying rules are pinned by unit tests (named per item in
``docs/testing.md``); here the harness puts the app in the exact state (theme,
scrollback, zoom, split, a sample file in the editor, the Settings category)
and the operator looks.

Covered: MT-UI-40, MT-UI-42, MT-UI-44, MT-UI-46, MT-UI-53..56. The theme, layout
and scrollbar items (MT-UI-05, 13, 41, 43, 45, 47..52) are graded automatically
by ``test_theme_grades.py`` / ``test_layout_grades.py`` /
``test_terminal_command_marks.py`` since #4930.

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

    # ── MT-UI-53..56: layout at real widths, Settings ────────────────────────
    def test_every_sidebar_at_default_and_minimum_width(self):
        """MT-UI-53."""
        self.close_all_tabs()
        self.enable_experimental_features()
        self.manual_step(
            "Create workspaces 'test' and 'ssh-production-cluster', a macro, a scheduled "
            "workflow, a tunnel, a service, an HTTP monitor and a remote agent. Open every "
            "sidebar at the default width, then drag the edge to the minimum (or Home on "
            "the handle) and open every sidebar again; hover and Tab onto rows; use the '…' "
            "overflow menus.",
            "Nothing clips; overflowing toolbars keep the main action plus one '…' menu; "
            "names use the full row with a tooltip when cut; row actions show on hover and "
            "focus; Schedules/History/agent headers keep their buttons; the overflow actions "
            "run like the buttons.",
        )

    def test_settings_fields_styled_on_fresh_start(self):
        """MT-UI-54."""
        self.restart_app()
        self.open_settings_tab()
        self.manual_step(
            "Without opening any connection editor, visit every Settings category; narrow "
            "the Settings tab to ~420 px for General and Sessions; then open a new SSH "
            "connection editor.",
            "Toggle rows: label + hint left, control right; input rows: label, control, "
            "hint; the SSH key '…' button joins its input; action buttons sit right; the "
            "connection editor is unchanged.",
        )

    def test_settings_headers_keep_buttons_at_minimum_window(self):
        """MT-UI-55."""
        self.open_settings_category("external-files")
        self.manual_step(
            "Resize the window to its minimum (800x600). Look at the External Connection "
            "Files header and click Create File; check File Types, Custom Grammars and "
            "Shell Integration headers; then widen until the header fits one row.",
            "Buttons wrap below the title and stay clickable; the create prompt keeps its "
            "field usable; other headers wrap too; once wide enough, title and buttons share "
            "one row.",
        )

    def test_imported_workspace_confirmations_review_and_revoke(self):
        """MT-UI-56."""
        self.close_all_tabs()
        self.manual_step(
            "Import a workspace whose tab has an initialCommand (echo hello), open it in the "
            "workspace editor and Confirm the command.",
            "The command shows as confirmed.",
        )
        self.open_settings_category("security")
        self.manual_step(
            "In 'Imported Workspace Confirmations' click the trash icon > Revoke; reopen the "
            "workspace editor and launch the workspace; confirm again, then Revoke All. "
            "Repeat the look at 800x600.",
            "It first lists '1 imported item is confirmed…'; after revoking nothing is "
            "confirmed and launching waits for Confirm; Revoke All empties the list; nothing "
            "clips at 800x600.",
        )
        # After Revoke All, settings.json no longer holds any confirmed entry.
        assert not self.persisted_settings().get("workspaceImportAllowlist")
