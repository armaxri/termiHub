"""Connection CRUD, folders, validation, ping, and export/import — ported from
the WebdriverIO ``connection-crud.test.js`` to the Python bridge harness (#807).

Each WebdriverIO ``data-testid`` interaction maps to a bridge step and each
assertion to a check. The suite combines :class:`ConnectionsUi` (connection-list
flows) with :class:`SystemTest`, reusing the base's generic helpers
(``unique_name``, ``create_ssh_connection``, ``find_tab`` / ``tab_count``,
``open_new_connection_editor``, ``switch_to_connections_sidebar``) so only the
connection-list specifics live here. Lookups the old suite did by visible
name/title (connection items, folders, tabs carry UUID testids) are resolved
through ``getState``.

Divergences from the original, by design:

* **Move-to-folder via the editor folder selector** (``MT-CONN-06``) is dropped —
  the editor's folder ``<select>`` was removed (PR #146), so that test targeted a
  selector that no longer renders. Folder *placement* is covered by the editor /
  context-menu suites in the wider port.
* **Import** (``MT-CONN-07``) opens a native OS file dialog on click, which would
  block the harness; we assert the menu item is reachable rather than clicking it.
* **Shell-specific icon** checks asserted an ``<svg>`` rendered inside the item —
  a DOM detail with no testid. We assert the connection/tab is created instead;
  icon rendering stays a unit/manual concern.
"""

from __future__ import annotations

import pytest

from termihub_harness import ConnectionsUi, SidebarUi, SystemTest, TabsUi, unique_name

pytestmark = pytest.mark.integration


