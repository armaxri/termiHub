"""Product run: the terminal toolbar keeps layout icons; the rest is in "…" (#5756).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). Maintainer decision 2026-11-13 (Q9): the toolbar above the
tab bar keeps its layout icons visible (new terminal, split right, split down,
close panel, sidebar), and broadcast, session logging, macro record and macro
play move into one "…" overflow menu. Every icon's tooltip names its keyboard
shortcut from the keybinding registry, and every bound menu row shows its
shortcut right-aligned.

The grade opens one local terminal and reads the toolbar: the inline icon
count, each layout icon's label (the tooltip text, which carries the shortcut),
then opens the "…" menu and checks the moved actions are rows of it and that
the broadcast row (bound by default on every platform) shows its shortcut.
No sshd: a local shell is enough.
"""

from __future__ import annotations

import re
from typing import Any

import pytest

from termihub_harness import LayoutUi, SidebarUi, SystemTest, TabsUi, TerminalUi
from termihub_harness.product_run import ProductRunUi

pytestmark = [pytest.mark.product_run, pytest.mark.integration]

ACTIONS = "terminal-view-toolbar-actions"
MORE = "terminal-view-more-actions"
MENU = "terminal-view-more-menu"
#: The layout icons that stay inline with one panel open ("close panel" only
#: renders with two or more panels), followed by the "…" trigger.
INLINE_ICONS = (
    "terminal-view-new-terminal",
    "terminal-view-split-horizontal",
    "terminal-view-split-vertical",
    "terminal-view-toggle-sidebar",
    MORE,
)
#: Inline icons whose action has a default binding on every platform.
BOUND_ICONS = (
    "terminal-view-new-terminal",
    "terminal-view-split-horizontal",
    "terminal-view-split-vertical",
    "terminal-view-toggle-sidebar",
)
#: The actions that moved into the "…" menu.
MENU_ACTIONS = (
    "terminal-view-broadcast",
    "terminal-view-toggle-logging",
    "terminal-view-record-macro",
    "terminal-view-play-macro",
)
#: An accelerator as the keybinding registry formats it, e.g. "(Cmd+Shift+B)",
#: "(Alt+Shift+D)" or "(F9)".
SHORTCUT_SUFFIX = re.compile(r"\((?:[A-Z][a-z]*\+)*[^()\s]+\)$")
SHORTCUT = re.compile(r"(?:Cmd|Ctrl|Alt|Option|Shift)\+\S+")


def _shown(item: dict[str, Any]) -> bool:
    """Rendered and bigger than a screen-reader-only 1 px box."""
    return bool(item["visible"]) and item["rect"]["width"] > 2 and item["rect"]["height"] > 2


class TestProductRunTabbarToolbar(
    ProductRunUi, LayoutUi, TerminalUi, TabsUi, SidebarUi, SystemTest
):
    phase = "Terminal toolbar"
    request_timeout = 90.0

    def _inline_buttons(self) -> list[dict[str, Any]]:
        items = self.driver.measure_element(ACTIONS, "buttons")["items"]
        return [i for i in items if _shown(i)]

    def test_10_layout_icons_stay_visible_with_shortcuts(self):
        with self.step(
            "toolbar.layout-icons",
            "The toolbar shows only the layout icons and '…'; each tooltip names its shortcut",
            expect="#5756: above the tab bar, from left to right: new terminal, split right, "
            "split down, sidebar toggle, then '…'. No broadcast, record or play icon is inline",
        ):
            self.ensure_terminal()
            buttons = self._inline_buttons()
            ids = [b["testId"] for b in buttons]
            labels = {b["testId"]: b["label"] or "" for b in buttons}
            self.evidence(f"inline toolbar buttons: {ids}")
            self.evidence(f"labels: {labels}")
            assert ids == list(INLINE_ICONS), f"inline icons are {ids}, want {list(INLINE_ICONS)}"
            missing = [i for i in BOUND_ICONS if not SHORTCUT_SUFFIX.search(labels.get(i, ""))]
            assert not missing, f"tooltips without a shortcut: {[labels.get(i) for i in missing]}"

    def test_20_menu_holds_the_moved_actions(self):
        with self.step(
            "toolbar.more-menu",
            "The '…' menu lists broadcast, logging, record and play, with the broadcast shortcut",
            expect="#5756: the open '…' menu sits inside the window under its button and lists "
            "'Broadcast input…' (its shortcut right-aligned), 'Log session output', "
            "'Record macro' and 'Play macro…'",
        ):
            self.ensure_terminal()
            self.driver.click(MORE)
            try:
                self.wait(lambda: self.driver.exists(MENU), what="the '…' menu")
                texts = {
                    a: self.driver.get_text(a) if self.driver.exists(a) else None
                    for a in MENU_ACTIONS
                }
                self.evidence(f"menu rows: {texts}")
                menu = self.driver.measure_element(MENU)["rect"]
                width = float(self.driver.os_input_probe()["innerWidth"])
                self.evidence(f"menu x={menu['x']:.0f} w={menu['width']:.0f}, window {width:.0f}px")
                self.shot(label="menu-open")
            finally:
                if self.driver.exists(MENU):
                    self.driver.press_key("Escape")
            missing = [a for a, t in texts.items() if t is None]
            assert not missing, f"not in the '…' menu: {missing}"
            assert SHORTCUT.search(texts["terminal-view-broadcast"] or ""), (
                f"broadcast row shows no shortcut: {texts['terminal-view-broadcast']!r}"
            )
            assert menu["x"] >= 0 and menu["x"] + menu["width"] <= width + 0.5, (
                "the '…' menu reaches outside the window"
            )
