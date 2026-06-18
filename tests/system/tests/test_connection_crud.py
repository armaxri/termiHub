"""Connection CRUD, folders, validation, ping, and export/import — ported from
the WebdriverIO ``connection-crud.test.js`` to the Python bridge harness (#807).

Each WebdriverIO ``data-testid`` interaction maps to a bridge step and each
assertion to a check, driven through :class:`ConnectionsUi` over the live app.
Lookups that the old suite did by visible name/title (connection items, folders,
tabs carry UUID testids) are resolved here through ``getState``.

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

from termihub_harness import ConnectionsUi, SystemTest, find_tab, tab_count

pytestmark = pytest.mark.integration


class TestConnectionCrud(ConnectionsUi, SystemTest):
    """One app for the whole suite; methods run in order and share its state."""

    _counter = 0

    def _name(self, purpose: str) -> str:
        """A unique connection name for this suite run (app is fresh per class)."""
        type(self)._counter += 1
        return f"SYS-{purpose}-{self._counter}"

    @pytest.fixture(autouse=True)
    def _connection_suite(self):
        """Per-test: ensure the sidebar is up; afterwards close stray menus/editor."""
        self.ensure_connections_sidebar()
        yield
        try:
            self.dismiss_menu()
            if self.editor_open():
                self.driver.click(self.EDITOR_CANCEL)
                self.wait(lambda: not self.editor_open(), what="the editor to close")
        except Exception:  # noqa: BLE001 - cleanup is best-effort
            pass

    # ── CONN-01: create ────────────────────────────────────────────────────────
    def test_create_local_connection(self):
        name = self._name("create")
        self.create_local_connection(name)
        assert self.find_connection(name) is not None

    # ── CONN-02: edit name via context menu ────────────────────────────────────
    def test_edit_connection_name(self):
        original = self._name("edit-orig")
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
        name = self._name("delete")
        self.create_local_connection(name)
        assert self.find_connection(name) is not None

        self.connection_context_action(name, self.CTX_DELETE)
        self.wait(lambda: self.find_connection(name) is None, what="the connection to vanish")

    # ── CONN-04: create folder via toolbar ─────────────────────────────────────
    def test_create_folder(self):
        folder = self._name("folder")
        self.driver.click(self.NEW_FOLDER)
        self.wait(lambda: self.driver.exists(self.FOLDER_NAME_INPUT), what="the folder input")
        self.driver.type(self.FOLDER_NAME_INPUT, folder)
        self.driver.click(self.FOLDER_CONFIRM)
        self.wait(lambda: self.find_folder(folder) is not None, what="the folder to be created")

    # ── CONN-10: duplicate via context menu ────────────────────────────────────
    def test_duplicate_connection(self):
        name = self._name("dup")
        self.create_local_connection(name)
        self.connection_context_action(name, self.CTX_DUPLICATE)
        self.wait(
            lambda: self.find_connection(f"Copy of {name}") is not None,
            what="the duplicated connection",
        )

    # ── CONN-EDITOR-TAB: editor lives in a tab (PR #109) ───────────────────────
    def test_editor_opens_as_tab(self):
        before = tab_count(self.driver)
        self.open_new_connection_editor()
        assert self.editor_open()
        assert tab_count(self.driver) == before + 1

    def test_edit_opens_tab_titled_edit(self):
        name = self._name("edit-tab")
        self.create_local_connection(name)
        self.connection_context_action(name, self.CTX_EDIT)
        self.wait(lambda: find_tab(self.driver, f"Edit: {name}") is not None, what="the edit tab")

    def test_saving_closes_editor_tab(self):
        name = self._name("save-close")
        self.open_new_connection_editor()
        self.driver.type(self.EDITOR_NAME, name)
        before = tab_count(self.driver)
        self.driver.click(self.EDITOR_SAVE)
        self.wait(lambda: tab_count(self.driver) < before, what="the editor tab to close")

    def test_cancelling_closes_editor_tab(self):
        self.open_new_connection_editor()
        before = tab_count(self.driver)
        self.driver.click(self.EDITOR_CANCEL)
        self.wait(lambda: tab_count(self.driver) < before, what="the editor tab to close")

    def test_reedit_activates_existing_tab(self):
        name = self._name("re-edit")
        self.create_local_connection(name)

        self.connection_context_action(name, self.CTX_EDIT)
        self.wait(lambda: find_tab(self.driver, f"Edit: {name}") is not None, what="the edit tab")
        after_first = tab_count(self.driver)

        # Editing the same connection again must reuse, not duplicate, its tab.
        self.connection_context_action(name, self.CTX_EDIT)
        # Give any (erroneous) second tab a chance to appear, then assert it didn't.
        self.wait(lambda: find_tab(self.driver, f"Edit: {name}") is not None, what="the edit tab")
        assert tab_count(self.driver) == after_first

    def test_multiple_editor_tabs_for_different_connections(self):
        name1 = self._name("multi-a")
        name2 = self._name("multi-b")
        self.create_local_connection(name1)
        self.create_local_connection(name2)

        self.connection_context_action(name1, self.CTX_EDIT)
        self.wait(lambda: find_tab(self.driver, f"Edit: {name1}") is not None, what="first edit tab")
        after_first = tab_count(self.driver)

        self.connection_context_action(name2, self.CTX_EDIT)
        self.wait(
            lambda: tab_count(self.driver) == after_first + 1,
            what="a second, distinct edit tab",
        )
        assert find_tab(self.driver, f"Edit: {name1}") is not None
        assert find_tab(self.driver, f"Edit: {name2}") is not None

    # ── CONN-SAVE-CONNECT: Save & Connect (PR #112) ────────────────────────────
    def test_save_and_connect_opens_terminal(self):
        name = self._name("save-conn")
        self.open_new_connection_editor()
        self.driver.type(self.EDITOR_NAME, name)
        self.driver.click(self.EDITOR_SAVE_CONNECT)
        self.require_connection(name)
        self.wait(lambda: find_tab(self.driver, name) is not None, what="the connected terminal tab")

    # ── CONN-DUP-NAME: duplicate-name validation (#380) ────────────────────────
    def test_duplicate_name_shows_error(self):
        name = self._name("dup-check")
        self.create_local_connection(name)

        self.open_new_connection_editor()
        self.driver.type(self.EDITOR_NAME, name)
        self.wait(lambda: self.driver.exists(self.EDITOR_NAME_ERROR), what="the duplicate-name error")
        assert "already exists" in self.driver.get_text(self.EDITOR_NAME_ERROR)

    def test_duplicate_name_blocks_save(self):
        name = self._name("dup-block")
        self.create_local_connection(name)

        self.open_new_connection_editor()
        self.driver.type(self.EDITOR_NAME, name)
        self.wait(lambda: self.driver.exists(self.EDITOR_NAME_ERROR), what="the duplicate-name error")
        self.driver.click(self.EDITOR_SAVE)
        # Save is blocked: the editor stays open and the error remains.
        assert self.editor_open()
        assert self.driver.exists(self.EDITOR_NAME_ERROR)

    def test_duplicate_name_error_clears_on_unique(self):
        name = self._name("dup-clear")
        self.create_local_connection(name)

        self.open_new_connection_editor()
        self.driver.type(self.EDITOR_NAME, name)
        self.wait(lambda: self.driver.exists(self.EDITOR_NAME_ERROR), what="the duplicate-name error")

        unique = self._name("dup-fixed")
        self.driver.type(self.EDITOR_NAME, unique)
        self.wait(
            lambda: not self.driver.exists(self.EDITOR_NAME_ERROR),
            what="the error to clear",
        )
        self.driver.click(self.EDITOR_SAVE)
        self.require_connection(unique)

    def test_edit_without_changing_name_saves(self):
        name = self._name("self-edit")
        self.create_local_connection(name)

        self.connection_context_action(name, self.CTX_EDIT)
        self.wait(self.editor_open, what="the edit editor")
        # Editing a connection's own name is not a duplicate — no error.
        assert not self.driver.exists(self.EDITOR_NAME_ERROR)
        self.driver.click(self.EDITOR_SAVE)
        self.wait(lambda: not self.editor_open(), what="the editor to close")

    # ── CONN-PING: ping host context menu (PR #37) ─────────────────────────────
    def test_ping_menu_shown_for_ssh(self):
        name = self._name("ping-ssh")
        self.create_typed_connection(
            name, "ssh", {"host": "127.0.0.1", "port": "22", "username": "tester"}
        )
        self.open_connection_menu(name)
        assert self.driver.exists(self.CTX_PING)

    def test_ping_menu_hidden_for_local(self):
        name = self._name("ping-local")
        self.create_local_connection(name)
        self.open_connection_menu(name)
        assert not self.driver.exists(self.CTX_PING)

    def test_ping_opens_tab(self):
        name = self._name("ping-tab")
        self.create_typed_connection(name, "ssh", {"host": "127.0.0.1", "port": "22"})
        self.connection_context_action(name, self.CTX_PING)
        self.wait(lambda: find_tab(self.driver, "Ping") is not None, what="a Ping tab")

    # ── MT-CONN-04: create SSH connection ──────────────────────────────────────
    def test_create_ssh_connection(self):
        name = self._name("ssh-conn")
        self.create_typed_connection(
            name, "ssh", {"host": "192.168.1.1", "port": "22", "username": "tester"}
        )
        assert self.find_connection(name) is not None

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