class TestConnectionCrud(TabsUi, SidebarUi, ConnectionsUi, SystemTest):
    """One app for the whole suite; methods run in order and share its state."""

    @pytest.fixture(autouse=True)
    def _connection_suite(self):
        """Per-test: clean tab slate + sidebar up; mirrors the old suite's afterEach.

        Editor tabs each render a ``connection-editor-name-input`` with the *same*
        testid, so a leftover editor tab from an earlier test would make the
        bridge drive the wrong editor. Closing all tabs first (like the
        WebdriverIO ``closeAllTabs``) keeps every test isolated.
        """
        self.dismiss_menu()
        self.close_all_tabs()
        self.switch_to_connections_sidebar()
        self.wait(
            lambda: self.driver.exists("connection-list-new-connection"),
            what="the connections sidebar",
        )
        yield

    # ── CONN-01: create ────────────────────────────────────────────────────────
    def test_create_local_connection(self):
        name = unique_name("create")
        self.create_local_connection(name)
        assert self.find_connection(name) is not None

    # ── CONN-02: edit name via context menu ────────────────────────────────────
    def test_edit_connection_name(self):
        original = unique_name("edit-orig")
        self.create_local_connection(original)

        self.connection_context_action(original, self.CTX_EDIT)
        self.wait(self.editor_open, what="the edit editor")

        updated = original + "-edited"
        self.driver.type(self.EDITOR_NAME, updated)
        self.driver.click(self.EDITOR_SAVE)

        self.require_connection(updated)
        assert self.find_connection(original) is None

    # ── CONN-03: delete via context menu ───────────────────────────────────────
    def test_delete_connection(self):
        name = unique_name("delete")
        self.create_local_connection(name)
        assert self.find_connection(name) is not None

        self.connection_context_action(name, self.CTX_DELETE)
        self.wait(lambda: self.find_connection(name) is None, what="the connection to vanish")

    # ── CONN-04: create folder via toolbar ─────────────────────────────────────
    def test_create_folder(self):
        folder = unique_name("folder")
        self.create_folder(folder)
        assert self.find_folder(folder) is not None

    # ── CONN-10: duplicate via context menu ────────────────────────────────────
    def test_duplicate_connection(self):
        name = unique_name("dup")
        self.create_local_connection(name)
        self.connection_context_action(name, self.CTX_DUPLICATE)
        self.wait(
            lambda: self.find_connection(f"Copy of {name}") is not None,
            what="the duplicated connection",
        )

    # ── CONN-EDITOR-TAB: editor lives in a tab (PR #109) ───────────────────────
    def test_editor_opens_as_tab(self):
        before = self.tab_count()
        self.open_new_connection_editor()
        assert self.editor_open()
        assert self.tab_count() == before + 1

    def test_edit_opens_tab_titled_edit(self):
        name = unique_name("edit-tab")
        self.create_local_connection(name)
        self.connection_context_action(name, self.CTX_EDIT)
        self.wait(lambda: self.find_tab(f"Edit: {name}") is not None, what="the edit tab")

    def test_saving_closes_editor_tab(self):
        name = unique_name("save-close")
        self.open_new_connection_editor()
        self.driver.type(self.EDITOR_NAME, name)
        before = self.tab_count()
        self.driver.click(self.EDITOR_SAVE)
        self.wait(lambda: self.tab_count() < before, what="the editor tab to close")

    def test_cancelling_closes_editor_tab(self):
        self.open_new_connection_editor()
        before = self.tab_count()
        self.driver.click(self.EDITOR_CANCEL)
        self.wait(lambda: self.tab_count() < before, what="the editor tab to close")

    def test_reedit_activates_existing_tab(self):
        name = unique_name("re-edit")
        self.create_local_connection(name)

        self.connection_context_action(name, self.CTX_EDIT)
        self.wait(lambda: self.find_tab(f"Edit: {name}") is not None, what="the edit tab")
        after_first = self.tab_count()

        # Editing the same connection again must reuse, not duplicate, its tab.
        self.connection_context_action(name, self.CTX_EDIT)
        self.wait(lambda: self.find_tab(f"Edit: {name}") is not None, what="the edit tab")
        assert self.tab_count() == after_first

    def test_multiple_editor_tabs_for_different_connections(self):
        name1 = unique_name("multi-a")
        name2 = unique_name("multi-b")
        self.create_local_connection(name1)
        self.create_local_connection(name2)

        self.connection_context_action(name1, self.CTX_EDIT)
        self.wait(lambda: self.find_tab(f"Edit: {name1}") is not None, what="first edit tab")
        after_first = self.tab_count()

        self.connection_context_action(name2, self.CTX_EDIT)
        self.wait(
            lambda: self.tab_count() == after_first + 1,
            what="a second, distinct edit tab",
        )
        assert self.find_tab(f"Edit: {name1}") is not None
        assert self.find_tab(f"Edit: {name2}") is not None

    # ── CONN-SAVE-CONNECT: Save & Connect (PR #112) ────────────────────────────
    def test_save_and_connect_opens_terminal(self):
        name = unique_name("save-conn")
        self.open_new_connection_editor()
        self.driver.type(self.EDITOR_NAME, name)
        self.driver.click(self.EDITOR_SAVE_CONNECT)
        self.require_connection(name)
        self.wait(lambda: self.find_tab(name) is not None, what="the connected terminal tab")

    # ── CONN-DUP-NAME: duplicate-name validation (#380) ────────────────────────
    def test_duplicate_name_shows_error(self):
        name = unique_name("dup-check")
        self.create_local_connection(name)

        self.open_new_connection_editor()
        self.driver.type(self.EDITOR_NAME, name)
        self.wait(lambda: self.driver.exists(self.EDITOR_NAME_ERROR), what="the duplicate-name error")
        assert "already exists" in self.driver.get_text(self.EDITOR_NAME_ERROR)

    def test_duplicate_name_blocks_save(self):
        name = unique_name("dup-block")
        self.create_local_connection(name)

        self.open_new_connection_editor()
        self.driver.type(self.EDITOR_NAME, name)
        self.wait(lambda: self.driver.exists(self.EDITOR_NAME_ERROR), what="the duplicate-name error")
        self.driver.click(self.EDITOR_SAVE)
        # Save is blocked: the editor stays open and the error remains.
        assert self.editor_open()
        assert self.driver.exists(self.EDITOR_NAME_ERROR)

    def test_duplicate_name_error_clears_on_unique(self):
        name = unique_name("dup-clear")
        self.create_local_connection(name)

        self.open_new_connection_editor()
        self.driver.type(self.EDITOR_NAME, name)
        self.wait(lambda: self.driver.exists(self.EDITOR_NAME_ERROR), what="the duplicate-name error")

        fresh = unique_name("dup-fixed")
        self.driver.type(self.EDITOR_NAME, fresh)
        self.wait(
            lambda: not self.driver.exists(self.EDITOR_NAME_ERROR),
            what="the error to clear",
        )
        self.driver.click(self.EDITOR_SAVE)
        self.require_connection(fresh)

    def test_edit_without_changing_name_saves(self):
        name = unique_name("self-edit")
        self.create_local_connection(name)

        self.connection_context_action(name, self.CTX_EDIT)
        self.wait(self.editor_open, what="the edit editor")
        # Editing a connection's own name is not a duplicate — no error.
        assert not self.driver.exists(self.EDITOR_NAME_ERROR)
        self.driver.click(self.EDITOR_SAVE)
        self.wait(lambda: not self.editor_open(), what="the editor to close")

    # ── CONN-PING: ping host context menu (PR #37) ─────────────────────────────
    def test_ping_menu_shown_for_ssh(self):
        name = unique_name("ping-ssh")
        self.create_ssh_connection(name, host="127.0.0.1", port=22, username="tester")
        self.open_connection_menu(name)
        assert self.driver.exists(self.CTX_PING)

    def test_ping_menu_hidden_for_local(self):
        name = unique_name("ping-local")
        self.create_local_connection(name)
        self.open_connection_menu(name)
        assert not self.driver.exists(self.CTX_PING)

    def test_ping_opens_tab(self):
        name = unique_name("ping-tab")
        self.create_ssh_connection(name, host="127.0.0.1", port=22, username="tester")
        self.connection_context_action(name, self.CTX_PING)
        self.wait(lambda: self.find_tab("Ping") is not None, what="a Ping tab")

    # ── MT-CONN-04: create SSH connection ──────────────────────────────────────
    def test_create_ssh_connection(self):
        name = unique_name("ssh-conn")
        self.create_ssh_connection(name, host="192.168.1.1", port=22, username="tester")
        self.require_connection(name)

    # ── MT-CONN-08: export connections dialog ──────────────────────────────────
    def test_export_dialog_opens(self):
        self.driver.click("activity-bar-settings")
        self.wait(lambda: self.driver.exists("settings-menu-export"), what="the settings menu")
        self.driver.click("settings-menu-export")
        self.wait(lambda: self.driver.exists("export-dialog-title"), what="the export dialog")
        assert "Export Connections" in self.driver.get_text("export-dialog-title")
        self.dismiss_menu()  # close the dialog

    # ── MT-CONN-07: import entry point (native dialog not driven) ───────────────
    def test_import_menu_item_present(self):
        self.driver.click("activity-bar-settings")
        self.wait(lambda: self.driver.exists("settings-menu-import"), what="the settings menu")
        # Clicking would open a native OS file picker that blocks the harness, so
        # we assert the entry point is reachable rather than invoking it.
        assert self.driver.exists("settings-menu-import")
        self.dismiss_menu()
