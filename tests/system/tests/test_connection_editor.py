"""Extended connection-editor behavior — ported from the WebdriverIO
``connection-editor-extended.test.js`` to the Python bridge harness (#838).

Ports the still-present, deterministic behavior the old suite covered: creating
a connection inside a folder via the folder context menu (and keeping it there
after an edit), editing an existing connection loading its saved values, the SSH
key-path combobox + browse button, the inline key-file validation hint (PR #204,
restored in #896), and the schema-driven dynamic field visibility (auth-method
toggles the key-path field; every type renders a settings form).

The Settings → General **defaults pre-filling new SSH connections** (PR #201) is
covered and passing. The #889 "regression" was a harness race in
``_set_general_defaults`` (it waited on the immediate ``settings`` slice and
closed the tab before the debounced persist committed, so the unsaved-changes
"just close" discarded the values); waiting on ``savedSettings`` fixed it.

Large parts of the original targeted UI that has since changed or been removed,
so they are dropped by design (each old test was written defensively — it
``return``ed early when its element was absent — so it had become a silent
no-op):

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
    unique_name,
)

pytestmark = pytest.mark.integration

DEFAULT_KEY = "/home/tester/.ssh/id_ed25519"

#: Projection region id for the settings domain (twin of the frontend
#: ``SETTINGS_REGION`` const). The Phase-5 reducer removal (#2404) deleted the
#: ``appStore.settings`` / ``savedSettings`` slices this suite read via
#: ``get_state``; the persisted ``AppSettings`` document is now this region's view
#: one-to-one, so its fields are read straight off the region cache (#2670).
SETTINGS_REGION = "settings"


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

    def _settings_value(self, key: str):
        """Read a top-level field of the authoritative ``settings`` region cache.

        Region-authoritative since #2404: the ``appStore.settings`` /
        ``savedSettings`` slices are gone, so the value is read off the ``settings``
        projection region view (which maps one-to-one to the persisted
        ``AppSettings`` document). An unset optional field (``value || undefined``)
        is simply absent from the document, so a missing key reads as ``None`` —
        the region cache always returns a dict, so there is no error to catch.
        """
        return self.projection_region_cache(SETTINGS_REGION).get(key)

    def _set_general_defaults(self, *, user: str, key_path: str) -> None:
        """Set Settings → General default user + SSH key, waiting for the save.

        The settings panel debounces its save and folds the result into the
        authoritative ``settings`` region; the region also carries the optimistic
        edit, so a field settling to the typed value confirms the write took. A
        settings tab auto-flushes any pending debounced save when it closes (it
        raises no unsaved-changes dialog), so once the region reflects the values
        ``close_all_tabs`` persists them and a new editor reads them on open.

        **Each field is typed and settled before the next.** Both General inputs'
        ``onChange`` spread the *current* ``settings`` prop
        (``onChange({...settings, <field>: value})``), so firing the two ``type``s
        back-to-back can run the second against a ``settings`` snapshot that
        predates the first — its spread then drops the first field's just-typed
        value. That stale-closure clobber surfaced only under CI render latency:
        ``test_defaults_prefill`` (which types a real key path) reliably lost its
        default *user*, timing out on "the default user to persist" (#2674).
        Waiting for each field to reach the region forces the re-render that
        refreshes the prop, so the next ``type`` spreads a current snapshot.
        """
        self.open_settings_category("general")
        self.wait(
            lambda: self.driver.exists("settings-default-user"),
            what="the General settings fields",
        )
        self.driver.type("settings-default-user", user)
        self.wait(
            lambda: self._settings_value("defaultUser") == (user or None),
            what="the default user to persist",
        )
        self.driver.type("general-settings-key-path-input", key_path)
        self.wait(
            lambda: self._settings_value("defaultSshKeyPath") == (key_path or None),
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
        self.folder_context_action(folder["id"], "context-folder-new-connection")
        self.wait(self.editor_open, what="the new-connection editor")

        name = unique_name("in-folder")
        self.driver.type(self.EDITOR_NAME, name)
        self.driver.click(self.EDITOR_SAVE)

        conn = self.require_connection(name)
        assert conn["folderId"] == folder["id"]

    def test_connection_stays_in_folder_after_edit(self):
        folder = self.create_folder(unique_name("edit-folder"))
        self.folder_context_action(folder["id"], "context-folder-new-connection")
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

    # ── PR #204 / #896: inline SSH key-file validation hint ─────────────────────
    KEY_PATH_VALIDATION = "field-keyPath-key-path-validation"

    def test_key_path_validation_hint(self):
        # The key-path field validates the selected file on the local machine and
        # shows an inline hint: an error for a missing file, a warning for a file
        # that is not a recognized private key, and nothing for an empty path.
        self._open_ssh_editor()
        self.driver.select("field-authMethod", "key")
        self.wait(lambda: self.driver.exists(self.KEY_PATH_INPUT), what="the key-path field")

        # Missing file → error hint.
        self.driver.type(self.KEY_PATH_INPUT, "/definitely/not/here/missing_key")
        self.wait(
            lambda: self.driver.exists(self.KEY_PATH_VALIDATION),
            what="the missing-file validation hint",
        )
        assert "File not found." in self.driver.get_text(self.KEY_PATH_VALIDATION)

        # Existing non-key file → "not recognized" warning (/etc/hosts is present
        # on the Linux/macOS runners and is not a private key).
        self.driver.type(self.KEY_PATH_INPUT, "/etc/hosts")
        self.wait(
            lambda: "Not a recognized" in self.driver.get_text(self.KEY_PATH_VALIDATION),
            what="the unrecognized-format validation hint",
        )

        # Cleared path → hint disappears (empty path is silently valid).
        self.driver.type(self.KEY_PATH_INPUT, "")
        self.wait(
            lambda: not self.driver.exists(self.KEY_PATH_VALIDATION),
            what="the validation hint to clear for an empty path",
        )

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
    # `buildTypeDefaults` applies the General default user / SSH key to a new SSH
    # connection. The #889 "regression" was a harness race: `_set_general_defaults`
    # waited on the immediate `settings` slice and closed the tab before the
    # debounced persist committed, so the unsaved-changes "just close" discarded
    # the values. Waiting on `savedSettings` (see the helper) fixed it.
    def test_defaults_prefill_new_ssh_connection(self):
        self._set_general_defaults(user="admin", key_path=DEFAULT_KEY)
        self._open_ssh_editor()
        assert self.driver.get_value("field-username") == "admin"
        assert self.driver.get_value("field-authMethod") == "key"
        self.wait(lambda: self.driver.exists(self.KEY_PATH_INPUT), what="the key-path field")
        assert self.driver.get_value(self.KEY_PATH_INPUT) == DEFAULT_KEY

    def test_default_user_only_keeps_schema_default_auth(self):
        # Setting only a default *user* (no default key) applies the username but
        # leaves the auth method at the SSH schema's own default. Only a default
        # *key path* flips a password default to key auth (buildTypeDefaults).
        # The schema default is now "key" (it was "password" under the original
        # PR #201 config, before connection types became schema-driven).
        self._set_general_defaults(user="onlyuser", key_path="")
        self._open_ssh_editor()
        assert self.driver.get_value("field-username") == "onlyuser"
        assert self.driver.get_value("field-authMethod") == "key"

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
