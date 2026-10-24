"""Automated OS-input grades: real keyboard events at the test instance (#4935).

The bridge's ``pressKey`` dispatches synthetic DOM events, which never pass
through the OS keyboard layout, the input method or window focus. These grades
inject **real** key events with :mod:`termihub_harness.os_input` — XTEST on the
CI Xvfb display (with a window manager), ``CGEventPostToPid`` on macOS,
``SendInput`` on Windows — aimed at the test instance's PID only, and grade
what reached the shell, the editor file on disk and the OS clipboard.

Retires the guided checks MT-NIN-15 (dead keys), MT-NIN-20 (focus after an app
switch), MT-NIN-23 (typing reaches only the focused window), MT-NIN-31 (real
Caps Lock), MT-SHI-02 (external spawn raises the window), MT-KB-01..04 (copy
and paste shortcuts) and MT-LOCAL-08 (macOS key repeat).

Integration lane (nightly); on a developer machine the suite skips unless
``TERMIHUB_OS_INPUT_GLOBAL=1`` says nothing else is on the display.
"""

from __future__ import annotations

import re
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import pytest

from termihub_harness import (
    ConnectionsUi,
    EditorUi,
    FilesUi,
    OsInputUi,
    PasswordPromptUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    WindowsUi,
    read_os_clipboard,
    unique_name,
)
from termihub_harness.os_input import HelperWindow, primary_modifier
from termihub_harness.ui.os_input_ui import linux_window_manager, terminal_echo
from termihub_harness.ui.terminal import NEW_TERMINAL
from termihub_harness.ui.windows import CLOSE_DIALOG_END, window_tabs

pytestmark = pytest.mark.integration

MOD = primary_modifier()
#: Copy / paste in a terminal: Cmd+C/V on macOS, Ctrl+Shift+C/V elsewhere.
COPY = "cmd+c" if sys.platform == "darwin" else "ctrl+shift+c"
PASTE = "cmd+v" if sys.platform == "darwin" else "ctrl+shift+v"


@pytest.fixture(scope="class", autouse=True)
def _window_manager():
    with linux_window_manager():
        yield


