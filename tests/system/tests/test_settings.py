"""Settings tab, gear menu, status bar, and activity-bar layout.

Ported from ``tests/e2e/settings.test.js`` onto the Python bridge harness (#808).

Also automates the legacy manual MT-UI-10 (#3693): the Settings tab is dragged
onto another panel's centre drop zone and keeps its gear icon.

Not ported here: the gear-vs-connections icon Y-position ordering check (pixel
geometry — manual, see docs/testing.md); tab coloring and the monitoring entry
point, which are covered by sibling suites (see the note at the end of the class).
"""

import pytest

from termihub_harness import LayoutUi, SettingsUi, SystemTest, TabsUi, TerminalUi

pytestmark = pytest.mark.integration


class TestSettings(TerminalUi, TabsUi, LayoutUi, SettingsUi, SystemTest):
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
        self.driver.press_key("Escape")

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

    # ── Settings tab drag between panels (legacy manual MT-UI-10, #3693) ──────
    def test_settings_tab_drags_to_another_panel_keeping_its_icon(self):
        self.close_all_tabs()
        self.ensure_terminal()
        self.wait(lambda: self.leaf_count() == 1, what="a single panel")
        self.driver.click("terminal-view-split-horizontal")
        self.wait(lambda: self.leaf_count() == 2, what="a second panel")
        self.open_settings_tab()
        self.wait(lambda: self.find_tab("Settings") is not None, what="the settings tab")

        # Read ids only from the settled layout: split/open ids churn
        # optimistic -> authoritative (#2705).
        root = self.settled_root_panel()
        settings_id = self.find_tab("Settings")["id"]
        source = self.panel_of_tab(settings_id, root)
        target = next(pid for pid in self.leaf_ids(root) if pid != source)

        self.driver.drag_to(f"tab-{settings_id}", f"panel-drop-center-{target}")

        def moved() -> bool:
            tab = self.find_tab("Settings")
            return tab is not None and self.panel_of_tab(tab["id"]) == target

        self.wait(moved, what="the settings tab to move into the other panel")
        tab = self.find_tab("Settings")
        assert tab["contentType"] == "settings"
        # Still exactly one Settings tab — moved, not duplicated.
        assert sum(1 for t in self._all_tabs() if t.get("title") == "Settings") == 1
        # It kept the Settings gear icon after the move.
        icon = f"tab-icon-{tab['id']}"
        assert self.driver.exists(icon), "the moved settings tab lost its icon"
        assert "lucide-settings" in (self.driver.get_attribute(icon, "class") or "")
        self.delay4user(2, reason="settings tab moved with its gear icon")
        self.close_all_tabs()

    # SET-04 (tab coloring via the connection editor) and SET-MONITOR (status-bar
    # monitoring entry point) are intentionally not duplicated here: connection
    # coloring is covered by test_tab_management.test_set_tab_color_via_context_menu
    # and the connection-editor flows by the #807 port, and monitoring is covered
    # end-to-end (with a live session) by test_ssh_monitoring*.py from the #812 port.
