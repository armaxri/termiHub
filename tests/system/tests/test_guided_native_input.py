"""Guided-manual native input: OS drag-and-drop, IME, emoji picker, focus (#913).

Ported from the retired ``tests/manual/native-input.yaml`` (TIN-017, #3764).
The bridge injects synthetic DOM events inside the webview, so three paths
never go through it: native OS file drops (Tauri reports physical screen
coordinates), IME composition (the OS input method owns the preedit and the
candidate window) and real window focus. This suite covers what the automated
OS-input and file-drop lanes cannot reach.

The harness builds the exact scene (split panes, shells, scratch files with
awkward names, an open editor, an open connection editor) and, where the result
is observable, asserts it afterwards: the connection saved with its IME-typed
name, the focus where it belongs. The operator performs the native gesture and judges what only
the screen shows (preedit placement, highlights, candidate window).

Covered: MT-NIN-02..04 (native file drag-and-drop on a scaled display, across
two displays, under Wayland), MT-NIN-10..14 and 16 (IME,
emoji picker), MT-NIN-21..24 (focus after the native Save dialog, a click into
an inactive window, per-window typing, remote-desktop key release on blur). The
IME commit-once logic is automated in ``test_ime_composition.py``. Real OS key
and pointer events retired MT-NIN-07 (tab tear-off), MT-NIN-15 (dead keys),
MT-NIN-20 (focus after an app switch), MT-NIN-30 (Windows right-click paste) and
MT-NIN-31 (real Caps Lock) into ``test_os_input_keyboard.py`` /
``test_os_input_pointer.py`` (#4935). Synthetic Tauri drag-drop events and real
X11 XDND drags retired MT-NIN-01, 05 and 06 into ``test_os_file_drop.py`` /
``test_os_file_drop_xdnd.py`` (#4936). MT-NIN-22/23 stay guided: injected clicks
did not move the window focus reliably on the CI runners (see #4935's PR).

Run with ``./pytest.sh --manual -k guided_native_input -s``.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import pytest

from termihub_harness import (
    ConnectionsUi,
    EditorUi,
    FilesUi,
    LayoutUi,
    ManualUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    WindowsUi,
    unique_name,
)
from termihub_harness.ui.windows import window_tabs

pytestmark = [pytest.mark.integration, pytest.mark.manual]

SPLIT_H = "terminal-view-split-horizontal"
NEW_TERMINAL = "terminal-view-new-terminal"
_MOD = "Cmd" if sys.platform == "darwin" else "Ctrl"


class TestGuidedNativeInput(
    TerminalUi,
    TabsUi,
    LayoutUi,
    ConnectionsUi,
    SidebarUi,
    EditorUi,
    FilesUi,
    WindowsUi,
    ManualUi,
    SystemTest,
):
    """Harness builds the scene and checks the outcome; operator does the native input."""

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _scratch_dir(self, prefix: str) -> Path:
        return Path(tempfile.mkdtemp(prefix=f"thub-{prefix}-"))

    def _two_shell_panes(self) -> None:
        self.close_all_tabs()
        self.ensure_terminal()
        self.driver.click(SPLIT_H)
        self.wait(lambda: self.leaf_count() == 2, what="two panes")
        self.driver.click(NEW_TERMINAL)
        self.wait(lambda: self.tab_count() >= 2, what="a shell in each pane")

    def _open_scratch_editor(self, label: str) -> str:
        """A local shell, its file browser, and a new text file open in the editor."""
        self.ensure_terminal()
        self.open_file_browser()
        name = f"{unique_name(label)}.txt"
        self.create_file_via_browser(name)
        self.open_file_in_editor(name)
        return name

    # ── MT-NIN-02..04: native file drag-and-drop on real displays ───────────
    def test_drop_targets_pane_under_cursor_on_scaled_display(self):
        """MT-NIN-02 (Retina / 150% / fractional scaling)."""
        self._two_shell_panes()
        dropped = self._scratch_dir("nin02") / "drop-scaled.txt"
        dropped.write_text("x\n", encoding="utf-8")
        # Hit-testing and the tab-bar case are automated at the runner's scale
        # (test_os_file_drop.py); only a real scaled display is left.
        self.manual_step(
            f"On a scaled (Retina / 150% / fractional) display, drag {dropped} slowly "
            "over the divider and drop it just inside the RIGHT pane.",
            "The highlight switches exactly at the divider and only the RIGHT shell "
            "gets the path.",
        )

    def test_drop_after_moving_window_to_other_scale_display(self):
        """MT-NIN-03 (two displays with different scale factors)."""
        self._two_shell_panes()
        dropped = self._scratch_dir("nin03") / "drop-dpi.txt"
        dropped.write_text("x\n", encoding="utf-8")
        self.manual_step(
            f"Drop {dropped} onto the RIGHT pane near the divider. Move the termiHub "
            "window fully onto the other display and drop again.",
            "On both displays the highlight and the drop land on the RIGHT pane with no "
            "offset.",
        )

    @pytest.mark.manual(platforms=["linux"])
    def test_linux_drop_under_wayland_and_x11(self):
        """MT-NIN-04 (a Wayland session; X11 is automated in test_os_file_drop_xdnd.py)."""
        self.close_all_tabs()
        self.ensure_terminal()
        self.open_file_browser()
        self.manual_step(
            "In a Wayland session (`echo $XDG_SESSION_TYPE` says wayland), drop a file "
            "from Files/Dolphin onto the terminal, then onto the file-browser listing. "
            "Then drag a file-browser row out onto the desktop.",
            "The terminal gets the quoted path, the listing copies the file with the "
            "highlight showing while hovering, and the dragged-out row lands as a copy.",
        )

    # ── MT-NIN-10..14, 16: IME, emoji picker ─────────────────────────────────
    def _ime_in_terminal(self, setup: str, convert: str) -> None:
        self.close_all_tabs()
        self.ensure_terminal()
        self.manual_step(
            f"{setup} In the terminal type `echo `, switch to the IME, {convert}, press "
            "Enter once, then Enter again. Then compose `tesuto`, press Escape and switch "
            "back.",
            "Preedit and candidate window sit at the terminal cursor; the first Enter only "
            "commits (日本語 once, nothing runs); the second runs it and prints it once; "
            "Escape inserts nothing.",
        )

    @pytest.mark.manual(platforms=["macos"])
    def test_macos_japanese_ime_in_terminal(self):
        """MT-NIN-10."""
        self._ime_in_terminal(
            "Add 'Japanese – Romaji' (System Settings > Keyboard > Input Sources).",
            "type `nihongo` and Space to convert",
        )

    @pytest.mark.manual(platforms=["windows"])
    def test_windows_japanese_ime_in_terminal(self):
        """MT-NIN-11."""
        self._ime_in_terminal(
            "Add Japanese with Microsoft IME (Settings > Time & language).",
            "turn on Hiragana (Alt+`), type `nihongo` and Space to convert",
        )

    @pytest.mark.manual(platforms=["linux"])
    def test_linux_ime_in_terminal_wayland_and_x11(self):
        """MT-NIN-12 (repeat in an X11 session)."""
        self._ime_in_terminal(
            "Enable Fcitx5 or IBus with Mozc or Pinyin, in a Wayland session first.",
            "type `nihongo` (Mozc) or `zhongwen` (Pinyin) and pick the first candidate",
        )

    def test_ime_composition_in_file_editor(self):
        """MT-NIN-13."""
        self.close_all_tabs()
        name = self._open_scratch_editor("ime-editor")
        self.manual_step(
            f"In the editor ({name}) type `abc `, compose `nihongo`, convert and Enter. "
            f"Compose again and press {_MOD}+S while the preedit is open; commit, then "
            f"press {_MOD}+S.",
            "The preedit sits at the caret; Enter inserts 日本語 once without a newline; "
            "save does not fire while composing; after commit it saves.",
        )
        self.wait(lambda: not self.editor_tab_dirty(self.active_tab()["id"]), what="the save")

    def test_ime_enter_and_escape_in_a_form_field(self):
        """MT-NIN-14."""
        self.close_all_tabs()
        self.open_new_connection_editor()
        self.manual_step(
            "In the Name field compose `tesuto` and press Escape. Compose `nihongo`, "
            "convert with Space and press Enter, then press Enter again.",
            "Escape only discards the preedit; the first Enter only commits (the editor "
            "stays open); the second saves.",
        )
        self.wait(lambda: self.find_connection("日本語"), what="the connection named 日本語")

    def test_os_emoji_picker_inserts_into_terminal_and_editor(self):
        """MT-NIN-16."""
        self.close_all_tabs()
        self._open_scratch_editor("emoji")
        tab = self.switch_to_terminal_tab()
        picker = {"darwin": "Ctrl+Cmd+Space", "win32": "Win+."}.get(sys.platform, "Ctrl+.")
        self.manual_step(
            f"In the terminal type `echo `, open the emoji picker ({picker}), pick 👍 and "
            "press Enter. Repeat the insertion in the editor tab.",
            "👍 appears once on the prompt line and in the editor, and focus returns after "
            "the picker closes.",
        )
        assert "👍" in self.wait_for_output("👍", tab_id=tab["id"])

    # ── MT-NIN-21..24: native focus ──────────────────────────────────────────
    def test_focus_returns_after_native_save_dialog(self):
        """MT-NIN-21."""
        self.close_all_tabs()
        self.ensure_terminal()
        self.run_command("echo hello")
        self.wait_for_output("hello")
        self.manual_step(
            f"Right-click the tab > Open in Editor. Press {_MOD}+S, then Escape, then type "
            f"`one`. Press {_MOD}+S again, save to a scratch folder with Enter, type `two`.",
            "macOS shows a sheet, others a dialog; `one` and `two` land at the editor caret "
            "and the tab shows the saved name.",
        )

    def test_click_into_inactive_window_focuses_clicked_pane(self):
        """MT-NIN-22."""
        self._two_shell_panes()
        self.manual_step(
            "Click into the LEFT shell, click another app's window, then click once into "
            "the RIGHT shell and type `abc`.",
            "Windows/Linux: `abc` lands in the RIGHT pane. macOS: it lands in whichever "
            "pane is drawn focused. Never in an unfocused pane.",
        )

    def test_typing_goes_only_to_focused_window(self):
        """MT-NIN-23."""
        self.close_all_tabs()
        self.ensure_terminal()
        second = self.open_new_window()
        second.click(NEW_TERMINAL)
        self.wait(lambda: window_tabs(second), what="a shell in the second window")
        main_before = len(window_tabs(self.driver))
        second_before = len(window_tabs(second))
        self.manual_step(
            f"Place the windows side by side. Type `aaa` in window A's shell and `bbb` in "
            f"window B's. With B focused press {_MOD}+Shift+`.",
            "`aaa` shows only in A and `bbb` only in B.",
        )
        self.wait(lambda: len(window_tabs(second)) == second_before + 1, what="the new tab in B")
        assert len(window_tabs(self.driver)) == main_before, "window A gained a tab"

    def test_remote_desktop_releases_held_keys_on_blur(self):
        """MT-NIN-24 (a real VNC/RDP host with a text editor open)."""
        self.close_all_tabs()
        self.manual_step(
            "Connect a VNC or RDP tab to a real host with a text editor open; focus the "
            "remote editor. Hold Shift, switch to another app, release Shift there, switch "
            "back, click the canvas and type `abc`.",
            "The remote editor receives lowercase abc and the canvas takes input after one "
            "click.",
        )