class TestOsKeyboardGrades(
    OsInputUi,
    TerminalUi,
    TabsUi,
    ConnectionsUi,
    SidebarUi,
    EditorUi,
    FilesUi,
    PasswordPromptUi,
    WindowsUi,
    SystemTest,
):
    """Real key events into the test instance, graded from what arrived."""

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _shell(self, folder: Path | None = None) -> str:
        """A fresh local shell (optionally ``cd``-ed into ``folder``); its tab id."""
        self.close_all_tabs()
        self.wait(lambda: self.tab_count() == 0, what="every tab to close")
        self.ensure_terminal()
        tab = self.active_tab()
        assert tab is not None
        if folder is not None:
            self.run_command(f'cd "{folder}"')
        return tab["id"]

    def _focus_terminal(self, tab_id: str, screen=None) -> None:
        self.os_click(f"terminal-renderer-{tab_id}", screen=screen)

    def _wait_echo(self, tab_id: str, tag: str, *, driver=None) -> str:
        driver = driver or self.driver
        return self.wait(
            lambda: (lambda got: None if got is None else [got])(
                terminal_echo(driver.read_terminal(tab_id), tag)
            ),
            what=f"the {tag} echo",
        )[0]

    def _close_window(self, driver) -> None:
        """Close a secondary window, ending its sessions if it asks."""
        if driver.window_label not in self.driver.windows():
            return
        driver.close_window()
        try:
            self.wait(lambda: driver.exists(CLOSE_DIALOG_END), timeout=5.0, what="close dialog")
            driver.click(CLOSE_DIALOG_END)
        except AssertionError:
            pass
        self.wait(lambda: len(self.driver.windows()) == 1, what="the window to close")

    def _scratch_editor(self, folder: Path) -> Path:
        """Open a new empty file in ``folder`` in the editor; return its path."""
        self.open_file_browser()
        self.wait_for_path_contains(folder.name)
        name = f"{unique_name('osinput')}.txt"
        self.create_file_via_browser(name)
        self.open_file_in_editor(name)
        return folder / name

    def _wait_file(self, path: Path, expected: str) -> None:
        self.wait(
            lambda: path.read_text(encoding="utf-8").strip() == expected,
            what=f"{path.name} to hold {expected!r} (has "
            f"{path.read_text(encoding='utf-8') if path.exists() else None!r})",
        )

    @contextmanager
    def _dead_key_layout(self) -> Iterator[tuple[list[list[str]], str]]:
        """The layout's dead-key sequences and the text they compose."""
        osi = self.os_input()
        if sys.platform == "darwin":
            # ABC/US layout: Option+E and Option+U are the acute and umlaut dead keys.
            yield [["alt+e", "e"], ["alt+u", "u"]], "éü"
            return
        if sys.platform == "win32":
            from termihub_harness.os_input.windows import KLID_US_INTERNATIONAL

            previous = osi.set_layout(KLID_US_INTERNATIONAL)  # type: ignore[attr-defined]
            try:
                # US-International: ' is dead acute, Shift+' dead diaeresis.
                yield [["'", "e"], ["shift+'", "u"]], "éü"
            finally:
                if previous:
                    osi.post_layout(previous)  # type: ignore[attr-defined]
            return
        layout = osi.current_layout()  # type: ignore[attr-defined]
        osi.set_layout("us", "intl")  # type: ignore[attr-defined]
        try:
            # US-International: the ' key is dead_acute, Shift+' dead_diaeresis.
            # xdotool presses the key that carries the keysym in the active map.
            yield [["dead_acute", "e"], ["dead_diaeresis", "u"]], "éü"
        finally:
            osi.set_layout(*layout)  # type: ignore[attr-defined]

    def _press(self, sequences: list[list[str]]) -> None:
        osi = self.os_input()
        for sequence in sequences:
            for combo in sequence:
                osi.key(combo)

    # ── MT-NIN-15: dead keys ─────────────────────────────────────────────────
    def test_dead_keys_compose_once_in_terminal_and_editor(self):
        """MT-NIN-15: a dead key and its letter arrive as one composed character,
        with no bare accent before it, in the terminal and in the editor."""
        osi = self.os_input()
        folder = Path(tempfile.mkdtemp(prefix="thub-deadkey-"))
        tab_id = self._shell(folder)
        screen = self.os_activate()
        self._focus_terminal(tab_id, screen)
        with self._dead_key_layout() as (sequences, expected):
            osi.type_text("echo DK_")
            self._press(sequences)
            osi.type_text("_\n")
            assert self._wait_echo(tab_id, "DK") == expected

            path = self._scratch_editor(folder)
            self.focus_editor()
            time.sleep(0.5)  # let Monaco's input take the focus before the first key
            self._press(sequences)
            osi.key(f"{MOD}+s")
            self._wait_file(path, expected)

    @pytest.mark.skipif(not sys.platform.startswith("linux"), reason="X keyboard maps (Linux)")
    def test_german_layout_altgr_and_dead_circumflex(self):
        """German layout (the maintainer's): AltGr+E types € and the ^ dead key
        composes â, through the real X keyboard map."""
        osi = self.os_input()
        tab_id = self._shell()
        self._focus_terminal(tab_id, self.os_activate())
        layout = osi.current_layout()  # type: ignore[attr-defined]
        osi.set_layout("de")  # type: ignore[attr-defined]
        try:
            osi.type_text("echo DE_")
            osi.key("altgr+e")
            osi.key("dead_circumflex")
            osi.key("a")
            osi.type_text("_\n")
        finally:
            osi.set_layout(*layout)  # type: ignore[attr-defined]
        assert self._wait_echo(tab_id, "DE") == "€â"

    # ── MT-NIN-31: real Caps Lock ────────────────────────────────────────────
    def test_real_caps_lock_toggles_password_warning(self):
        """MT-NIN-31: the real Caps Lock key shows the password prompt's Caps Lock
        warning, and pressing it again hides it."""
        osi = self.os_input()
        self.close_all_tabs()
        name = unique_name("capslock")
        self.create_ssh_connection(
            name, host="127.0.0.1", port=1, username="osinput", auth_method="password"
        )
        self.switch_to_connections_sidebar()
        self.connect_connection(name)
        self.wait(lambda: self.driver.exists("password-prompt-input"), what="the password prompt")
        warning = "password-prompt-input-caps-lock"
        screen = self.os_activate()
        self.os_click("password-prompt-input", screen=screen)
        engaged = False
        try:
            osi.key("caps_lock")
            engaged = True
            osi.type_text("a")
            self.wait(lambda: self.driver.exists(warning), what="the Caps Lock warning")
            osi.key("caps_lock")
            engaged = False
            osi.type_text("b")
            self.wait(lambda: not self.driver.exists(warning), what="the warning to clear")
        finally:
            if engaged:
                osi.key("caps_lock")
            self.cancel_password_prompt()

    # ── MT-KB-01..04: copy / paste shortcuts, plain Ctrl+C ───────────────────
    def test_copy_paste_shortcuts_and_plain_ctrl_c(self):
        """MT-KB-01, MT-KB-03: the platform copy shortcut (Cmd+C on macOS,
        Ctrl+Shift+C on Windows/Linux) puts the terminal selection on the OS
        clipboard. MT-KB-02, MT-KB-04: the paste shortcut (Cmd+V / Ctrl+Shift+V)
        types it once. Plain Ctrl+C still interrupts the running command, and the
        tab menu's Copy puts the whole buffer on the OS clipboard."""
        osi = self.os_input()
        tab_id = self._shell()
        marker = f"KBMARK{uuid.uuid4().hex[:10]}"
        self.run_command(f"echo {marker}")
        # The echoed command line may wrap; wait for the output line itself.
        self.wait(
            lambda: self.driver.read_terminal(tab_id).count(marker) >= 2,
            what="the marker's output line",
        )
        screen = self.os_activate()
        self.os_select_terminal_word(tab_id, marker, screen)
        osi.key(COPY)
        self.wait(
            lambda: marker in (read_os_clipboard() or ""),
            what=f"{marker!r} on the OS clipboard",
        )

        # Reading the clipboard can raise a console window (Windows PowerShell).
        screen = self.os_activate()
        self._focus_terminal(tab_id, screen)
        osi.type_text("echo PASTE_")
        osi.key(PASTE)
        osi.type_text("_\n")
        assert self._wait_echo(tab_id, "PASTE") == marker

        # A click clears the selection: Ctrl+C with a selection copies instead.
        self._focus_terminal(tab_id, screen)
        sleeper = "Start-Sleep 60" if sys.platform == "win32" else "sleep 60"
        osi.type_text(f"{sleeper}\n")
        self.wait(lambda: "sleep 60" in self.driver.read_terminal(tab_id).lower(), what="sleep")
        osi.key("ctrl+c")
        osi.type_text("echo INT_ok_\n")
        assert self._wait_echo(tab_id, "INT") == "ok"

        self.driver.context_menu(f"tab-{tab_id}")
        self.wait(lambda: self.driver.exists("tab-context-copy"), what="the tab context menu")
        self.driver.click("tab-context-copy")
        self.wait(
            lambda: "INT_ok_" in (read_os_clipboard() or ""), what="the buffer on the clipboard"
        )

    # ── MT-NIN-20: focus survives an app switch ──────────────────────────────
    def test_focus_survives_app_switch(self):
        """MT-NIN-20: switching to another app and back returns typing to the
        shell (and to the editor caret) without a click."""
        osi = self.os_input()
        folder = Path(tempfile.mkdtemp(prefix="thub-focus-"))
        tab_id = self._shell(folder)
        with HelperWindow() as helper:
            osi.allow_pid(helper.pid)
            screen = self.os_activate()
            self._focus_terminal(tab_id, screen)

            osi.activate(helper.pid)
            self.wait(lambda: not self.has_focus(), what="termiHub to lose focus")
            osi.type_text("zz", pid=helper.pid)
            helper.wait_typed("zz")
            osi.activate(window=screen.window)
            self.wait(self.has_focus, what="termiHub to regain focus")
            osi.type_text("echo FOC_abc_\n")
            assert self._wait_echo(tab_id, "FOC") == "abc"

            path = self._scratch_editor(folder)
            screen = self.os_activate()
            self.focus_editor()
            osi.activate(helper.pid)
            self.wait(lambda: not self.has_focus(), what="termiHub to lose focus")
            osi.activate(window=screen.window)
            self.wait(self.has_focus, what="termiHub to regain focus")
            osi.type_text("xyz")
            osi.key(f"{MOD}+s")
            self._wait_file(path, "xyz")
        assert "abc" not in helper.typed() and "xyz" not in helper.typed()

    # ── MT-NIN-23: typing reaches only the focused window ────────────────────
    def test_typing_goes_only_to_focused_window(self):
        """MT-NIN-23: with two windows open, keys reach only the focused one, and
        the new-terminal shortcut opens its tab in the focused window."""
        osi = self.os_input()
        tab_a = self._shell()
        screen_a = self.os_activate()
        second = self.open_new_window()
        try:
            # A smaller window B leaves part of A uncovered, so a real click can
            # bring either one to the front whatever the stacking order.
            second.resize_window(560, 380)
            second.click(NEW_TERMINAL)
            tab_b = self.wait(lambda: window_tabs(second), what="a shell in window B")[0]["id"]
            self.wait(lambda: second.read_terminal(tab_b).strip(), what="window B's prompt")
            screen_b = self.screen(second)
            self.os_click(f"terminal-renderer-{tab_b}", screen=screen_b)
            self.wait(lambda: self.has_focus(second), what="window B to take the focus")
            osi.type_text("echo WB_bbb_\n")
            assert self._wait_echo(tab_b, "WB", driver=second) == "bbb"

            self.os_click(f"terminal-renderer-{tab_a}", screen=screen_a, fx=0.92, fy=0.85)
            self.wait(lambda: self.has_focus(self.driver), what="window A to take the focus")
            osi.type_text("echo WA_aaa_\n")
            assert self._wait_echo(tab_a, "WA") == "aaa"
            assert "WB_" not in self.driver.read_terminal(tab_a)
            assert "WA_" not in second.read_terminal(tab_b)

            main_before = len(window_tabs(self.driver))
            second_before = len(window_tabs(second))
            osi.key(f"{MOD}+shift+`")
            self.wait(
                lambda: len(window_tabs(self.driver)) == main_before + 1,
                what="the new tab in the focused window A",
            )
            assert len(window_tabs(second)) == second_before, "window B gained a tab"
        finally:
            self._close_window(second)

    # ── MT-SHI-02: external spawn brings the window to the front ─────────────
    def test_external_spawn_brings_window_to_front(self):
        """MT-SHI-02: ``termiHub spawn`` while another app is in front raises the
        termiHub window with a focused '(Spawned)' local shell."""
        osi = self.os_input()
        self.close_all_tabs()
        with HelperWindow() as helper:
            osi.allow_pid(helper.pid)
            self.os_activate()
            osi.activate(helper.pid)
            self.wait(lambda: not self.has_focus(), what="termiHub to lose focus")
            location = tempfile.mkdtemp(prefix="thub-spawn-")
            self.app.run_cli(["spawn", "--location", location])
            self.wait(lambda: osi.frontmost_pid() == self.app.pid, what="termiHub frontmost")
            self.wait(self.has_focus, what="termiHub to take focus")
            tab = self.wait(lambda: self.find_tab("Spawned"), what="the '(Spawned)' tab")
            assert (self.active_tab() or {}).get("id") == tab["id"]

    # ── MT-LOCAL-08: macOS key repeat ────────────────────────────────────────
    @pytest.mark.skipif(sys.platform != "darwin", reason="press-and-hold is a macOS feature")
    def test_macos_key_repeat_has_no_accent_picker(self):
        """MT-LOCAL-08: holding a key in the terminal repeats it continuously; the
        press-and-hold accent picker never swallows the repeats."""
        osi = self.os_input()
        tab_id = self._shell()
        self._focus_terminal(tab_id, self.os_activate())
        osi.type_text("echo KR_")
        osi.key_repeat("k", 30)  # type: ignore[attr-defined]
        osi.type_text("_\n")
        got = self._wait_echo(tab_id, "KR")
        assert re.fullmatch(r"k{25,}", got), f"key repeat delivered {got!r}"
