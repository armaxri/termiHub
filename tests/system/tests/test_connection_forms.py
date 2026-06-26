"""Connection-editor form fields per connection type — ported from the
WebdriverIO ``connection-forms.test.js`` (and the X11/backward-compat check from
``ssh-agent-warning.test.js``) to the Python bridge harness (#838).

Each old ``data-testid`` interaction maps to a bridge step and each assertion to
a check. The editor renders its type-specific fields from the backend
``DynamicForm`` schema, so a field's testid is ``field-<schemaKey>`` — the key
the Rust schema declares (``core/src/backends/*``), not the visible label.

Divergences from the original, by design:

* **Folder dropdown** (``connection-editor-folder-select``) was removed from the
  editor (PR #146), so the "common fields" test asserts it is *absent* rather
  than present — matching ``test_connection_crud.py``'s documented divergence.
* **Horizontal-scroll toggle** (``connection-editor-horizontal-scroll``) no
  longer renders in the editor, so it is dropped from the common-fields check;
  appearance is now the color/icon pickers in ``ConnectionAppearanceSettings``.
* **SSH ``agent`` auth warning** (``MT-SSH-08``) is dropped: ``agent`` is no
  longer a selectable ``authMethod`` (the schema offers only ``key`` /
  ``password`` — ``core/src/backends/ssh/mod.rs``), so the option the old test
  selected no longer exists. The removed-feature gap is already recorded by the
  skipped ``test_ssh_agent_error.py``.
* **X11 default-unchecked** (``MT-SSH-19``) is asserted by saving an SSH
  connection and reading ``enableX11Forwarding`` back from the store: the bridge
  reads an ``<input>``'s ``value`` (``"on"`` for a checkbox) / stale markup
  attribute, neither of which reflects a React checkbox's live ``checked`` state,
  whereas the persisted config captures the real default.
"""

from __future__ import annotations

import pytest

from termihub_harness import ConnectionsUi, SidebarUi, SystemTest, TabsUi, unique_name

pytestmark = pytest.mark.integration


