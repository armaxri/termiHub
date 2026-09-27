"""Open tabs, split layout and tab groups are restored after an app restart (#3693).

Automates the legacy manual MT-UI-37 (PR #586). With the Session setting
"Restore Last Session on Startup" (``restoreLastSessionMode``) at ``always``, the
suite opens two terminals in a left/right split plus a second tab group holding a
third terminal, switches back to the first group, waits until the debounced
auto-save has written all three tabs to ``last-session.json``, kills and
relaunches the app with :meth:`~termihub_harness.SystemTest.restart_app`, and
asserts both groups, the split, the active group and live shells are back.

The session is persisted on every layout change (debounced ~500 ms), not on quit,
so it survives the harness's ungraceful kill — the suite waits for the file to
hold every tab before killing rather than relying on a graceful shutdown.

Restart relaunches the class's app, so this lives in its own suite instead of
sharing ``test_split_views``' app with unrelated tests.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from termihub_harness import (
    LayoutUi,
    ProjectionHarness,
    SETTINGS_REGION,
    SystemTest,
    TabsUi,
    TerminalUi,
)
from termihub_harness.ui.lookups import iter_tabs

pytestmark = pytest.mark.integration

SPLIT_H = "terminal-view-split-horizontal"
NEW_TERMINAL = "terminal-view-new-terminal"
GROUP_ADD = "tab-group-add"
LAST_SESSION_FILE = "last-session.json"


def _count_saved_tabs(node: Any) -> int:
    """Count tab entries anywhere under ``node`` (a parsed last-session document)."""
    if isinstance(node, dict):
        own = len(node["tabs"]) if isinstance(node.get("tabs"), list) else 0
        return own + sum(_count_saved_tabs(v) for k, v in node.items() if k != "tabs")
    if isinstance(node, list):
        return sum(_count_saved_tabs(v) for v in node)
    return 0


def _terminals(root: Any) -> list[dict[str, Any]]:
    return [t for t in iter_tabs(root) if t.get("contentType") == "terminal"]


class TestSessionRestoreUi(ProjectionHarness, TerminalUi, TabsUi, LayoutUi, SystemTest):
    def _restore_mode(self) -> Any:
        return self.projection_region_cache(SETTINGS_REGION).get("restoreLastSessionMode")

    def _set_restore_mode(self, mode: str) -> None:
        self.projection_dispatch_intent(
            "settings.patch", {"patch": {"restoreLastSessionMode": mode}}
        )
        self.wait(lambda: self._restore_mode() == mode, what=f"restore mode {mode!r}")

    def _saved_tab_count(self) -> int:
        path = self.config_dir / LAST_SESSION_FILE
        try:
            return _count_saved_tabs(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            return 0

    def _groups(self) -> list[dict[str, Any]]:
        groups = self.driver.get_state("tabGroups")
        return groups if isinstance(groups, list) else []

    def _active_group_index(self) -> int:
        active = self.driver.get_state("activeTabGroupId")
        return next((i for i, g in enumerate(self._groups()) if g.get("id") == active), -1)

    def _build_session(self) -> None:
        """Group 1: two terminals in a left/right split. Group 2: one terminal.
        Group 1 is left active."""
        self.close_all_tabs()
        self.ensure_terminal()
        self.wait(lambda: self.leaf_count() == 1, what="a single panel")
        self.driver.click(SPLIT_H)
        self.wait(lambda: self.leaf_count() == 2, what="a second panel")
        # The split's new panel is empty and focused — give it a terminal.
        self.driver.click(NEW_TERMINAL)
        self.wait(lambda: len(_terminals(self.driver.get_state("rootPanel"))) == 2,
                  what="two terminal tabs in the split")

        origin = self.driver.get_state("activeTabGroupId")
        self.driver.click(GROUP_ADD)
        self.wait(lambda: self.driver.get_state("activeTabGroupId") != origin,
                  what="the second tab group to become active")
        self.driver.click(NEW_TERMINAL)
        self.wait(lambda: len(_terminals(self.driver.get_state("rootPanel"))) == 1,
                  what="a terminal in the second group")
        self.driver.click(f"tab-group-chip-{origin}")
        self.wait(lambda: self.driver.get_state("activeTabGroupId") == origin,
                  what="the first tab group to be active again")

    def test_tabs_split_and_groups_are_restored_after_restart(self):
        previous_mode = self._restore_mode()
        self._set_restore_mode("always")
        try:
            self._build_session()
            before = self.settled_root_panel()
            assert before.get("type") == "split"
            direction = before.get("direction")
            assert len(self._groups()) == 2 and self._active_group_index() == 0

            # Persisted on layout change, not on quit: wait for the file to hold
            # every tab so the ungraceful kill below cannot race the save.
            self.wait(lambda: self._saved_tab_count() == 3, what="the session to be saved")

            self.restart_app()

            self.wait(lambda: len(self._groups()) == 2, what="both tab groups restored")
            self.wait(lambda: self._active_group_index() == 0,
                      what="the first group to be active again")
            self.wait(lambda: self.leaf_count() == 2, what="the split to be restored")
            after = self.settled_root_panel()
            assert after.get("type") == "split"
            assert after.get("direction") == direction
            # One terminal per panel of the active group, as before the restart.
            terminals = _terminals(after)
            assert len(terminals) == 2
            for leaf_id in self.leaf_ids(after):
                assert any(self.panel_of_tab(t["id"], after) == leaf_id for t in terminals)
            # The second group holds its terminal again.
            assert len(_terminals(self._groups()[1].get("rootPanel"))) == 1
            # Each restored terminal of the active group reconnects to a live shell.
            self.wait(
                lambda: all(self.driver.read_terminal(t["id"]).strip() for t in terminals),
                what="the restored terminals to reconnect",
            )
            self.delay4user(2, reason="tabs, split and groups restored after restart")
        finally:
            self.close_all_tabs()
            if isinstance(previous_mode, str) and previous_mode != self._restore_mode():
                self._set_restore_mode(previous_mode)
