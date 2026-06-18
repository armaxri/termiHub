"""Drag-to-resize of the sidebar, with min/max clamping and width persistence.

Ported from ``tests/e2e/sidebar-resize.test.js`` (#499) onto the Python bridge
harness (#808). This suite exercises the two bridge verbs added for #808:

* ``drag`` — performs the pointer drag the WebDriver ``performActions`` used to,
  driving ``useSidebarResize``'s ``mousedown``/``mousemove``/``mouseup`` handlers.
* ``get_computed_style`` — reads the effective ``cursor`` (``col-resize``), which
  ``get_attribute`` cannot see because it comes from a stylesheet, not markup.

The resize *result* is asserted against ``sidebarWidth`` in the store rather than
a measured DOM rectangle — the value the handler actually drives.
"""

import pytest

from termihub_harness import SystemTest

pytestmark = pytest.mark.integration

HANDLE = "sidebar-resize-handle"
TOGGLE = "terminal-view-toggle-sidebar"
MIN_WIDTH = 170
MAX_WIDTH = 600


class TestSidebarResize(SystemTest):
    def _width(self) -> float:
        return self.driver.get_state("sidebarWidth")

    def _ensure_sidebar_shown(self) -> None:
        """Make sure the sidebar (and thus its resize handle) is present."""
        if not self.driver.exists("sidebar"):
            self.ensure_terminal()
            self.driver.click(TOGGLE)
            self.wait(lambda: self.driver.exists("sidebar"), what="the sidebar to show")
        assert self.driver.exists(HANDLE)

    def _reset_width(self) -> float:
        """Settle the sidebar at a mid width with room to grow and shrink.

        Drags are delta-based and clamp at the bounds, so clamping to the minimum
        and then nudging right yields a deterministic baseline regardless of where
        a previous test left the width (the suite shares one app).
        """
        self._ensure_sidebar_shown()
        self.driver.drag(HANDLE, -2000)  # clamp to MIN_WIDTH
        self.driver.drag(HANDLE, 130)  # settle at ~MIN_WIDTH + 130
        return self._width()

    def test_resize_handle_is_present(self):
        self._ensure_sidebar_shown()
        assert self.driver.exists(HANDLE)

    def test_handle_has_a_col_resize_cursor(self):
        self._ensure_sidebar_shown()
        assert self.driver.get_computed_style("cursor", HANDLE) == "col-resize"

    def test_dragging_right_widens_the_sidebar(self):
        before = self._reset_width()
        self.driver.drag(HANDLE, 100)
        self.wait(lambda: self._width() > before, what="the sidebar to widen")
        self.delay4user(2, reason="sidebar widened")

    def test_dragging_left_narrows_the_sidebar(self):
        before = self._reset_width()
        self.driver.drag(HANDLE, -80)
        self.wait(lambda: self._width() < before, what="the sidebar to narrow")
        self.delay4user(2, reason="sidebar narrowed")

    def test_width_clamps_at_the_minimum(self):
        self._reset_width()
        self.driver.drag(HANDLE, -2000)
        self.wait(lambda: self._width() <= MIN_WIDTH + 1, what="the minimum width")
        assert self._width() >= MIN_WIDTH

    def test_width_clamps_at_the_maximum(self):
        self._reset_width()
        self.driver.drag(HANDLE, 2000)
        self.wait(lambda: self._width() >= MAX_WIDTH - 1, what="the maximum width")
        assert self._width() <= MAX_WIDTH

    def test_width_is_preserved_across_collapse_and_expand(self):
        self._reset_width()
        self.driver.drag(HANDLE, 60)
        width = self._width()

        self.ensure_terminal()  # the toolbar toggle needs an open panel
        self.driver.click(TOGGLE)
        self.wait(lambda: not self.driver.exists("sidebar"), what="the sidebar to collapse")
        self.driver.click(TOGGLE)
        self.wait(lambda: self.driver.exists("sidebar"), what="the sidebar to expand")

        assert self._width() == width
        self.close_all_tabs()
