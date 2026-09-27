"""UI state persistence and theming.

Ported from ``tests/e2e/ui-state.test.js`` (MT-UI-06/07/08) onto the Python
bridge harness (#808). Assertions map to store state and computed theme
variables rather than DOM geometry.

Not ported (kept as manual tests in docs/testing.md): MT-UI-17 / MT-UI-18 resize
the **OS window**, which the in-webview bridge cannot drive, and MT-UI-20 checks
a dev-server favicon link — neither is observable through the bridge contract.
"""

import pytest

from termihub_harness import ProjectionHarness, SETTINGS_REGION, SystemTest, TabsUi

pytestmark = pytest.mark.integration


class TestUiState(ProjectionHarness, TabsUi, SystemTest):
    def test_new_terminal_is_tracked_as_an_active_tab(self):
        # MT-UI-06: a new terminal is a live, active tab in the panel state.
        self.close_all_tabs()
        before = len(self.tab_ids())
        self.driver.click("terminal-view-new-terminal")
        self.wait(lambda: len(self.tab_ids()) == before + 1, what="a new tab")
        active = self.driver.get_state("rootPanel.activeTabId")
        assert active in self.tab_ids()

    def test_theme_persists_across_an_app_restart(self):
        # MT-UI-07: the chosen theme survives a kill/relaunch of the app. Read via
        # the settings object since `theme` is unset (defaulted) until chosen.
        theme_before = self.projection_region_cache(SETTINGS_REGION).get("theme")
        self.restart_app()
        assert self.projection_region_cache(SETTINGS_REGION).get("theme") == theme_before

    def test_right_click_behavior_persists_across_an_app_restart(self):
        # Legacy manual MT-UI-29 (#3681): the Right-Click Behavior setting survives
        # a kill/relaunch. Set via the authoritative settings region, then restore.
        def behavior():
            return self.projection_region_cache(SETTINGS_REGION).get("rightClickBehavior")

        self.projection_dispatch_intent(
            "settings.patch", {"patch": {"rightClickBehavior": "quickAction"}}
        )
        self.wait(lambda: behavior() == "quickAction", what="quickAction to apply")
        try:
            self.restart_app()
            self.wait(lambda: behavior() == "quickAction", what="quickAction after restart")
        finally:
            self.projection_dispatch_intent(
                "settings.patch", {"patch": {"rightClickBehavior": "contextMenu"}}
            )

    def test_root_uses_theme_css_variables(self):
        # MT-UI-08: the theme drives CSS custom properties on :root.
        assert self.driver.get_computed_style("--bg-primary") != ""
        assert self.driver.get_computed_style("--text-primary") != ""
