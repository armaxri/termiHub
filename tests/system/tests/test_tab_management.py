"""Tab create / activate / close / rename / color / reorder.

Ported from ``tests/e2e/tab-management.test.js`` onto the Python bridge harness
(#808). Uses the ``contextMenu`` (Radix context menus), ``pressKey`` (dismiss),
and ``dragTo`` (@dnd-kit reorder) verbs; tab identity/order/color are asserted
from ``rootPanel`` and ``tabColors`` state rather than DOM scraping.

Not ported (kept as manual tests in docs/testing.md): the context-menu item
Y-coordinate ordering checks, which assert pixel geometry.
"""

import pytest

from termihub_harness import SystemTest, TabsUi, TerminalUi

pytestmark = pytest.mark.integration

NEW = "terminal-view-new-terminal"


class TestTabManagement(TerminalUi, TabsUi, SystemTest):
    def _reset(self) -> None:
        self.close_all_tabs()
        self.ensure_terminal()

    def test_new_terminal_adds_an_active_tab(self):
        self._reset()
        before = self.tab_ids()
        self.driver.click(NEW)
        self.wait(lambda: len(self.tab_ids()) == len(before) + 1, what="a new tab")
        added = [t for t in self.tab_ids() if t not in before]
        assert len(added) == 1
        assert self.driver.get_state("rootPanel.activeTabId") == added[0]

    def test_closing_a_tab_removes_it(self):
        self._reset()
        self.driver.click(NEW)
        self.wait(lambda: len(self.tab_ids()) >= 2, what="a second tab")
        target = self.tab_ids()[-1]
        self.close_tab(target)
        self.wait(lambda: target not in self.tab_ids(), what="the tab to close")

    def test_closing_a_live_session_tab_dismisses_confirm_dialog(self):
        # Regression for #1654: a tab holding a live terminal session raises
        # ConfirmSessionCloseDialog on close (``confirmCloseLiveSession`` defaults
        # on). ``close_tab`` must dismiss it, otherwise the tab never closes and
        # ``close_all_tabs`` loops re-clicking the X against a stuck dialog.
        self._reset()
        self.driver.click(NEW)
        self.wait(lambda: len(self.tab_ids()) >= 2, what="a second live-session tab")
        target = self.tab_ids()[-1]
        self.close_tab(target)
        self.wait(lambda: target not in self.tab_ids(), what="the live-session tab to close")
        assert not self.driver.exists(
            "confirm-session-close-dialog"
        ), "the live-session confirm dialog must be dismissed, not left blocking the close"

    def test_right_click_opens_the_tab_context_menu(self):
        self._reset()
        tab = self.tab_ids()[0]
        self.driver.context_menu(f"tab-{tab}")
        self.wait(lambda: self.driver.exists("tab-context-rename"), what="the tab context menu")
        assert self.driver.exists("tab-context-save")
        assert self.driver.exists("tab-context-set-color")
        self.driver.press_key("Escape")

    def test_rename_tab_via_context_menu(self):
        self._reset()
        tab = self.tab_ids()[0]
        self.driver.context_menu(f"tab-{tab}")
        self.wait(lambda: self.driver.exists("tab-context-rename"), what="the rename item")
        self.driver.click("tab-context-rename")
        self.wait(lambda: self.driver.exists("rename-dialog-input"), what="the rename dialog")
        self.driver.type("rename-dialog-input", "Renamed Tab")
        self.driver.click("rename-dialog-apply")
        self.wait(lambda: self.find_tab("Renamed Tab") is not None, what="the renamed tab")

    def test_set_tab_color_via_context_menu(self):
        self._reset()
        tab = self.tab_ids()[0]
        self.driver.context_menu(f"tab-{tab}")
        self.wait(lambda: self.driver.exists("tab-context-set-color"), what="the set-color item")
        self.driver.click("tab-context-set-color")
        self.wait(lambda: self.driver.exists("color-picker-apply"), what="the color picker")

        if self.driver.exists("color-picker-swatch-ef4444"):
            self.driver.click("color-picker-swatch-ef4444")
        else:
            self.driver.type("color-picker-hex-input", "#ef4444")
        self.driver.click("color-picker-apply")

        self.wait(lambda: self.driver.get_state(f"tabColors.{tab}"), what="the tab color to be set")
        assert "border-left" in (self.driver.get_attribute(f"tab-{tab}", "style") or "")
        self.delay4user(2, reason="tab colored")

    def test_reorder_tabs_by_dragging(self):
        # @dnd-kit reorder: ``drag_to`` wakes the PointerSensor past its activation
        # distance and yields frames so dnd-kit measures droppables and resolves a
        # drop target (#832). Order is asserted from ``rootPanel`` state.
        self._reset()
        self.driver.click(NEW)
        self.driver.click(NEW)
        self.wait(lambda: len(self.tab_ids()) >= 3, what="three tabs")
        order = self.tab_ids()
        self.driver.drag_to(f"tab-{order[-1]}", f"tab-{order[0]}")
        self.wait(lambda: self.tab_ids() != order, what="the tab order to change")
        self.close_all_tabs()
