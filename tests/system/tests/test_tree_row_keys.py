"""Row-action keys on the connection and agent trees, graded in the real app (#5232).

#5181 gave a focused sidebar tree row the keyboard equivalents of its context
actions, #5233 made F2 rename a folder in place, and #5158 put an Undo on a
confirmed folder delete. Their component tests run in jsdom; this suite drives
the same keys into the built app on macOS, Windows and Linux:

* **Shift+F10 / the ContextMenu key** open the focused row's context menu, and
  Escape closes it and gives focus back to the row.
* **F2** opens a connection's (or an agent's) editor tab, and starts the inline
  rename on a folder, which Enter commits and Escape cancels.
* **Delete** opens the delete confirm. Cancel keeps the row and gives focus
  back to it; confirming deletes it, and for a folder the Undo toast restores it.

Keys go through the bridge's ``pressKey``, which focuses the row and dispatches
the keydown on it, so the row's own handler sees ``event.target === row`` as for
a real keystroke. WKWebView has no native Shift+F10, so the row synthesizes the
``contextmenu`` event itself on every platform; this grade covers that path.

**Where focus is.** The bridge has no "active element" read, so
:meth:`focused_testid` sends a harmless bare Shift keydown to the focused
element and reads which ``data-testid`` the input probe recorded it on. That is
the same element a real next keystroke would reach.

Agent rows need no running agent: a saved, disconnected agent's header row
carries the same keys (its menu shows Connect, F2 opens its editor).
"""

from __future__ import annotations

from typing import Optional

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    AgentUi,
    ConnectionsUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    connection_item_testid,
    folder_toggle_testid,
    unique_name,
)

pytestmark = pytest.mark.integration

CTX_CONNECTION_CONNECT = "context-connection-connect"
CTX_FOLDER_RENAME = "context-folder-rename"
CTX_AGENT_CONNECT = "context-agent-connect"
CONFIRM_DIALOG = "confirm-delete-dialog"
CONFIRM_CANCEL = "confirm-delete-cancel"
CONFIRM_DELETE = "confirm-delete-confirm"
RENAME_INPUT = "inline-folder-name-input"
FOLDER_UNDO_TOAST = "folder-delete-undo-toast"
#: The toast's Undo button: ``showUndoToast`` tags it ``<toast testid>-undo``.
FOLDER_UNDO = f"{FOLDER_UNDO_TOAST}-undo"

#: The two keys that open a row's context menu: (key, shift held).
MENU_KEYS = [("F10", True), ("ContextMenu", False)]


