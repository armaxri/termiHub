"""Split-view creation, panel close, and nested splits.

Ported from ``tests/e2e/split-views.test.js`` (SPLIT-01/03/06) onto the Python
bridge harness (#808). The old test inferred panel count from the
``terminal-view-close-panel`` button (it renders only when ``allLeaves.length
> 1``); here we assert that directly *and* count leaves in the ``rootPanel``
tree via ``leaf_count()`` for a stronger structural check.
"""

import pytest

from termihub_harness import SystemTest

pytestmark = pytest.mark.integration

SPLIT_H = "terminal-view-split-horizontal"
NEW_TERMINAL = "terminal-view-new-terminal"
CLOSE_PANEL = "terminal-view-close-panel"


class TestSplitViews(SystemTest):
    def _reset_to_single_terminal(self) -> None:
        """Collapse any splits and leave exactly one terminal panel open."""
        self.close_all_tabs()
        self.ensure_terminal()
        self.wait(lambda: self.leaf_count() == 1, what="a single panel")

    def test_split_creates_a_second_panel(self):
        self._reset_to_single_terminal()
        assert self.leaf_count() == 1
        assert not self.driver.exists(CLOSE_PANEL)

        self.driver.click(SPLIT_H)
        self.wait(lambda: self.leaf_count() == 2, what="a second panel")
        assert self.driver.get_state("rootPanel.type") == "split"
        assert self.driver.exists(CLOSE_PANEL)
        self.delay4user(2, reason="split into two panels")

    def test_close_panel_removes_a_panel(self):
        self._reset_to_single_terminal()
        self.driver.click(SPLIT_H)
        self.wait(lambda: self.leaf_count() == 2, what="a second panel")
        assert self.driver.exists(CLOSE_PANEL)

        self.driver.click(CLOSE_PANEL)
        self.wait(lambda: self.leaf_count() == 1, what="the panel to close")
        assert not self.driver.exists(CLOSE_PANEL)
        self.delay4user(2, reason="back to a single panel")

    def test_nested_splits_stack_up_and_unwind(self):
        self._reset_to_single_terminal()

        self.driver.click(SPLIT_H)
        self.wait(lambda: self.leaf_count() == 2, what="two panels")

        # Give the new panel a terminal, then split it again.
        self.driver.click(NEW_TERMINAL)
        self.driver.click(SPLIT_H)
        self.wait(lambda: self.leaf_count() == 3, what="three panels")
        assert self.driver.exists(CLOSE_PANEL)

        self.driver.click(CLOSE_PANEL)
        self.wait(lambda: self.leaf_count() == 2, what="two panels after one close")
        assert self.driver.exists(CLOSE_PANEL)

        self.close_all_tabs()
