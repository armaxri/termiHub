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

All seven layout ops are now driven here as **real drag gestures over the
bridge**: **split** and **merge** (toolbar buttons), **group-switch** (create
group + switch back), and the four drag ops — **drag-to-edge**, **drag-to-center**,
**cross-panel move**, and **tab-move-across-groups** — via ``drag_to`` onto the
``PanelDropZone`` overlays (``panel-drop-edge-<panelId>-<edge>`` /
``panel-drop-center-<panelId>``, #2583), a sibling panel's tab, and a tab-group
chip respectively. The zones mount only while a drag is active, so ``drag_to``
presses and wakes the sensor first, then resolves the now-mounted target (see
``docs/test-bridge.md``). Each op asserts the moved terminal's live scrollback
survives, so the render-path guarantee is confirmed end-to-end, not just per-op in
the headless component suite above.
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
        # Poll until the buffer settles rather than grabbing it once: right after a
        # layout op the marker can be captured mid-render, fragmented across a
        # prompt/hostname redraw (`echo SC` / `ROLLBACK_MERGE_...` on separate lines),
        # so the contiguous substring isn't present yet — a capture-timing race, not a
        # scrollback loss (#2657). ``wait_for_output`` re-reads the same live buffer
        # until the full marker appears (bounded timeout). Re-read + assert on timeout
        # so a genuine loss still fails with the clear per-op message.
        try:
            self.wait_for_output(marker, tab_id=term_id)
        except AssertionError:
            buf = self.driver.read_terminal(term_id)
            assert marker in buf, f"{op} must preserve the live scrollback ({marker!r} lost)"

    def _panel_of_tab(self, tab_id: str, node=None):
        """The id of the leaf panel holding ``tab_id`` in the active group, or None."""
        if node is None:
            node = self.driver.get_state("rootPanel")
        if not isinstance(node, dict):
            return None
        if node.get("type") == "leaf":
            if any(t.get("id") == tab_id for t in node.get("tabs") or []):
                return node.get("id")
            return None
        for child in node.get("children") or []:
            found = self._panel_of_tab(tab_id, child)
            if found is not None:
                return found
        return None

    def _empty_leaves(self, node, out=None):
        """Ids of every empty (tab-less) leaf panel in ``node`` (active group)."""
        if out is None:
            out = []
        if not isinstance(node, dict):
            return out
        if node.get("type") == "leaf":
            if not (node.get("tabs") or []):
                out.append(node.get("id"))
            return out
        for child in node.get("children") or []:
            self._empty_leaves(child, out)
        return out

    def _layout_signature(self, node):
        """A structural fingerprint of a panel tree: node types, **panel ids**,
        split direction, and tab **ids** — deliberately excluding volatile tab
        content (title/cwd/session status) so the signature changes iff the tree
        *structure or ids* change. Used to detect a settled layout without tripping
        on a live terminal's incidental title/cwd churn."""
        if not isinstance(node, dict):
            return ("?",)
        if node.get("type") == "leaf":
            return ("leaf", node.get("id"), tuple(t.get("id") for t in node.get("tabs") or []))
        return (
            "split",
            node.get("id"),
            node.get("direction"),
            tuple(self._layout_signature(c) for c in node.get("children") or []),
        )

    def _settled_split_target(self, source_panel: str) -> str:
        """The **authoritative** id of the empty panel a split stood up next to
        ``source_panel``, read only once the layout has settled.

        ``splitPanel`` is a region-authoritative op (#2283): it first installs an
        *optimistic overlay* carrying a locally-minted panel id, then the Rust
        layout region confirms the split with **its own** freshly-minted id
        (``core::layout::panel_tree::generate_panel_id``), which replaces the
        overlay id in ``rootPanel``/``activePanelId`` after the round-trip. So the
        new panel's id briefly churns (optimistic -> authoritative). Reading
        ``activePanelId`` the instant ``leaf_count()==2`` is satisfied — which the
        optimistic overlay alone satisfies — captures the *transient* id; the
        drop-zone overlay that later mounts carries the *authoritative* id, so a
        pre-captured ``panel-drop-center-<staleId>`` never resolves. That is the
        deterministic Windows failure of ``test_drag_to_center`` (#2705): the
        slower region round-trip there means the read reliably lands in the
        optimistic window, so ``drag_to`` aborts with ``no element ... panel-drop-
        center-<staleId>`` (never reaching the scrollback assertion — the resize
        path is healthy; #2697/#2702 already prevent degenerate fits).

        Wait until the active group's tree is byte-stable across consecutive reads
        (the id churn is a single optimistic->authoritative transition, so the tree
        stops changing once the authoritative view lands), then return the sole
        empty non-source leaf's now-stable id.
        """
        stable_reads = 4
        history: dict[str, object] = {"prev": None, "count": 0}

        def settled():
            root = self.driver.get_state("rootPanel")
            signature = self._layout_signature(root)
            if signature == history["prev"]:
                history["count"] = int(history["count"]) + 1
            else:
                history["prev"] = signature
                history["count"] = 1
            if int(history["count"]) < stable_reads:
                return None
            empties = [pid for pid in self._empty_leaves(root) if pid and pid != source_panel]
            return empties[0] if len(empties) == 1 else None

        return self.wait(settled, what="the split's target panel id to settle")

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

    def test_drag_to_edge_preserves_scrollback(self):
        marker = "SCROLLBACK_EDGE_2583"
        term_id = self._fresh_terminal_with_marker(marker)

        # A lone tab hides its own panel's edge zones (dragging it out would leave
        # the panel empty), so open a second tab in the panel first — now the
        # edge overlays render and the marked tab can be split off to its own panel.
        self.open_new_terminal()
        self.wait(lambda: self.tab_count() == 2, what="a second tab in the panel")
        panel_id = self._panel_of_tab(term_id)
        assert panel_id, "the marked terminal must be in a leaf panel"

        # Drag the marked tab onto the panel's right edge → a new horizontal split
        # with the tab in its own panel.
        self.driver.drag_to(f"tab-{term_id}", f"panel-drop-edge-{panel_id}-right")
        self.wait(lambda: self.leaf_count() == 2, what="the tab split into its own panel")

        self._assert_scrollback_survived(term_id, marker, "drag-to-edge")
        self.close_all_tabs()

    def test_drag_to_center_preserves_scrollback(self):
        marker = "SCROLLBACK_CENTER_2583"
        term_id = self._fresh_terminal_with_marker(marker)
        source_panel = self._panel_of_tab(term_id)
        assert source_panel, "the marked terminal must be in a leaf panel"

        # Split to stand up a second (empty, focused) panel to drop the tab into.
        self.driver.click(SPLIT_H)
        self.wait(lambda: self.leaf_count() == 2, what="a second panel")
        # Read the target panel id only once the split has settled to its
        # authoritative form — the new panel's id churns optimistic->authoritative
        # and the transient id has no drop zone by drag time (#2705).
        target_panel = self._settled_split_target(source_panel)
        assert target_panel and target_panel != source_panel

        # Drag the marked tab onto the empty panel's center → it joins that panel's
        # stack; the now-empty source panel collapses.
        self.driver.drag_to(f"tab-{term_id}", f"panel-drop-center-{target_panel}")
        self.wait(
            lambda: self._panel_of_tab(term_id) not in (None, source_panel),
            what="the terminal to move into the target panel",
        )

        self._assert_scrollback_survived(term_id, marker, "drag-to-center")
        self.close_all_tabs()

    def test_cross_panel_move_preserves_scrollback(self):
        marker = "SCROLLBACK_CROSS_2583"
        term_id = self._fresh_terminal_with_marker(marker)

        # Two tabs in one panel, then split the *other* tab off to its own panel so
        # the two terminals live in separate panels.
        self.open_new_terminal()
        self.wait(lambda: self.tab_count() == 2, what="two tabs in one panel")
        other_id = next(t for t in self.tab_ids() if t != term_id)
        source_panel = self._panel_of_tab(term_id)
        assert source_panel

        self.driver.drag_to(f"tab-{other_id}", f"panel-drop-edge-{source_panel}-right")
        self.wait(lambda: self.leaf_count() == 2, what="two panels")
        self.wait(
            lambda: self._panel_of_tab(other_id) not in (None, source_panel),
            what="the other tab in its own panel",
        )

        # Cross-panel move: drop the marked tab onto the other panel's tab.
        self.driver.drag_to(f"tab-{term_id}", f"tab-{other_id}")
        self.wait(
            lambda: self._panel_of_tab(term_id) is not None
            and self._panel_of_tab(term_id) == self._panel_of_tab(other_id),
            what="the marked terminal to join the other panel",
        )

        self._assert_scrollback_survived(term_id, marker, "cross-panel move")
        self.close_all_tabs()

    def test_tab_move_across_groups_preserves_scrollback(self):
        marker = "SCROLLBACK_XGROUP_2583"
        term_id = self._fresh_terminal_with_marker(marker)
        origin_group = self.driver.get_state("activeTabGroupId")

        # Create a second group (becomes active), capture its id, then switch back
        # so the origin group (holding the terminal) is active again.
        self.driver.click(GROUP_ADD)
        self.wait(
            lambda: self.driver.get_state("activeTabGroupId") != origin_group,
            what="the new tab group to become active",
        )
        target_group = self.driver.get_state("activeTabGroupId")
        self.driver.click(f"tab-group-chip-{origin_group}")
        self.wait(
            lambda: self.driver.get_state("activeTabGroupId") == origin_group,
            what="the origin tab group to be active again",
        )

        # Drag the terminal's tab onto the other group's chip → it moves into that
        # group (a drop outside any panel droppable, resolved via the chip).
        self.driver.drag_to(f"tab-{term_id}", f"tab-group-chip-{target_group}")
        self.wait(
            lambda: term_id not in self.tab_ids(),
            what="the tab to leave the origin group",
        )

        # Switch to the target group; the same live terminal must be there.
        self.driver.click(f"tab-group-chip-{target_group}")
        self.wait(
            lambda: self.driver.get_state("activeTabGroupId") == target_group,
            what="the target tab group to be active",
        )

        self._assert_scrollback_survived(term_id, marker, "tab-move-across-groups")
        self.close_all_tabs()