class TestTreeRowKeys(TabsUi, SidebarUi, SettingsUi, AgentUi, ConnectionsUi, SystemTest):
    """One app for the suite; each test makes its own rows."""

    # The first store read of a fresh app can outlast the 10 s bridge default
    # while the webview warms up on a loaded runner (see test_connection_crud).
    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT

    # AgentUi and ConnectionsUi both name the editor fields; they are the same ids.
    EDITOR_NAME = ConnectionsUi.EDITOR_NAME

    @pytest.fixture(autouse=True)
    def _clean_slate(self):
        """No open menu, dialog or tab; the connections sidebar showing."""
        self.dismiss_menu()
        if self.driver.exists(CONFIRM_CANCEL):
            self.driver.click(CONFIRM_CANCEL)
        self.close_all_tabs()
        self.switch_to_connections_sidebar()
        self.wait(
            lambda: self.driver.exists(self.NEW_CONNECTION),
            what="the connections sidebar",
        )
        yield

    # ── helpers ─────────────────────────────────────────────────────────────────
    def focused_testid(self) -> Optional[str]:
        """The ``data-testid`` nearest the focused element.

        Sends a bare Shift keydown (no target, so it lands on the focused
        element; no row acts on it) and reads where the input probe saw it.
        """
        self.driver.os_input_probe(reset=True)
        self.driver.press_key("Shift")
        events = self.driver.os_input_probe()["events"]
        keydowns = [e for e in events if e.get("type") == "keydown" and e.get("key") == "Shift"]
        return keydowns[-1].get("testId") if keydowns else None

    def wait_focus_on(self, testid: str, *, what: str) -> None:
        """Wait until the focused element is (inside) ``testid``."""
        seen: list[Optional[str]] = []

        def focused() -> bool:
            seen.append(self.focused_testid())
            return seen[-1] == testid

        try:
            self.wait(focused, what=what)
        except AssertionError as exc:
            hint = f"focus was on {seen[-1]!r}" if seen else "focus never read"
            raise AssertionError(f"{exc}; {hint}") from None

    def connection_row(self, name: str) -> str:
        """Create a local connection; the testid of its (mounted) tree row."""
        self.create_local_connection(name)
        conn = self.require_stable_connection(name)
        row = connection_item_testid(conn["id"])
        self.wait(lambda: self.driver.exists(row), what=f"the {name!r} row")
        return row

    def folder_row(self, name: str) -> str:
        """Create a top-level folder; the testid of its (mounted) tree row."""
        folder = self.create_folder(name)
        row = folder_toggle_testid(folder["id"])
        self.wait(lambda: self.driver.exists(row), what=f"the {name!r} folder row")
        return row

    def agent_row(self, name: str) -> str:
        """Save a remote agent (never connected); the testid of its header row."""
        agent = self.create_remote_agent(name, host="127.0.0.1", port=1, username="nobody")
        row = self.agent_header_testid(agent["id"])
        self.wait(lambda: self.driver.exists(row), what=f"the {name!r} agent row")
        return row

    def grade_menu_keys(self, row: str, sentinel: str) -> None:
        """Each menu key opens ``row``'s menu; Escape closes it, focus back on the row."""
        for key, shift in MENU_KEYS:
            label = f"{'Shift+' if shift else ''}{key}"
            assert not self.driver.exists(sentinel), f"a menu is open before {label}"
            self.driver.press_key(key, row, shift=shift)
            self.wait(lambda: self.driver.exists(sentinel), what=f"{label} to open the row menu")
            self.driver.press_key("Escape")
            self.wait(lambda: not self.driver.exists(sentinel), what="Escape to close the menu")
            self.wait_focus_on(row, what=f"focus back on the row after the {label} menu")

    def grade_delete_cancel(self, row: str) -> None:
        """Delete opens the confirm; Cancel keeps the row and focuses it again."""
        self.driver.press_key("Delete", row)
        self.wait(lambda: self.driver.exists(CONFIRM_DIALOG), what="Delete to open the confirm")
        self.driver.click(CONFIRM_CANCEL)
        self.wait(lambda: not self.driver.exists(CONFIRM_DIALOG), what="the confirm to close")
        assert self.driver.exists(row), "Cancel removed the row"
        self.wait_focus_on(row, what="focus back on the row after Cancel")

    # ── connection row ──────────────────────────────────────────────────────────
    def test_connection_row_menu_keys(self):
        row = self.connection_row(unique_name("keys-menu"))
        self.grade_menu_keys(row, CTX_CONNECTION_CONNECT)

    def test_connection_row_f2_opens_editor(self):
        name = unique_name("keys-f2")
        row = self.connection_row(name)
        self.close_all_tabs()
        self.driver.press_key("F2", row)
        self.wait(lambda: self.find_tab(f"Edit: {name}") is not None, what="F2 to open the editor")
        self.wait(
            lambda: self.driver.get_value(self.EDITOR_NAME) == name,
            what="the editor to show the connection",
        )

    def test_connection_row_delete_confirm(self):
        name = unique_name("keys-del")
        row = self.connection_row(name)
        self.grade_delete_cancel(row)
        assert self.find_connection(name) is not None, "Cancel deleted the connection"

        self.driver.press_key("Delete", row)
        self.wait(lambda: self.driver.exists(CONFIRM_DELETE), what="the confirm, again")
        self.driver.click(CONFIRM_DELETE)
        self.wait(lambda: self.find_connection(name) is None, what="the connection to go")

    # ── folder row ──────────────────────────────────────────────────────────────
    def test_folder_row_menu_keys(self):
        row = self.folder_row(unique_name("keys-fmenu"))
        self.grade_menu_keys(row, CTX_FOLDER_RENAME)

    def test_folder_row_f2_renames_in_place(self):
        name = unique_name("keys-fren")
        row = self.folder_row(name)

        # Escape cancels: the name stays, focus is back on the row.
        self.driver.press_key("F2", row)
        self.wait(lambda: self.driver.exists(RENAME_INPUT), what="F2 to start the rename")
        assert self.driver.get_value(RENAME_INPUT) == name
        assert self.tab_count() == 0, "F2 on a folder opened a tab"
        self.driver.type(RENAME_INPUT, name + "-nope")
        self.driver.press_key("Escape", RENAME_INPUT)
        self.wait(lambda: not self.driver.exists(RENAME_INPUT), what="Escape to end the rename")
        assert self.find_folder(name) is not None
        assert self.find_folder(name + "-nope") is None
        self.wait_focus_on(row, what="focus back on the folder after Escape")

        # Enter commits: the folder is renamed (and re-keyed), focus follows it.
        renamed = name + "-renamed"
        self.driver.press_key("F2", row)
        self.wait(lambda: self.driver.exists(RENAME_INPUT), what="F2 to start the rename again")
        self.driver.type(RENAME_INPUT, renamed)
        self.driver.press_key("Enter", RENAME_INPUT)
        self.wait(lambda: not self.driver.exists(RENAME_INPUT), what="Enter to end the rename")

        def settled():
            folder = self.find_folder(renamed)
            if folder is None or str(folder["id"]).startswith("folder-"):
                return None
            return folder

        folder = self.wait(settled, what="the renamed folder")
        assert self.find_folder(name) is None
        new_row = folder_toggle_testid(folder["id"])
        self.wait(lambda: self.driver.exists(new_row), what="the renamed folder row")
        self.wait_focus_on(new_row, what="focus on the renamed folder row")

    def test_folder_row_delete_confirm_and_undo(self):
        name = unique_name("keys-fdel")
        row = self.folder_row(name)
        self.grade_delete_cancel(row)
        assert self.find_folder(name) is not None, "Cancel deleted the folder"

        self.driver.press_key("Delete", row)
        self.wait(lambda: self.driver.exists(CONFIRM_DELETE), what="the confirm, again")
        self.driver.click(CONFIRM_DELETE)
        self.wait(lambda: self.find_folder(name) is None, what="the folder to go")
        # The Undo window is 10 s; press it straight away.
        self.wait(lambda: self.driver.exists(FOLDER_UNDO), what="the Undo toast")
        self.driver.click(FOLDER_UNDO)
        self.wait(lambda: self.find_folder(name) is not None, what="Undo to restore the folder")

    # ── agent row ───────────────────────────────────────────────────────────────
    def test_agent_row_keys(self):
        name = unique_name("keys-agent")
        row = self.agent_row(name)
        self.close_all_tabs()

        self.grade_menu_keys(row, CTX_AGENT_CONNECT)

        self.driver.press_key("F2", row)
        self.wait(
            lambda: self.driver.exists(self.EDITOR_NAME)
            and self.driver.get_value(self.EDITOR_NAME) == name,
            what="F2 to open the agent's editor",
        )
        self.close_all_tabs()

        self.grade_delete_cancel(row)
        assert self.find_agent(name) is not None, "Cancel deleted the agent"

        self.driver.press_key("Delete", row)
        self.wait(lambda: self.driver.exists(CONFIRM_DELETE), what="the confirm, again")
        self.driver.click(CONFIRM_DELETE)
        self.wait(lambda: self.find_agent(name) is None, what="the agent to go")
