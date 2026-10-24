"""Automated OS-input grades: macOS Dock and quit paths, by PID (#4935).

Each of these used to need an operator at the Dock or the keyboard. They are
driven here with OS events aimed at the test instance's **PID** — never at
"termiHub" by name, because the maintainer runs an installed termiHub beside
it: Cmd+Q is a ``CGEventPostToPid`` key event, the Dock icon click is the
reopen Apple event (``aevt/rapp``), the Dock's Quit and AppleScript ``quit``
are the quit Apple event (``aevt/quit``), and Log Out is that quit carrying
``kAEQuitReason = kAELogOut`` — all addressed with ``typeKernelProcessID``.

Retires MT-WIN-01..04 (macOS only).
"""

from __future__ import annotations

import sys

import pytest

from termihub_harness import (
    ConnectionsUi,
    EditorUi,
    FilesUi,
    OsInputUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    WindowsUi,
    unique_name,
)
from termihub_harness.ui.terminal import NEW_TERMINAL
from termihub_harness.ui.windows import CLOSE_DIALOG, CLOSE_DIALOG_CANCEL, CLOSE_DIALOG_END

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        sys.platform != "darwin", reason="the Dock, Cmd+Q and quit Apple events are macOS features"
    ),
]

QUIT_TIMEOUT = 30.0


class TestOsMacAppLifecycle(
    OsInputUi, TerminalUi, TabsUi, ConnectionsUi, SidebarUi, FilesUi, EditorUi, WindowsUi, SystemTest
):
    """Dock reopen, Cmd+Q and Apple-event quits against the test instance."""

    def _shell_and_unsaved_editor(self) -> None:
        """A live shell plus an editor with an unsaved change: a quit must ask."""
        self.close_all_tabs()
        self.ensure_terminal()
        self.open_file_browser()
        name = f"{unique_name('unsaved')}.txt"
        self.create_file_via_browser(name)
        self.open_file_in_editor(name)
        self.dirty_editor()

    def _quit_dialog(self) -> None:
        self.wait(lambda: self.driver.exists(CLOSE_DIALOG), what="the 'Quit termiHub?' dialog")

    def _wait_quit(self) -> None:
        self.wait(lambda: not self.app.is_running(), timeout=QUIT_TIMEOUT, what="the app to quit")

    def _send(self, event_id: str, **kwargs) -> None:
        osi = self.os_input()
        osi.send_apple_event(self.app.pid, "aevt", event_id, **kwargs)  # type: ignore[attr-defined]

    def test_last_window_close_keeps_app_and_dock_reopen_recreates_window(self):
        """MT-WIN-01: closing each window closes only that one; after the last the
        app keeps running (Dock dot); the Dock icon click (reopen) recreates a
        window."""
        self.os_input()
        self.close_all_tabs()
        second = self.open_new_window()
        second.close_window()
        second.wait_until_closed()
        assert self.app.is_running()
        self.driver.close_window()
        self.driver.wait_until_closed()
        assert self.app.is_running(), "closing the last window quit the app"
        self._send("rapp")
        self.bridge.wait_for_window(what="the window the Dock reopen created")
        assert self.app.is_running()
        self.restart_app()

    def test_cmd_q_quits_with_several_windows(self):
        """MT-WIN-02: Cmd+Q with a live shell in two windows asks once; 'Quit &
        end sessions' closes every window and the app exits."""
        osi = self.os_input()
        self.close_all_tabs()
        self.ensure_terminal()
        second = self.open_new_window()
        second.click(NEW_TERMINAL)
        osi.key("cmd+q")
        self._quit_dialog()
        self.driver.click(CLOSE_DIALOG_END)
        self._wait_quit()
        self.restart_app()
        self.ensure_terminal()

    def test_cmd_q_with_live_shell_asks_first(self):
        """MT-WIN-03: Cmd+Q lists the shell and the unsaved editor; a second Cmd+Q
        while the dialog is open does nothing; Cancel keeps the app; confirming
        quits; with every window closed Cmd+Q quits at once without a dialog."""
        osi = self.os_input()
        self._shell_and_unsaved_editor()
        osi.key("cmd+q")
        self._quit_dialog()
        osi.key("cmd+q")
        assert self.app.is_running()
        self._quit_dialog()
        self.driver.click(CLOSE_DIALOG_CANCEL)
        self.wait(lambda: not self.driver.exists(CLOSE_DIALOG), what="the dialog to close")
        assert self.app.is_running() and self.has_terminal()

        osi.key("cmd+q")
        self._quit_dialog()
        self.driver.click(CLOSE_DIALOG_END)
        self._wait_quit()

        self.restart_app()
        self.close_all_tabs()
        self.driver.close_window()
        self.driver.wait_until_closed()
        assert self.app.is_running()
        self.os_input().key("cmd+q")
        self._wait_quit()
        self.restart_app()

    def test_dock_quit_applescript_quit_and_logout(self):
        """MT-WIN-04: the Dock's Quit and AppleScript ``quit`` (the quit Apple
        event) raise the same dialog — Cancel keeps the app, confirming quits —
        while the Log Out quit (``kAEQuitReason`` = log out) terminates at once
        without waiting on a dialog."""
        self._shell_and_unsaved_editor()
        self._send("quit")
        self._quit_dialog()
        self.driver.click(CLOSE_DIALOG_CANCEL)
        self.wait(lambda: not self.driver.exists(CLOSE_DIALOG), what="the dialog to close")
        assert self.app.is_running()

        self._send("quit")
        self._quit_dialog()
        self.driver.click(CLOSE_DIALOG_END)
        self._wait_quit()

        self.restart_app()
        self._shell_and_unsaved_editor()
        self._send("quit", quit_reason="logo")
        self._wait_quit()
        self.restart_app()
