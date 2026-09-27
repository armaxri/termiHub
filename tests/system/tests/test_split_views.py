"""Split-view creation, panel close, nested splits, divider resize and borders.

Ported from ``tests/e2e/split-views.test.js`` (SPLIT-01/03/06) onto the Python
bridge harness (#808). The old test inferred panel count from the
``terminal-view-close-panel`` button (it renders only when ``allLeaves.length
> 1``); here we assert that directly *and* count leaves in the ``rootPanel``
tree via ``leaf_count()`` for a stronger structural check.

Also automates the legacy manual layout items (#3693): dragging the split divider
resizes the panels (MT-UI-11 / MT-TAB-16) — asserted on both the stored split
``sizes`` and the rendered panel width/height — and the 1px ``--panel-border``
line between split panels (MT-UI-12/14/15), read as computed styles after a
left/right and a top/bottom split.
"""

import pytest

from termihub_harness import LayoutUi, SystemTest, TabsUi, TerminalUi

pytestmark = pytest.mark.integration

SPLIT_H = "terminal-view-split-horizontal"
SPLIT_V = "terminal-view-split-vertical"
NEW_TERMINAL = "terminal-view-new-terminal"
CLOSE_PANEL = "terminal-view-close-panel"
TRANSPARENT = ("transparent", "rgba(0, 0, 0, 0)")


def _px(value: str) -> float:
    """Parse a computed ``"123.5px"`` length."""
    return float(value.removesuffix("px"))


class TestSplitViews(TerminalUi, TabsUi, LayoutUi, SystemTest):
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

    # ── Divider resize (MT-UI-11 / MT-TAB-16) and split borders (MT-UI-12/14/15) ──
    def _split_settled(self, button: str) -> tuple[str, str]:
        """Split a single terminal via ``button``; return the settled leaf ids.

        Ids are read only once the layout has settled — a split's new panel id
        churns optimistic -> authoritative (#2705).
        """
        self._reset_to_single_terminal()
        self.driver.click(button)
        self.wait(lambda: self.leaf_count() == 2, what="a second panel")
        first, second = self.leaf_ids(self.settled_root_panel())
        return first, second

    def _first_size(self) -> float:
        """The first split child's stored size in percent (50 until a resize)."""
        sizes = self.driver.get_state("rootPanel.sizes")
        return float(sizes[0]) if isinstance(sizes, list) and sizes else 50.0

    def _panel_px(self, panel_id: str, prop: str) -> float:
        return _px(self.driver.get_computed_style(prop, f"panel-content-{panel_id}"))

    def _assert_divider_resizes(self, button: str, prop: str, axis: str) -> None:
        first, second = self._split_settled(button)
        # The separator sits before the panel it precedes, keyed by that panel.
        handle = f"split-view-resize-handle-{second}"
        assert self.driver.exists(handle), "no divider to drag"

        def drag(delta: float) -> None:
            if axis == "x":
                self.driver.drag(handle, delta)
            else:
                self.driver.drag(handle, 0, delta)

        size_before = self._first_size()
        px_before = self._panel_px(first, prop)
        drag(-120)
        self.wait(
            lambda: self._first_size() < size_before - 5, what="the first panel to shrink"
        )
        assert self._panel_px(first, prop) < px_before, f"panel {prop} did not shrink"
        self.delay4user(2, reason="divider dragged towards the first panel")

        size_shrunk = self._first_size()
        drag(240)
        self.wait(
            lambda: self._first_size() > size_shrunk + 5, what="the first panel to grow"
        )
        assert self._panel_px(first, prop) > px_before, f"panel {prop} did not grow"
        self.close_all_tabs()

    def test_dragging_the_vertical_divider_resizes_left_right_panels(self):
        self._assert_divider_resizes(SPLIT_H, "width", "x")

    def test_dragging_the_horizontal_divider_resizes_top_bottom_panels(self):
        self._assert_divider_resizes(SPLIT_V, "height", "y")

    def _assert_border(self, panel_id: str, side: str) -> None:
        tid = f"panel-content-{panel_id}"
        style = self.driver.get_computed_style
        assert style(f"border-{side}-width", tid) == "1px"
        assert style(f"border-{side}-style", tid) == "solid"
        assert style(f"border-{side}-color", tid) not in TRANSPARENT

    def test_left_right_split_draws_a_1px_border_between_panels(self):
        _, right = self._split_settled(SPLIT_H)
        # The right panel's left edge is the line between the two panels.
        self._assert_border(right, "left")
        self.delay4user(2, reason="1px line between left and right panels")
        self.close_all_tabs()

    def test_top_bottom_split_draws_a_1px_border_between_panels(self):
        top, bottom = self._split_settled(SPLIT_V)
        # The bottom panel's top edge is the line between the two panels; the top
        # panel has no top border (nothing above it to separate from).
        self._assert_border(bottom, "top")
        assert self.driver.get_computed_style("border-top-width", f"panel-content-{top}") == "0px"
        self.delay4user(2, reason="1px line between top and bottom panels")
        self.close_all_tabs()
