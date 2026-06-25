"""External connection files & SSH key-path input.

Ported from ``tests/e2e/external-files.test.js`` onto the Python bridge harness
(#809). Covers MT-CONN-21 (manual SSH key-path entry) and MT-CONN-22 / MT-CONN-31
(the External Connection Files settings section and its actions).

The key-path field is a React-controlled ``KeyPathInput``, so its live value is
read with ``get_value`` (the DOM property), not ``get_attribute``. The settings
section has no per-button testid, so its presence and the Create/Add File actions
are asserted via the section's text content (``settings-external-files``).

Not ported: MT-CONN-20 (agent-connection key browse) — it was a conditional smoke
check whose key-path coverage is fully subsumed by MT-CONN-21 here.
"""

import pytest

from termihub_harness import ConnectionsUi, SettingsUi, SidebarUi, SystemTest, TabsUi

pytestmark = pytest.mark.integration


class TestExternalFiles(ConnectionsUi, SettingsUi, SidebarUi, TabsUi, SystemTest):
    # ── MT-CONN-21: manual key path input works ─────────────────────────────
    def test_ssh_editor_accepts_a_manually_typed_key_path(self):
        self.open_new_connection_editor()
        self.wait(
            lambda: self._try_select("connection-editor-type-select", "ssh"),
            what="the SSH connection type",
        )
        self.wait(lambda: self.driver.exists("field-authMethod"), what="the SSH auth field")
        self.driver.select("field-authMethod", "key")
        key_input = "field-keyPath-key-path-input"
        self.wait(lambda: self.driver.exists(key_input), what="the key-path field")
        self.driver.type(key_input, "/home/user/.ssh/id_rsa")
        assert ".ssh/id_rsa" in self.driver.get_value(key_input)
        self.driver.click(self.EDITOR_CANCEL)

    # ── MT-CONN-22 / MT-CONN-31: External Connection Files settings ─────────
    def test_settings_shows_the_external_files_section(self):
        self.open_settings_category("external-files")
        self.wait(
            lambda: self.driver.exists("settings-external-files"),
            what="the External Connection Files section",
        )
        assert "External Connection Files" in self.driver.get_text("settings-external-files")

    def test_external_files_section_offers_create_and_add_actions(self):
        self.open_settings_category("external-files")
        self.wait(
            lambda: self.driver.exists("settings-external-files"),
            what="the External Connection Files section",
        )
        text = self.driver.get_text("settings-external-files")
        assert "Create File" in text
        assert "Add File" in text
