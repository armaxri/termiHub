"""Sidebar section collapse/expand.

Ported from ``tests/e2e/sidebar-sections.test.js`` (MT-UI-21..25) onto the
Python bridge harness (#808). The behavioral assertion — a section folds when
its header toggle is clicked — maps to the ``connection-list__group--expanded``
class on the group element.

Not ported (kept as manual tests in docs/testing.md): the pixel-geometry checks
MT-UI-22 (separator height), MT-UI-23 (space distribution), MT-UI-24 (resize
cursor on hover), and MT-UI-25 (overflow scroll) assert computed sizes/cursor
that are visual properties without a meaningful state equivalent.
"""

import pytest

from termihub_harness import SystemTest

pytestmark = pytest.mark.integration

GROUP = "connection-list-group-connections"
TOGGLE = "connection-list-group-toggle"
EXPANDED_CLASS = "connection-list__group--expanded"


class TestSidebarSections(SystemTest):
    def _expanded(self) -> bool:
        return EXPANDED_CLASS in (self.driver.get_attribute(GROUP, "class") or "")

    def test_section_folds_and_unfolds_via_its_header_toggle(self):
        # MT-UI-21: the connections section collapses to its header and back.
        self.set_sidebar_visible(True)
        assert self.driver.exists("sidebar-group-header-connections")

        if not self._expanded():
            self.driver.click(TOGGLE)
            self.wait(self._expanded, what="the section to start expanded")

        self.driver.click(TOGGLE)
        self.wait(lambda: not self._expanded(), what="the section to collapse")
        self.delay4user(2, reason="section collapsed")

        self.driver.click(TOGGLE)
        self.wait(self._expanded, what="the section to expand")
        self.delay4user(2, reason="section expanded again")
