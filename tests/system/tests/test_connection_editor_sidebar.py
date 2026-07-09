"""Unit tests for ``open_new_connection_editor`` sidebar-view recovery (#957).

Machinery group (no app): a stub driver reproduces the state the #957 operator
run hit — a prior file-browser step left the sidebar on "files", so the New
Connection button is absent until the harness switches back to the connections
view. Mirrors the ``TerminalUi`` machinery tests: the real ``SystemTest.wait``
is reused with a short timeout so a regression fails in milliseconds.
"""

from __future__ import annotations

from typing import Any, Optional

from termihub_harness import ConnectionsUi, SystemTest
from termihub_harness.bridge import BridgeError


class _Conn(ConnectionsUi):
    def __init__(self, driver: Any) -> None:
        self.driver = driver

    def wait(self, predicate, *, timeout=1.0, interval=0.005, what="condition"):
        return SystemTest.wait(
            self, predicate, timeout=timeout, interval=interval, what=what
        )


class _SidebarDriver:
    """The New Connection button exists only in the ``connections`` sidebar view."""

    def __init__(self, view: str = "files") -> None:
        self.view = view
        self.clicks: list[str] = []
        self.editor_open = False

    def get_state(self, path: Optional[str] = None) -> Any:
        if path == "sidebarView":
            return self.view
        raise BridgeError("getState", f"unhandled path {path!r}")

    def exists(self, test_id: str) -> bool:
        if test_id == "connection-editor-name-input":
            return self.editor_open
        if test_id == "connection-list-new-connection":
            return self.view == "connections"
        if test_id == "activity-bar-connections":
            return True
        return False

    def click(self, test_id: str) -> None:
        self.clicks.append(test_id)
        if test_id == "activity-bar-connections":
            self.view = "connections"
        elif test_id == "connection-list-new-connection":
            self.editor_open = True


def test_switches_from_files_view_then_opens_editor():
    driver = _SidebarDriver(view="files")
    _Conn(driver).open_new_connection_editor()
    assert driver.editor_open
    # It must switch to the connections view *before* clicking New Connection.
    assert "activity-bar-connections" in driver.clicks
    assert driver.clicks.index("activity-bar-connections") < driver.clicks.index(
        "connection-list-new-connection"
    )


def test_no_view_switch_when_already_on_connections():
    driver = _SidebarDriver(view="connections")
    _Conn(driver).open_new_connection_editor()
    assert driver.editor_open
    assert "activity-bar-connections" not in driver.clicks


def test_noop_when_editor_already_open():
    driver = _SidebarDriver(view="files")
    driver.editor_open = True
    _Conn(driver).open_new_connection_editor()
    assert driver.clicks == []
