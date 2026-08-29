"""Automated layout GUI-smoke grade: a structural layout op preserves the live
terminal scrollback (#2561).

This is the real-app, end-to-end half of the #2561 "layout GUI-smoke matrix"
grade that used to require a foreground display. It drives real layout ops in the
running desktop app over the test bridge and asserts on the **live terminal
buffer** read back through the registry (``read_terminal`` → ``getTerminalContent``,
i.e. the reconstructed xterm scrollback, never pixels) — the render path that was
the one thing still display-only after the stateless-UI inversion.

Why this can run unattended (no display gate): after the inversion the scrollback
lives only in the tab-id-keyed xterm; ``TerminalHost`` mounts one
``<Terminal key={tab.id}>`` spanning every tab group, and ``SplitView`` only
reparents that DOM element. So a structural op cannot lose scrollback unless it
remounts the terminal — an outcome this suite detects by reading the same live
buffer back after the op. The deterministic per-op keying proof runs headless in
per-PR CI as ``src/components/Terminal/TerminalView.layout-scrollback.test.tsx``;
this suite is the nightly real-app confirmation over the bridge and stays on the
``-m integration`` lane because it needs the built app.

Ops covered here via proven UI verbs: **split**, **merge** (close panel), and
**group-switch** (create group + switch back). Drag-to-edge / drag-to-center /
cross-panel move / tab-move-across-groups funnel through the identical tab-id
keyed render path and are proven per-op by the headless component suite above
(their drop-zone drag gestures have no stable testid to drive here).
"""

from __future__ import annotations

import pytest

from termihub_harness import LayoutUi, SystemTest, TabsUi, TerminalUi

pytestmark = pytest.mark.integration

SPLIT_H = "terminal-view-split-horizontal"
NEW_TERMINAL = "terminal-view-new-terminal"
CLOSE_PANEL = "terminal-view-close-panel"
GROUP_ADD = "tab-group-add"


class TestLayoutScrollbackUi(TerminalUi, TabsUi, LayoutUi, SystemTest):
    def _fresh_terminal_with_marker(self, marker: str) -> str:
        """Open a single terminal, print ``marker`` into its scrollback, return
        its tab id (the survival probe target)."""
        self.close_all_tabs()
        self.ensure_terminal()
        self.wait(lambda: self.leaf_count() == 1, what="a single panel")
        term_id = self.tab_ids()[0]
        self.switch_to_tab(term_id)
        self.run_command(f"echo {marker}")
        self.wait_for_output(marker, tab_id=term_id)
        return term_id

    def _assert_scrollback_survived(self, term_id: str, marker: str, op: str) -> None:
        """The same live terminal still holds ``marker`` in its buffer after ``op``."""
        assert term_id in self.tab_ids(), f"{op} must not replace the terminal tab (no remount)"
        buf = self.driver.read_terminal(term_id)
        assert marker in buf, f"{op} must preserve the live scrollback ({marker!r} lost)"

    def test_split_preserves_scrollback(self):
        marker = "SCROLLBACK_SPLIT_2561"
        term_id = self._fresh_terminal_with_marker(marker)

        self.driver.click(SPLIT_H)
        self.wait(lambda: self.leaf_count() == 2, what="a second panel")

        self._assert_scrollback_survived(term_id, marker, "split")
        self.close_all_tabs()

    def test_merge_preserves_scrollback(self):
        marker = "SCROLLBACK_MERGE_2561"
        term_id = self._fresh_terminal_with_marker(marker)

        # Split creates a new empty, focused panel; closing it merges back to one.
        self.driver.click(SPLIT_H)
        self.wait(lambda: self.leaf_count() == 2, what="a second panel")
        assert self.driver.exists(CLOSE_PANEL)
        self.driver.click(CLOSE_PANEL)
        self.wait(lambda: self.leaf_count() == 1, what="back to a single panel")

        self._assert_scrollback_survived(term_id, marker, "merge")
        self.close_all_tabs()

    def test_group_switch_preserves_scrollback(self):
        marker = "SCROLLBACK_GROUP_2561"
        term_id = self._fresh_terminal_with_marker(marker)
        origin_group = self.driver.get_state("activeTabGroupId")

        # Add a new (empty) tab group — this switches the active group to it, so
        # the terminal is now in the inactive origin group (still mounted).
        self.driver.click(GROUP_ADD)
        self.wait(
            lambda: self.driver.get_state("activeTabGroupId") != origin_group,
            what="the new tab group to become active",
        )

        # Switch back to the origin group; the terminal must be the same live one.
        self.driver.click(f"tab-group-chip-{origin_group}")
        self.wait(
            lambda: self.driver.get_state("activeTabGroupId") == origin_group,
            what="the origin tab group to be active again",
        )

        self._assert_scrollback_survived(term_id, marker, "group-switch")
        self.close_all_tabs()
