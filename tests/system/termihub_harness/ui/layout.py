"""Split-panel and sidebar-visibility helpers (UI-port helpers, #808 → #831).

``LayoutUi`` covers the editor *layout*: counting leaf panels in a split and
toggling whether the sidebar is shown. ``set_sidebar_visible`` ensures a terminal
first (the toggle lives in the terminal-view toolbar), so suites that use it also
mix in :class:`~termihub_harness.ui.TerminalUi`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .base import HarnessMixin


class LayoutUi(HarnessMixin):
    """Count split leaves and toggle overall sidebar visibility."""

    if TYPE_CHECKING:  # borrowed from TerminalUi, with which suites combine this
        def ensure_terminal(self) -> None: ...

    def leaf_count(self, node: Any = None) -> int:
        """Count the leaf panels in the active group (1 = unsplit, >1 = split)."""
        if node is None:
            node = self.driver.get_state("rootPanel")
        if not isinstance(node, dict):
            return 0
        if node.get("type") == "leaf":
            return 1
        return sum(self.leaf_count(child) for child in node.get("children", []))

    def set_sidebar_visible(self, visible: bool) -> None:
        """Bring the sidebar to the wanted visibility via the toolbar toggle.

        The ``Sidebar`` renders ``null`` while collapsed, so ``exists("sidebar")``
        is the visibility signal. The toggle lives in the terminal-view toolbar,
        so a terminal is ensured first. (Distinct from ``switch_to_*_sidebar``,
        which change the *view*, not whether the sidebar is shown.)
        """
        self.ensure_terminal()
        if self.driver.exists("sidebar") != visible:
            self.driver.click("terminal-view-toggle-sidebar")
            self.wait(
                lambda: self.driver.exists("sidebar") == visible,
                what=f"sidebar visible={visible}",
            )
