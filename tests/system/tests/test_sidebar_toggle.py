"""Sidebar show/hide toggle in the terminal-view toolbar.

Ported from ``tests/e2e/sidebar-toggle.test.js`` (PR #194) onto the Python
bridge harness (#808). The toolbar toggle flips ``sidebarCollapsed``; the
``Sidebar`` component renders ``null`` while collapsed, so the bridge's
``exists("sidebar")`` is a faithful stand-in for the old ``.isDisplayed()``
check, and the button's ``--active`` class mirrors "sidebar currently shown".
"""

import pytest

from termihub_harness import SystemTest

pytestmark = pytest.mark.integration

TOGGLE = "terminal-view-toggle-sidebar"
ACTIVE_CLASS = "terminal-view__toolbar-btn--active"


class TestSidebarToggle(SystemTest):
    """One app for the suite; each test normalizes the sidebar it depends on."""

    def _toggle_active(self) -> bool:
        """Whether the toolbar toggle is highlighted (sidebar shown)."""
        return ACTIVE_CLASS in (self.driver.get_attribute(TOGGLE, "class") or "")

    def _set_sidebar(self, visible: bool) -> None:
        """Bring the sidebar to the desired visibility via the toolbar toggle.

        The toggle only exists while a terminal panel (hence the toolbar) is open,
        so a terminal is ensured first.
        """
        self.ensure_terminal()
        if self.driver.exists("sidebar") != visible:
            self.driver.click(TOGGLE)
            self.wait(
                lambda: self.driver.exists("sidebar") == visible,
                what=f"sidebar visible={visible}",
            )

    def test_toggle_button_is_present_with_a_terminal_open(self):
        self.ensure_terminal()
        assert self.driver.exists(TOGGLE)
        self.delay4user(1, reason="toolbar toggle visible")

    def test_clicking_toggle_hides_the_sidebar(self):
        self._set_sidebar(True)
        assert self.driver.exists("sidebar")
        self.driver.click(TOGGLE)
        self.wait(lambda: not self.driver.exists("sidebar"), what="the sidebar to hide")
        assert self.driver.get_state("sidebarCollapsed") is True
        self.delay4user(2, reason="sidebar hidden")

    def test_clicking_toggle_again_shows_the_sidebar(self):
        self._set_sidebar(False)
        self.driver.click(TOGGLE)
        self.wait(lambda: self.driver.exists("sidebar"), what="the sidebar to show")
        assert self.driver.get_state("sidebarCollapsed") is False
        self.delay4user(2, reason="sidebar shown again")

    def test_toggle_is_highlighted_when_sidebar_is_visible(self):
        self._set_sidebar(True)
        assert self._toggle_active()

    def test_toggle_is_not_highlighted_when_sidebar_is_hidden(self):
        self._set_sidebar(False)
        assert not self._toggle_active()

    def test_toggle_still_works_after_a_split(self):
        self._set_sidebar(True)
        self.driver.click("terminal-view-split-horizontal")
        self.wait(lambda: self.leaf_count() > 1, what="a second panel")

        assert self.driver.exists(TOGGLE)
        self.driver.click(TOGGLE)
        self.wait(lambda: not self.driver.exists("sidebar"), what="the sidebar to hide after split")
        self.driver.click(TOGGLE)
        self.wait(lambda: self.driver.exists("sidebar"), what="the sidebar to show after split")

        self.close_all_tabs()
