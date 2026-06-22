"""Global monitoring / file-browser settings (ported from infrastructure/ssh-monitoring.test.js,
"Optional monitoring and file browser settings" group).

Drives the Settings > External Files toggles (`toggle-power-monitoring` /
`toggle-file-browser`) and asserts they gate monitoring and the SFTP browser.

The per-connection override tests from the original are intentionally not ported:
the `enableMonitoring` / `enableFileBrowser` fields exist only for *agent*
connections (AgentSettingsForm), not in the SSH connection editor, so the
originals were soft no-ops (`expect(true).toBe(true)`).
"""

from __future__ import annotations

import pytest

from termihub_harness import SSH_PASSWORD_PORT, SSH_USERNAME, SystemTest, unique_name

pytestmark = pytest.mark.integration

HOST = "127.0.0.1"
POWER = ("toggle-power-monitoring", "settings.powerMonitoringEnabled")
FILES = ("toggle-file-browser", "settings.fileBrowserEnabled")


@pytest.mark.usefixtures("ssh_fixtures")
class TestSshMonitoringSettings(SystemTest):
    @pytest.fixture(autouse=True)
    def _restore_settings(self):
        yield
        # Both default on — restore so tests/suites don't leak global state.
        self._set_setting(*POWER, True)
        self._set_setting(*FILES, True)
        self.close_all_tabs()

    def test_toggles_present_in_settings(self):
        self.open_settings_category("external-files")
        assert self.wait(
            lambda: self.driver.exists("toggle-power-monitoring"), what="the toggles"
        )
        assert self.driver.exists("toggle-file-browser")

    def test_global_disable_hides_monitoring(self):
        self._set_setting(*POWER, False)
        self._connect(unique_name("ssh-mon-off"))
        assert self.wait(
            lambda: not self.monitoring_visible(),
            what="monitoring to stay hidden when globally disabled",
        )

    def test_global_reenable_shows_monitoring(self):
        self._set_setting(*POWER, True)
        self._connect(unique_name("ssh-mon-on"))
        self.wait_for_monitoring_stats()

    def test_file_browser_enabled_shows_sftp(self):
        self._set_setting(*FILES, True)
        self._connect(unique_name("ssh-fb-on"))
        self.connect_sftp_browser()
        assert self.wait(lambda: self.file_browser_path() != "", what="an SFTP path")

    def test_default_per_connection_follows_global(self):
        self._set_setting(*POWER, True)
        # A connection with no override follows the (enabled) global setting.
        self._connect(unique_name("ssh-mon-default"))
        self.wait_for_monitoring_stats()

    # ── helpers ────────────────────────────────────────────────────────────────
    def _set_setting(self, toggle: str, field: str, desired: bool) -> None:
        self.open_settings_category("external-files")
        self.wait(lambda: self.driver.exists(toggle), what=f"the {toggle} toggle")
        if bool(self.driver.get_state(field)) != desired:
            self.driver.click(toggle)
            self.wait(
                lambda: bool(self.driver.get_state(field)) == desired,
                what=f"{field} to become {desired}",
            )
        self.switch_to_connections_sidebar()

    def _connect(self, name: str) -> None:
        self.create_ssh_connection(
            name, host=HOST, port=SSH_PASSWORD_PORT, username=SSH_USERNAME, connect=True
        )
        self.handle_password_prompt()
        self.wait(self.has_terminal, what="the SSH terminal session")
