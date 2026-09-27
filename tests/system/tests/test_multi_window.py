"""Multi-window journeys, driven end-to-end over the multi-window bridge (TIN-014).

Each native window runs its own page, store, and bridge socket, so a suite can
address any window by label (``self.driver.window("win-1")``). This drives the
journeys that used to be verified only by hand:

* open a second window with the real "New Window" shortcut (#1902);
* move a live terminal tab into it and check the session keeps producing output
  (the #1900 re-parent — the backend PTY never restarts);
* restart and check the windowed layout comes back (#1925);
* close a window that owns a live tab and check the configured close policy —
  the detach-vs-terminate dialog, Cancel keeps the window, Move re-parents the
  tab into the surviving window (#1903);
* on Linux/Windows, closing the **last** window quits the app (#1903 per-OS
  quit policy).

What stays manual is only the OS-native macOS behaviour — the app staying alive
in the Dock after its last window closes, and Cmd+Q — see ``MT-WIN-01``/``02``
in ``tests/manual/multi-window.yaml``.

Runs in the nightly integration lane (Linux and Windows; macOS too, minus the
last-window quit check). The suite drives POSIX-agnostic ``echo`` only, so the
Windows default shell (PowerShell) needs no Git Bash.
"""

from __future__ import annotations

import json
import sys
import uuid

import pytest

from termihub_harness import SystemTest, TerminalUi, WindowsUi
from termihub_harness.bridge import Driver
from termihub_harness.ui.terminal import NEW_TERMINAL
from termihub_harness.ui.windows import (
    CLOSE_DIALOG,
    CLOSE_DIALOG_CANCEL,
    CLOSE_DIALOG_END,
    CLOSE_DIALOG_MOVE,
    CLOSE_DIALOG_TERMINATE_ROW,
    find_tab_by_session,
    last_session_windows,
    window_tabs,
)

pytestmark = pytest.mark.integration


def _marker(tag: str) -> str:
    return f"MW_{tag}_{uuid.uuid4().hex[:8]}"


