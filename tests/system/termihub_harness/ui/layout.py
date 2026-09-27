"""Split-panel and sidebar-visibility helpers (UI-port helpers, #808 → #831).

``LayoutUi`` covers the editor *layout*: counting leaf panels in a split and
toggling whether the sidebar is shown. ``set_sidebar_visible`` ensures a terminal
first (the toggle lives in the terminal-view toolbar), so suites that use it also
mix in :class:`~termihub_harness.ui.TerminalUi`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional

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

    def leaf_ids(self, node: Any = None) -> list[str]:
        """Ids of every leaf panel in the active group, in tree order."""
        if node is None:
            node = self.driver.get_state("rootPanel")
        if not isinstance(node, dict):
            return []
        if node.get("type") == "leaf":
            return [node["id"]] if node.get("id") else []
        return [pid for child in node.get("children", []) for pid in self.leaf_ids(child)]

    def panel_of_tab(self, tab_id: str, node: Any = None) -> Optional[str]:
        """Id of the leaf panel holding ``tab_id`` in the active group, or None."""
        if node is None:
            node = self.driver.get_state("rootPanel")
        if not isinstance(node, dict):
            return None
        if node.get("type") == "leaf":
            tabs = node.get("tabs") or []
            return node.get("id") if any(t.get("id") == tab_id for t in tabs) else None
        for child in node.get("children") or []:
            found = self.panel_of_tab(tab_id, child)
            if found is not None:
                return found
        return None

    def settled_root_panel(self, stable_reads: int = 4) -> dict[str, Any]:
        """The active group's panel tree once its structure has stopped changing.

        Layout ops are region-authoritative (#2283): an optimistic overlay with a
        locally minted panel/tab id is replaced by the backend's own id after the
        round-trip, so an id read the instant a split appears can be stale by the
        time the test uses it (#2705). Wait until the tree's structural signature
        (node types, ids, split direction, tab ids) is identical across
        ``stable_reads`` consecutive reads, then return it.
        """
        history: dict[str, Any] = {"prev": None, "count": 0}

        def settled() -> Optional[dict[str, Any]]:
            root = self.driver.get_state("rootPanel")
            signature = _layout_signature(root)
            if signature == history["prev"]:
                history["count"] += 1
            else:
                history["prev"], history["count"] = signature, 1
            return root if history["count"] >= stable_reads else None

        return self.wait(settled, what="the panel layout to settle")

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


def _layout_signature(node: Any) -> tuple[Any, ...]:
    """Structural fingerprint of a panel tree — ids and shape, not tab content."""
    if not isinstance(node, dict):
        return ("?",)
    if node.get("type") == "leaf":
        return ("leaf", node.get("id"), tuple(t.get("id") for t in node.get("tabs") or []))
    return (
        "split",
        node.get("id"),
        node.get("direction"),
        tuple(_layout_signature(c) for c in node.get("children") or []),
    )
