"""Multi-window helpers (TIN-014, #3720).

``WindowsUi`` drives the app's native-window journeys through the multi-window
bridge: open a new window (the real "New Window" shortcut, #1902), move a live
tab into another window (the tab context menu, #1900/#1901), read a window's
tabs, and resolve its close-with-live-tabs decision dialog (#1903).

Every window is its own page with its own store and bridge socket, so each has
its own :class:`~termihub_harness.bridge.Driver` — reach one with
``self.driver.window(label)``. The helpers here take the target window's driver
explicitly; ``self.driver`` stays the main window, as in every other suite.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Optional

from ..bridge import BridgeError, Driver
from .base import HarnessMixin
from .lookups import iter_tabs

#: A stable, non-editable control to focus before pressing a global shortcut, so
#: the keystroke is handled by the app's shortcut layer rather than swallowed by
#: a focused terminal's xterm input.
SHORTCUT_FOCUS_TARGET = "activity-bar-settings"

#: The close-with-live-tabs decision dialog and its controls (#1903).
CLOSE_DIALOG = "close-window-decision-dialog"
CLOSE_DIALOG_MOVE = "close-window-decision-move"
CLOSE_DIALOG_END = "close-window-decision-end"
CLOSE_DIALOG_CANCEL = "close-window-decision-cancel"
CLOSE_DIALOG_TERMINATE_ROW = "close-window-decision-outcome-terminate"


def window_tabs(driver: Driver) -> list[dict[str, Any]]:
    """Every tab in ``driver``'s window (its active tab group's panel tree)."""
    return iter_tabs(driver.get_state("rootPanel"))


def find_tab_by_session(driver: Driver, session_id: str) -> Optional[dict[str, Any]]:
    """The tab in ``driver``'s window bound to backend session ``session_id``."""
    return next((t for t in window_tabs(driver) if t.get("sessionId") == session_id), None)


def last_session_windows(config_dir: Path) -> list[str]:
    """Window ids recorded in the persisted ``last-session.json`` (#1925).

    Empty when the file is absent/unreadable or the session is single-window
    (a legacy save carries no ``windows`` set).
    """
    try:
        data = json.loads((config_dir / "last-session.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    windows = data.get("windows") if isinstance(data, dict) else None
    if not isinstance(windows, list):
        return []
    return [w["id"] for w in windows if isinstance(w, dict) and isinstance(w.get("id"), str)]


class WindowsUi(HarnessMixin):
    """Open, populate, and close native windows via the multi-window bridge."""

    def open_new_window(self) -> Driver:
        """Press the "New Window" shortcut and return the new window's driver.

        Drives the real keybinding (Ctrl+Shift+N, Cmd+Shift+N on macOS) rather
        than a store action, so the app's shortcut → ``openNewWindow`` path runs.
        """
        before = set(self.driver.windows())
        modifier = {"meta": True} if sys.platform == "darwin" else {"ctrl": True}
        self.driver.press_key("N", SHORTCUT_FOCUS_TARGET, shift=True, **modifier)
        return self.driver.wait_for_window(lambda label: label not in before)

    def secondary_window(self) -> Optional[Driver]:
        """A driver for some already-open non-main window, or ``None``."""
        others = [label for label in self.driver.windows() if label != "main"]
        return self.driver.window(others[0]) if others else None

    def live_session_id(self, driver: Driver, tab_id: str) -> str:
        """Wait until tab ``tab_id`` in ``driver``'s window has a backend session."""

        def session() -> Optional[str]:
            tab = next((t for t in window_tabs(driver) if t.get("id") == tab_id), None)
            return (tab or {}).get("sessionId")

        return self.wait(session, what=f"tab {tab_id} to bind a backend session")

    def move_tab_to_window(self, source: Driver, tab_id: str, target_label: str) -> None:
        """Move tab ``tab_id`` from ``source``'s window into window ``target_label``.

        Uses the tab context menu's "Move to Window ▸ <window>" submenu (#1901),
        which lists the live windows when the menu opens.
        """
        source.context_menu(f"tab-{tab_id}")
        self.wait(
            lambda: source.exists("tab-context-move-window"),
            what="the Move to Window submenu trigger",
        )
        source.click("tab-context-move-window")
        item = f"tab-context-move-window-{target_label}"
        self.wait(lambda: source.exists(item), what=f"the {target_label} entry in Move to Window")
        source.click(item)

    def wait_for_session_tab(self, driver: Driver, session_id: str) -> dict[str, Any]:
        """Wait until ``driver``'s window shows a tab bound to ``session_id``."""
        return self.wait(
            lambda: find_tab_by_session(driver, session_id),
            what=f"a tab for session {session_id} in window {driver.window_label!r}",
        )

    def wait_for_terminal_text(
        self, driver: Driver, tab_id: str, needle: str
    ) -> str:
        """Poll a terminal tab in ``driver``'s window until it contains ``needle``."""

        def read() -> Optional[str]:
            text = driver.read_terminal(tab_id)
            return text if needle in text else None

        return self.wait(read, what=f"{needle!r} in window {driver.window_label!r}")

    def send_to_terminal(self, driver: Driver, tab_id: str, command: str) -> None:
        """Type ``command`` into a terminal tab of ``driver``'s window (retrying).

        A re-attached session can take a moment before it accepts input again;
        a failed send transmits nothing, so retrying never double-sends.
        """

        def send() -> bool:
            driver.terminal_input(command, tab_id)
            return True

        self.wait(send, what=f"window {driver.window_label!r} to accept terminal input")

    def request_close(self, driver: Driver) -> None:
        """Ask ``driver``'s window to close through the OS close path (#1903)."""
        driver.close_window()

    def close_dialog_open(self, driver: Driver) -> bool:
        """Whether the close-with-live-tabs decision dialog is up in that window."""
        try:
            return driver.exists(CLOSE_DIALOG)
        except BridgeError:
            return False
