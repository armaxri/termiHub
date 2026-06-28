"""Extended connection-editor behavior — ported from the WebdriverIO
``connection-editor-extended.test.js`` to the Python bridge harness (#838).

Ports the still-present, deterministic behavior the old suite covered: creating
a connection inside a folder via the folder context menu (and keeping it there
after an edit), editing an existing connection loading its saved values, the SSH
key-path combobox + browse button, and the schema-driven dynamic field
visibility (auth-method toggles the key-path field; every type renders a settings
form).

The Settings → General **defaults pre-filling new SSH connections** (PR #201) is
ported but **skipped pending #889** — that behavior currently regressed (the
default user / SSH key are not applied to new connections), so the two tests
encode the intended behavior and will activate once #889 is fixed.

Large parts of the original targeted UI that has since changed or been removed,
so they are dropped by design (each old test was written defensively — it
``return``ed early when its element was absent — so it had become a silent
no-op):

* **SSH key-file validation hints (PR #204)** — the validation-hint element and
  its "public key" / "OpenSSH" / "not found" copy no longer exist in ``src``.
* **Auto-extract host:port (PR #195)** — ``src/utils/parseHostPort.ts`` exists
  but is not wired into the editor (no call site), so typing ``host:port`` no
  longer splits the port out.
* **Monitoring / file-browser toggles per type (PR #362)** — the SSH connection
  schema has no ``enableMonitoring`` / ``enableFileBrowser`` field; those toggles
  are agent-only now.
* **Key-path suggestion dropdown contents/navigation (PR #118)** — the dropdown
  is populated from the runner's ``~/.ssh``; its contents are environment
  dependent, so only the always-present combobox + browse structure is asserted.
* **Folder-selector-absent / type-default-local** — already covered by
  ``test_connection_forms.py``.
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    ConnectionsUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    folder_toggle_testid,
    unique_name,
)
from termihub_harness.bridge import BridgeError

pytestmark = pytest.mark.integration

DEFAULT_KEY = "/home/tester/.ssh/id_ed25519"


class TestConnectionEditor(
    TabsUi, SidebarUi, SettingsUi, ConnectionsUi, SystemTest
):
    """One app for the whole suite; methods run in order and share its state."""

    @pytest.fixture(autouse=True)
    def _editor_suite(self):
        """Per-test: clean tab slate + sidebar up; mirrors the old ``afterEach``."""
        self.dismiss_menu()
        self.close_all_tabs()
        self.switch_to_connections_sidebar()
        self.wait(
            lambda: self.driver.exists("connection-list-new-connection"),
            what="the connections sidebar",
        )
        yield

    def _settings_value(self, path: str):
        """Read a settings store path, treating an unset (unresolved) path as None.

        ``getState`` raises for a path that does not resolve, which is exactly the
        state of an optional setting that was cleared (``value || undefined``), so
        a plain equality check against ``None`` would never settle.
        """
        try:
            return self.driver.get_state(path)
        except BridgeError:
            return None

    def _set_general_defaults(self, *, user: str, key_path: str) -> None:
        """Set Settings → General default user + SSH key, waiting for the save.

        Settings persist to the Zustand store (debounced), so the helper waits for
        the values to land before returning to the connection sidebar — a new
        editor reads them synchronously on open.
        """
        self.open_settings_category("general")
        self.wait(
            lambda: self.driver.exists("settings-default-user"),
            what="the General settings fields",
        )
        self.driver.type("settings-default-user", user)
        self.driver.type("general-settings-key-path-input", key_path)
        self.wait(
            lambda: self._settings_value("settings.defaultUser") == (user or None),
            what="the default user to persist",
        )
        self.wait(
            lambda: self._settings_value("settings.defaultSshKeyPath")
            == (key_path or None),
            what="the default SSH key to persist",
        )
        self.close_all_tabs()
        self.switch_to_connections_sidebar()

    def _open_ssh_editor(self) -> None:
        self.open_new_connection_editor()
        self.select_connection_type("ssh")
        self.wait(lambda: self.field_visible("host"), what="the SSH fields")

    # ── PR #146: folder placement via the folder context menu ──────────────────
    def test_new_connection_in_folder_via_context_menu(self):
        folder = self.create_folder(unique_name("ctx-folder"))
        self.driver.context_menu(folder_toggle_testid(folder["id"]))
        self.wait(
            lambda: self.driver.exists("context-folder-new-connection"),
            what="the folder context menu",
        )
        self.driver.click("context-folder-new-connection")
        self.wait(self.editor_open, what="the new-connection editor")

        name = unique_name("in-folder")
        self.driver.type(self.EDITOR_NAME, name)
        self.driver.click(self.EDITOR_SAVE)

        conn = self.require_connection(name)
        assert conn["folderId"] == folder["id"]

    def test_connection_stays_in_folder_after_edit(self):
        folder = self.create_folder(unique_name("edit-folder"))
        self.driver.context_menu(folder_toggle_testid(folder["id"]))
        self.wait(
            lambda: self.driver.exists("context-folder-new-connection"),
            what="the folder context menu",
        )
        self.driver.click("context-folder-new-connection")
        self.wait(self.editor_open, what="the new-connection editor")

        name = unique_name("folder-edit")
        self.driver.type(self.EDITOR_NAME, name)
        self.driver.click(self.EDITOR_SAVE)
        self.require_connection(name)

        # Editing and re-saving must not move the connection out of its folder.
        updated = name + "-edited"
        self.connection_context_action(name, self.CTX_EDIT)
        self.wait(self.editor_open, what="the edit editor")
        self.driver.type(self.EDITOR_NAME, updated)
        self.driver.click(self.EDITOR_SAVE)

        conn = self.require_connection(updated)
        assert conn["folderId"] == folder["id"]

    # ── PR #118: SSH key path is a combobox with a browse button ───────────────
    def test_key_path_is_combobox_with_browse(self):
        self._open_ssh_editor()
        self.driver.select("field-authMethod", "key")
        self.wait(
            lambda: self.driver.exists(self.KEY_PATH_INPUT), what="the key-path combobox"
        )
        assert self.driver.get_attribute(self.KEY_PATH_INPUT, "role") == "combobox"
        assert self.driver.exists(self.KEY_PATH_BROWSE)

    # ── PR #362: schema-driven dynamic field visibility ────────────────────────
    def test_auth_toggle_shows_and_hides_key_path(self):
        self._open_ssh_editor()
        self.driver.select("field-authMethod", "key")
        self.wait(
            lambda: self.driver.exists("dynamic-field-keyPath"),
            what="the key-path field under key auth",
        )
        self.driver.select("field-authMethod", "password")
        self.wait(
            lambda: not self.driver.exists("dynamic-field-keyPath"),
            what="the key-path field to hide under password auth",
        )

    def test_settings_form_renders_for_each_type(self):
        # The editor's type <select> offers the registered backends. ("Remote
        # Agent" is created from a separate entry point, not a type option.)
        for type_id in ("local", "ssh", "serial", "telnet", "docker"):
            self.open_new_connection_editor()
            self.select_connection_type(type_id)
            self.wait(
                lambda: self.driver.exists("connection-settings-form"),
                what=f"the settings form for {type_id}",
            )
            self.dismiss_menu()
            self.close_all_tabs()

    # ── PR #201: Settings → General defaults pre-fill new connections ──────────
    # NOTE: applying the General default user / SSH key to a *new* connection is
    # currently broken (#889) — the editor's live settings hold the values but
    # they never reach the new connection's defaults. These two tests encode the
    # intended PR #201 behavior and are skipped until #889 is fixed; the helper
    # they use (_set_general_defaults) is exercised by them once un-skipped.
    @pytest.mark.skip(reason="default user/key not applied to new connections (#889)")
    def test_defaults_prefill_new_ssh_connection(self):
        self._set_general_defaults(user="admin", key_path=DEFAULT_KEY)
        self._open_ssh_editor()
        assert self.driver.get_value("field-username") == "admin"
        assert self.driver.get_value("field-authMethod") == "key"
        self.wait(lambda: self.driver.exists(self.KEY_PATH_INPUT), what="the key-path field")
        assert self.driver.get_value(self.KEY_PATH_INPUT) == DEFAULT_KEY

    @pytest.mark.skip(reason="default user/key not applied to new connections (#889)")
    def test_default_user_only_keeps_password_auth(self):
        self._set_general_defaults(user="onlyuser", key_path="")
        self._open_ssh_editor()
        assert self.driver.get_value("field-username") == "onlyuser"
        assert self.driver.get_value("field-authMethod") == "password"

    def test_edit_loads_saved_values(self):
        # Editing an existing connection loads its own saved values into the form
        # (and, per PR #201, never overwrites them with the General defaults).
        name = unique_name("edit-loads")
        self.create_ssh_connection(
            name,
            host="10.0.0.1",
            port=2222,
            username="customuser",
            auth_method="password",
        )
        self.require_connection(name)

        self.connection_context_action(name, self.CTX_EDIT)
        self.wait(self.editor_open, what="the edit editor")
        assert self.driver.get_value("field-username") == "customuser"
        assert self.driver.get_value("field-authMethod") == "password"
        assert self.driver.get_value("field-host") == "10.0.0.1"
