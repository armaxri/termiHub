"""Theme switching and the Customize Layout dialog.

Ported from ``tests/e2e/theme-layout.test.js`` (PR #190/#213/#220/#224/#242/#264)
onto the Python bridge harness (#808). Theme changes are verified through both
the persisted ``settings.theme`` and the resulting ``:root`` CSS variables; layout
toggles are verified through ``layoutConfig`` plus the presence of the affected
chrome (the status bar).

Not ported (kept as manual tests in docs/testing.md): the activity-bar-position
and tab-border-accent checks assert pixel geometry / element ordering, and the
old activity-bar-position radios (``layout-ab-left`` etc.) are not present in the
current dialog.
"""

import pytest

from termihub_harness import SETTINGS_REGION, SettingsUi, SystemTest, TabsUi

pytestmark = pytest.mark.integration

THEME_SELECT = "appearance-theme-select"


class TestThemeLayout(TabsUi, SettingsUi, SystemTest):
    def _open_customize_layout(self) -> None:
        self.driver.click("activity-bar-settings")
        self.wait(lambda: self.driver.exists("settings-menu-customize-layout"), what="the gear menu")
        self.driver.click("settings-menu-customize-layout")
        self.wait(lambda: self.driver.exists("layout-close"), what="the customize layout dialog")

    def test_switching_theme_updates_state_and_css_variables(self):
        self.open_settings_tab()
        self.driver.click("settings-nav-appearance")
        self.wait(lambda: self.driver.exists(THEME_SELECT), what="the theme selector")

        self.driver.select(THEME_SELECT, "light")
        self.wait(
            lambda: self.projection_region_cache(SETTINGS_REGION).get("theme") == "light",
            what="light theme",
        )
        light_bg = self.driver.get_computed_style("--bg-primary")
        self.delay4user(2, reason="light theme applied")

        self.driver.select(THEME_SELECT, "dark")
        self.wait(
            lambda: self.projection_region_cache(SETTINGS_REGION).get("theme") == "dark",
            what="dark theme",
        )
        dark_bg = self.driver.get_computed_style("--bg-primary")
        self.delay4user(2, reason="dark theme applied")

        assert light_bg and dark_bg and light_bg != dark_bg
        self.close_all_tabs()

    def test_customize_layout_toggles_the_status_bar(self):
        self._open_customize_layout()
        before = self.driver.get_state("layoutConfig.statusBarVisible")

        self.driver.click("layout-statusbar-visible")
        self.wait(
            lambda: self.driver.get_state("layoutConfig.statusBarVisible") != before,
            what="the status-bar flag to flip",
        )
        # The status-bar chrome follows the flag.
        assert self.driver.exists("status-bar") == self.driver.get_state(
            "layoutConfig.statusBarVisible"
        )

        self.driver.click("layout-statusbar-visible")  # restore
        self.wait(
            lambda: self.driver.get_state("layoutConfig.statusBarVisible") == before,
            what="the status-bar flag restored",
        )
        self.driver.click("layout-close")

    def test_customize_layout_toggles_sidebar_visibility(self):
        self._open_customize_layout()
        before = self.driver.get_state("layoutConfig.sidebarVisible")

        self.driver.click("layout-sidebar-visible")
        self.wait(
            lambda: self.driver.get_state("layoutConfig.sidebarVisible") != before,
            what="the sidebar-visible flag to flip",
        )
        self.driver.click("layout-sidebar-visible")  # restore
        self.wait(
            lambda: self.driver.get_state("layoutConfig.sidebarVisible") == before,
            what="the sidebar-visible flag restored",
        )
        self.driver.click("layout-close")