class TestMultiWindow(WindowsUi, TerminalUi, SystemTest):
    """Open → move a live tab → restart/restore → close-with-live-tabs, in order.

    Methods run in definition order against one app, but each re-establishes the
    precondition it needs (a second window, a live tab in it), so a single test
    rerun on its own still exercises its journey.
    """

    # ── Setup helpers ────────────────────────────────────────────────────────
    def _second_window(self) -> Driver:
        return self.secondary_window() or self.open_new_window()

    def _open_terminal_in_main(self) -> str:
        """Open a fresh terminal tab in the main window; return its tab id."""
        before = {tab.get("id") for tab in window_tabs(self.driver)}
        self.driver.click(NEW_TERMINAL)
        tab_id = self.wait(
            lambda: next(
                (t["id"] for t in window_tabs(self.driver) if t.get("id") not in before),
                None,
            ),
            what="a new terminal tab in the main window",
        )
        self.wait(
            lambda: self.driver.read_terminal(tab_id).strip(),
            what="the new terminal's shell prompt",
        )
        return tab_id

    def _live_tab_in(self, target: Driver) -> tuple[str, str]:
        """Move a fresh, live terminal into ``target``; return (session id, tab id)."""
        source_tab = self._open_terminal_in_main()
        session_id = self.live_session_id(self.driver, source_tab)
        before = _marker("BEFORE")
        self.send_to_terminal(self.driver, source_tab, f"echo {before}")
        self.wait_for_terminal_text(self.driver, source_tab, before)

        self.move_tab_to_window(self.driver, source_tab, target.window_label)
        moved = self.wait_for_session_tab(target, session_id)
        # The destination re-attaches to the running session and replays its
        # scrollback, so output printed before the move is visible there.
        self.wait_for_terminal_text(target, moved["id"], before)
        return session_id, moved["id"]

    def _window_with_live_tab(self) -> tuple[Driver, str, str]:
        """A secondary window holding a live terminal tab: (driver, session, tab)."""
        window = self._second_window()
        for tab in window_tabs(window):
            if tab.get("contentType", "terminal") == "terminal" and tab.get("sessionId"):
                return window, tab["sessionId"], tab["id"]
        session_id, tab_id = self._live_tab_in(window)
        return window, session_id, tab_id

    def _write_restore_mode(self, mode: str) -> None:
        """Persist ``restoreLastSessionMode`` (run while the app is down)."""
        path = self.config_dir / "settings.json"
        data: dict = {}
        if path.exists():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    data = loaded
            except (OSError, ValueError):
                data = {}
        data.setdefault("version", "1")
        data["restoreLastSessionMode"] = mode
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    # ── Journeys ─────────────────────────────────────────────────────────────
    def test_new_window_opens_an_addressable_second_window(self):
        before = self.driver.windows()
        second = self.open_new_window()

        assert second.window_label not in before
        assert second.window_label != "main"
        # Each window is its own page and store: the new one knows its label …
        assert second.get_state("windowLabel") == second.window_label
        # … and boots empty (the #1902 empty-window state), independent of main.
        assert window_tabs(second) == []
        # The backend registry agrees both windows exist.
        labels = {w["label"] for w in self.driver.list_windows()}
        assert {"main", second.window_label} <= labels
        # The main window is still the suite's driver and still answers.
        assert self.driver.window_label == "main"
        assert self.driver.get_state("windowLabel") == "main"

    def test_moved_live_tab_keeps_its_session_output(self):
        second = self._second_window()
        session_id, moved_tab = self._live_tab_in(second)

        # The tab left the main window …
        self.wait(
            lambda: find_tab_by_session(self.driver, session_id) is None,
            what="the moved tab to leave the main window",
        )
        # … and the same backend session keeps running in the new one.
        after = _marker("AFTER")
        self.send_to_terminal(second, moved_tab, f"echo {after}")
        self.wait_for_terminal_text(second, moved_tab, after)

    def test_windowed_layout_is_restored_after_restart(self):
        second, _session, _tab = self._window_with_live_tab()
        label = second.window_label
        # The main window aggregates every window's slice into last-session.json
        # (#1925); wait until the save spans both windows before killing the app.
        self.wait(
            lambda: label in last_session_windows(self.config_dir),
            what=f"last-session.json to record window {label!r}",
        )

        self.restart_app(between=lambda: self._write_restore_mode("always"))

        # The relaunched main window respawns the saved secondary window and
        # seeds it with its tab groups.
        restored = self.driver.wait_for_window(lambda candidate: candidate != "main")
        restored_tab = self.wait(
            lambda: next(
                (t for t in window_tabs(restored) if t.get("contentType", "terminal") == "terminal"),
                None,
            ),
            what="the restored window's terminal tab",
        )
        self.wait(
            lambda: restored.read_terminal(restored_tab["id"]).strip(),
            what="a shell prompt in the restored window",
        )
        marker = _marker("RESTORED")
        self.send_to_terminal(restored, restored_tab["id"], f"echo {marker}")
        self.wait_for_terminal_text(restored, restored_tab["id"], marker)
        assert self.driver.window_label == "main"

    def test_closing_a_window_with_live_tabs_follows_the_close_policy(self):
        second, session_id, _tab = self._window_with_live_tab()
        label = second.window_label

        # A window that would lose a non-persistent session asks first (#1903).
        self.request_close(second)
        self.wait(lambda: second.exists(CLOSE_DIALOG), what="the close decision dialog")
        assert second.exists(CLOSE_DIALOG_TERMINATE_ROW), "local shell should read 'terminated'"

        # Cancel keeps the window and its session.
        second.click(CLOSE_DIALOG_CANCEL)
        self.wait(lambda: not second.exists(CLOSE_DIALOG), what="the dialog to dismiss")
        assert second.is_connected
        assert find_tab_by_session(second, session_id) is not None

        # Move re-parents the live tab into the surviving window, then closes.
        self.request_close(second)
        self.wait(lambda: second.exists(CLOSE_DIALOG_MOVE), what="the Move tabs action")
        second.click(CLOSE_DIALOG_MOVE)
        second.wait_until_closed()
        self.wait(
            lambda: label not in {w["label"] for w in self.driver.list_windows()},
            what=f"window {label!r} to leave the backend registry",
        )

        moved = self.wait_for_session_tab(self.driver, session_id)
        marker = _marker("RESCUED")
        self.send_to_terminal(self.driver, moved["id"], f"echo {marker}")
        self.wait_for_terminal_text(self.driver, moved["id"], marker)


@pytest.mark.skipif(
    sys.platform == "darwin",
    reason="macOS keeps the app alive in the Dock after the last window (manual MT-WIN-01)",
)
class TestLastWindowQuitPolicy(TerminalUi, SystemTest):
    """Linux/Windows: closing the last window quits the app (#1903).

    Its own suite (its own app), because the journey ends with the app gone.
    """

    def test_closing_the_last_window_quits_the_app(self):
        self.ensure_terminal()
        self.driver.close_window()
        # The main window owns a live local shell and there is no other window
        # to move it to, so the decision dialog offers only Close & end.
        self.wait(lambda: self.driver.exists(CLOSE_DIALOG_END), what="the close decision dialog")
        assert not self.driver.exists(CLOSE_DIALOG_MOVE)
        self.driver.click(CLOSE_DIALOG_END)

        self.driver.wait_until_closed()
        self.wait(lambda: not self.app.is_running(), what="the app process to exit")