class TestConnectionForms(TabsUi, SidebarUi, ConnectionsUi, SystemTest):
    """One app for the whole suite; methods run in order and share its state."""

    # The folder <select> the editor used to render (removed by PR #146).
    EDITOR_FOLDER = "connection-editor-folder-select"
    EDITOR_TYPE = "connection-editor-type-select"
    EDITOR_COLOR = "connection-editor-color-picker"

    @pytest.fixture(autouse=True)
    def _forms_suite(self):
        """Per-test: clean tab slate + sidebar up; mirrors the old ``afterEach``.

        Every editor tab renders a ``connection-editor-name-input`` with the same
        testid, so a leftover editor tab would make the bridge drive the wrong
        editor. Closing all tabs first keeps each test isolated.
        """
        self.dismiss_menu()
        self.close_all_tabs()
        self.switch_to_connections_sidebar()
        self.wait(
            lambda: self.driver.exists("connection-list-new-connection"),
            what="the connections sidebar",
        )
        yield

    def _field_visible(self, key: str) -> bool:
        """Whether the ``DynamicForm`` field with schema ``key`` is rendered."""
        return self.driver.exists(f"field-{key}")

    # ── Common fields ──────────────────────────────────────────────────────────
    def test_common_fields_present(self):
        # The editor is now category-based (Connection/Terminal/Appearance), so
        # only the always-on Connection-category controls render up front; the
        # color/icon pickers moved under the Appearance category (tested below).
        self.open_new_connection_editor()
        assert self.driver.exists(self.EDITOR_NAME)
        assert self.driver.exists(self.EDITOR_TYPE)
        assert self.driver.exists(self.EDITOR_SAVE)
        assert self.driver.exists(self.EDITOR_CANCEL)

    def test_appearance_category_shows_pickers(self):
        # Color/icon pickers live under the editor's Appearance category, whose
        # nav item reuses SettingsNav's ``settings-nav-<id>`` testid.
        self.open_new_connection_editor()
        self.driver.click("settings-nav-appearance")
        self.wait(lambda: self.driver.exists(self.EDITOR_COLOR), what="the color picker")
        assert self.driver.exists("connection-editor-icon-picker")

    def test_folder_selector_removed(self):
        # PR #146 removed the editor's folder <select>; placement is via the
        # folder context menu now. Assert the old control is gone.
        self.open_new_connection_editor()
        assert not self.driver.exists(self.EDITOR_FOLDER)

    # ── Local shell (LOCAL-01) ─────────────────────────────────────────────────
    def test_type_defaults_to_local(self):
        self.open_new_connection_editor()
        assert self.driver.get_value(self.EDITOR_TYPE) == "local"

    def test_shell_dropdown_has_options(self):
        self.open_new_connection_editor()
        self.wait(lambda: self._field_visible("shell"), what="the shell field")
        # get_text on a <select> returns its option labels concatenated; a
        # platform always has at least one shell, so the text is non-empty.
        assert self.driver.get_text("field-shell").strip() != ""

    def test_shell_dropdown_labels_default(self):
        # PR #140: the system default shell option is labelled "(default)".
        self.open_new_connection_editor()
        self.wait(lambda: self._field_visible("shell"), what="the shell field")
        assert "(default)" in self.driver.get_text("field-shell")

    # ── SSH form fields ────────────────────────────────────────────────────────
    def test_ssh_fields_visible(self):
        self.open_new_connection_editor()
        self.select_connection_type("ssh")
        self.wait(lambda: self._field_visible("host"), what="the SSH fields")
        for key in ("host", "port", "username", "authMethod", "enableX11Forwarding"):
            assert self._field_visible(key), f"expected field-{key} to render for SSH"

    def test_ssh_password_auth_has_no_password_field(self):
        # PR #38: the SSH password is prompted at connect time, not stored in the
        # editor. In the default ("none") credential-store mode the `password`
        # field is filtered out of the schema entirely (schemaDefaults).
        self.open_new_connection_editor()
        self.select_connection_type("ssh")
        self.wait(lambda: self._field_visible("authMethod"), what="the SSH fields")
        self.driver.select("field-authMethod", "password")
        assert not self._field_visible("password")

    def test_ssh_default_port_is_22(self):
        self.open_new_connection_editor()
        self.select_connection_type("ssh")
        self.wait(lambda: self._field_visible("port"), what="the SSH port field")
        assert self.driver.get_value("field-port") == "22"

    # ── MT-SSH-19: X11 backward compatibility ──────────────────────────────────
    def test_ssh_x11_field_present_and_defaults_off(self):
        self.open_new_connection_editor()
        self.select_connection_type("ssh")
        self.wait(
            lambda: self._field_visible("enableX11Forwarding"),
            what="the X11-forwarding field",
        )
        name = unique_name("x11-default")
        self.driver.type(self.EDITOR_NAME, name)
        self.driver.type("field-host", "127.0.0.1")
        self.driver.type("field-username", "tester")
        self.driver.click(self.EDITOR_SAVE)
        conn = self.require_connection(name)
        # A fresh SSH connection has X11 forwarding off (false or unset) — the
        # backward-compatible default for connections saved without the field.
        assert not (conn.get("config") or {}).get("enableX11Forwarding", False)

    # ── Serial form fields ─────────────────────────────────────────────────────
    def test_serial_fields_visible(self):
        self.open_new_connection_editor()
        self.select_connection_type("serial")
        self.wait(lambda: self._field_visible("baudRate"), what="the serial fields")
        for key in ("baudRate", "dataBits", "stopBits", "parity", "flowControl"):
            assert self._field_visible(key), f"expected field-{key} to render for serial"

    # ── Telnet form fields ─────────────────────────────────────────────────────
    def test_telnet_fields_visible(self):
        self.open_new_connection_editor()
        self.select_connection_type("telnet")
        self.wait(lambda: self._field_visible("host"), what="the telnet fields")
        assert self._field_visible("host")
        assert self._field_visible("port")

    def test_telnet_default_port_is_23(self):
        self.open_new_connection_editor()
        self.select_connection_type("telnet")
        self.wait(lambda: self._field_visible("port"), what="the telnet port field")
        assert self.driver.get_value("field-port") == "23"
