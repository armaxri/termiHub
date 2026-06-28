"""Tab-group helpers (issue #831).

``TabsUi`` walks the panel tree the app exposes via ``getState("rootPanel")`` to
enumerate, find, focus, and close tabs. Suites that assert on tab lifecycle mix
this in alongside :class:`~termihub_harness.SystemTest`.
"""

from __future__ import annotations

import time
from typing import Any, Optional

from .base import HarnessMixin
from .lookups import iter_tabs


class TabsUi(HarnessMixin):
    """Enumerate, find, switch, and close tabs across the active tab group."""

    def _all_tabs(self) -> list[dict[str, Any]]:
        """Every open tab in the active tab group (walks the panel tree)."""
        return iter_tabs(self.driver.get_state("rootPanel"))

    def tab_ids(self) -> list[str]:
        """All tab ids across every panel, in tree order."""
        return [tab["id"] for tab in self._all_tabs() if "id" in tab]

    def tab_count(self) -> int:
        """Number of open tabs across the active tab group's panels."""
        return len(self._all_tabs())

    def find_tab(self, title_substr: str) -> Optional[dict[str, Any]]:
        """Return the first tab whose title contains ``title_substr``, or None."""
        for tab in self._all_tabs():
            if title_substr in (tab.get("title") or ""):
                return tab
        return None

    def active_tab(self) -> Optional[dict[str, Any]]:
        """The focused tab in the active leaf panel, or None."""
        active_panel_id = self.driver.get_state("activePanelId")

        def find_leaf(node: Any) -> Optional[dict[str, Any]]:
            if not isinstance(node, dict):
                return None
            if node.get("type") == "leaf":
                return node if node.get("id") == active_panel_id else None
            for child in node.get("children") or []:
                found = find_leaf(child)
                if found is not None:
                    return found
            return None

        leaf = find_leaf(self.driver.get_state("rootPanel"))
        if leaf is None:
            return None
        active_tab_id = leaf.get("activeTabId")
        for tab in leaf.get("tabs") or []:
            if tab.get("id") == active_tab_id:
                return tab
        return None

    def switch_to_tab(self, tab_id: str) -> None:
        """Click the tab with the given id to make it active."""
        self.driver.click(f"tab-{tab_id}")

    def close_tab(self, tab_id: str) -> None:
        """Close the tab with the given id, confirming any close dialog.

        Two dialogs can intercept a close: the keyboard-shortcut confirm
        (``confirm-close-tab-confirm``) and the unsaved-changes dialog a dirty
        editor/connection/settings tab raises (``unsaved-changes-just-close``).
        """
        self.driver.click(f"tab-close-{tab_id}")
        time.sleep(0.3)
        if self.driver.exists("confirm-close-tab-confirm"):
            self.driver.click("confirm-close-tab-confirm")
        if self.driver.exists("unsaved-changes-just-close"):
            self.driver.click("unsaved-changes-just-close")

    def close_all_tabs(self) -> None:
        """Close every open tab (e.g. between reconnect checks)."""
        for _ in range(20):
            tabs = self._all_tabs()
            if not tabs:
                return
            self.close_tab(tabs[0]["id"])
            time.sleep(0.2)
