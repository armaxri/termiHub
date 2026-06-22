"""Settings tab, gear menu, status bar, tab coloring, and monitoring entry.

Ported from ``tests/e2e/settings.test.js`` onto the Python bridge harness (#808).
Tab color is asserted from ``tabColors`` / the tab's inline ``border-left`` style;
the monitoring entry point is asserted from the status-bar button that appears
once an SSH connection exists.

Not ported (kept as manual tests in docs/testing.md): the gear-vs-connections
icon Y-position ordering check (pixel geometry).
"""

import pytest

from termihub_harness import SystemTest, unique_name

pytestmark = pytest.mark.integration


class TestSettings(SystemTest):
    # ── Settings tab + gear menu ────────────────────────────────────────────
    def test_opens_a_settings_tab(self):
        self.close_all_tabs()
        self.open_settings_tab()
        assert self.find_tab("Settings") is not None

    def test_reuses_the_existing_settings_tab(self):
        self.close_all_tabs()
        self.open_settings_tab()
        self.open_settings_tab()
        # Exactly one tab titled "Settings" should exist.
        assert sum(1 for t in self._all_tabs() if t.get("title") == "Settings") == 1

    def test_gear_menu_lists_settings_import_export(self):
        self.driver.click("activity-bar-settings")
        self.wait(lambda: self.driver.exists("settings-menu-open"), what="the gear menu")
        assert self.driver.exists("settings-menu-import")
        assert self.driver.exists("settings-menu-export")
        self.driver.key("Escape")

    def test_connection_list_toolbar_has_no_import_export(self):
        self.set_sidebar_visible(True)
        assert self.driver.exists("connection-list-new-folder")
        assert self.driver.exists("connection-list-new-connection")
        assert not self.driver.exists("connection-list-import")
        assert not self.driver.exists("connection-list-export")

    def test_status_bar_is_present(self):
        assert self.driver.exists("status-bar")

    def test_settings_tab_can_be_closed(self):
        self.close_all_tabs()
        self.open_settings_tab()
        tab = self.find_tab("Settings")
        assert tab is not None
        self.close_tab(tab["id"])
        self.wait(lambda: self.find_tab("Settings") is None, what="the settings tab to close")

    # ── Tab coloring via the connection editor ──────────────────────────────
    @pytest.mark.skip(
        reason="Exercises the connection-editor color-picker flow, which belongs "
        "to the #807 connections port (shared editor helpers). Tab coloring itself "
        "is already covered by test_tab_management.test_set_tab_color_via_context_menu."
    )
    def test_colored_connection_applies_a_tab_color(self):
        self.set_sidebar_visible(True)
        name = "ColorConn"
        self.create_local_connection(name)
        conn_id = self.connection_id(name)

        self.driver.right_click(f"connection-item-{conn_id}")
        self.wait(lambda: self.driver.exists("context-connection-edit"), what="the connection menu")
        self.driver.click("context-connection-edit")
        self.wait(lambda: self.driver.exists("connection-editor-color-picker"), what="the editor")
        self.driver.click("connection-editor-color-picker")
        self.wait(lambda: self.driver.exists("color-picker-apply"), what="the color picker")
        if self.driver.exists("color-picker-swatch-ef4444"):
            self.driver.click("color-picker-swatch-ef4444")
        else:
            self.driver.type("color-picker-hex-input", "#ef4444")
        self.driver.click("color-picker-apply")
        self.driver.click("connection-editor-save")
        self.wait(lambda: self.find_tab(name) is None, what="the editor to close")

        self.connect_to(name)
        tab = self.find_tab(name)
        assert tab is not None
        assert "border-left" in (self.driver.get_attribute(f"tab-{tab['id']}", "style") or "")
        self.close_all_tabs()

    # ── Monitoring entry point ──────────────────────────────────────────────
    @pytest.mark.skip(
        reason="The status-bar monitoring entry point is covered comprehensively by "
        "the #812 SSH port (tests/system/tests/test_ssh_monitoring.py and "
        "test_ssh_monitoring_settings.py), which exercise it with a live SSH session."
    )
    def test_monitor_button_appears_with_an_ssh_connection(self):
        self.set_sidebar_visible(True)
        self.create_ssh_connection(
            unique_name("mon"), host="127.0.0.1", port=22, username="root"
        )
        self.wait(self.monitoring_visible, what="the status-bar monitoring entry")
