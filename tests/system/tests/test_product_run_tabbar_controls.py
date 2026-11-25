"""Product run: one "+", distinct layout icons, visible toggle state (#5849).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261123T215628Z`` found two "+" side by side on the toolbar, the tab-group
strip's next to a lone "Main" pill and the new-terminal one (R-023); four
look-alike outline glyphs for new terminal, split right, split down and the
sidebar toggle (R-067); and no on/off state on the "…" menu's logging and
record rows (R-066).

Now a single tab group shows no chip and its add control reads "New tab group"
with a stack glyph; the split icons are split-square glyphs and the sidebar
toggle sits behind a divider with ``aria-pressed``; logging and recording are
checkbox rows with a tick. ``test_product_run_tabbar_toolbar.py`` (#5756) still
grades the icon order and the menu's contents; this file grades the controls'
look and state.

The grade opens one local terminal; no servers needed. It starts and stops a
recording with nothing typed (no automation is saved) and never starts
session logging, which would write a file.

The ``test_grade_*`` functions grade fixed readings without an app and run in
the normal lane.
"""

from __future__ import annotations

from typing import Any, Optional

import pytest

from termihub_harness import LayoutUi, SidebarUi, SystemTest, TabsUi, TerminalUi
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.tabbar_controls import (
    LAYOUT_CONTROLS,
    TOGGLE_ROWS,
    layout_icon_problems,
    menu_toggle_problems,
    plus_problems,
    sidebar_toggle_problems,
)

ACTIONS = "terminal-view-toolbar-actions"
GROUP_STRIP = "tab-group-chips"
GROUP_ADD = "tab-group-add"
SIDEBAR = "terminal-view-toggle-sidebar"
SIDEBAR_SEPARATOR = "terminal-view-toolbar-sidebar-separator"
SPLIT_DOWN = "terminal-view-split-vertical"
MORE = "terminal-view-more-actions"
MENU = "terminal-view-more-menu"
RECORD = "terminal-view-record"
RECORDING_CHIP = "terminal-view-active-recording"

#: The shipped toolbar, as the live run reads it with one tab group.
SHIPPED_ICONS = {
    "terminal-view-new-terminal": "plus",
    "terminal-view-split-horizontal": "split-right",
    "terminal-view-split-vertical": "split-down",
    "terminal-view-toggle-sidebar": "sidebar",
    GROUP_ADD: "tab-group",
}


def _rows(checked: str, role: str = "menuitemcheckbox") -> dict[str, dict[str, Optional[str]]]:
    return {
        "terminal-view-toggle-logging": {
            "role": role,
            "checked": checked,
            "text": "Log session output",
        },
        "terminal-view-record": {"role": role, "checked": checked, "text": "Record automation"},
    }


# ── app-free grade tests ──────────────────────────────────────────────────
def test_grade_shipped_toolbar_has_one_plus():
    assert plus_problems(SHIPPED_ICONS, [], 1, "New tab group") == []


def test_grade_two_pluses_fail():
    # The R-023 shape: the tab-group "+" beside a lone "Main" chip.
    icons = {**SHIPPED_ICONS, GROUP_ADD: "plus"}
    problems = plus_problems(icons, ["tab-group-chip-main"], 1, "")
    assert any("'+' controls" in p for p in problems)
    assert any("one tab group, yet its chip shows" in p for p in problems)


def test_grade_unlabelled_group_control_fails_with_no_chip():
    problems = plus_problems(SHIPPED_ICONS, [], 1, "")
    assert any("want 'New tab group'" in p for p in problems)


def test_grade_several_groups_show_their_chips():
    assert plus_problems(SHIPPED_ICONS, ["tab-group-chip-a", "tab-group-chip-b"], 2, "") == []
    problems = plus_problems(SHIPPED_ICONS, ["tab-group-chip-a"], 2, "")
    assert any("2 tab groups but 1 chips" in p for p in problems)


def test_grade_distinct_separated_layout_icons_pass():
    assert layout_icon_problems(SHIPPED_ICONS, sidebar_separated=True) == []


def test_grade_look_alike_or_unseparated_icons_fail():
    # The R-067 shape: split right and the sidebar toggle share a panel glyph.
    icons = {**SHIPPED_ICONS, "terminal-view-split-horizontal": "sidebar"}
    problems = layout_icon_problems(icons, sidebar_separated=False)
    assert any("same glyph" in p for p in problems)
    assert any("no divider" in p for p in problems)
    missing = layout_icon_problems({}, sidebar_separated=True)
    assert any("without a glyph tag" in p for p in missing)


def test_grade_sidebar_toggle_reports_its_state():
    assert sidebar_toggle_problems("true", sidebar_shown=True) == []
    assert sidebar_toggle_problems("false", sidebar_shown=False) == []
    assert sidebar_toggle_problems(None, sidebar_shown=True)
    assert sidebar_toggle_problems("true", sidebar_shown=False)


def test_grade_menu_checkbox_rows_pass():
    off = {r: False for r in TOGGLE_ROWS}
    assert menu_toggle_problems(_rows("false"), off) == []
    on = {r: True for r in TOGGLE_ROWS}
    assert menu_toggle_problems(_rows("true"), on) == []


def test_grade_stateless_menu_rows_fail():
    # The R-066 shape: plain rows with no checked state.
    problems = menu_toggle_problems(_rows(None, role="menuitem"), {RECORD: True})
    assert any("not a checkbox row" in p for p in problems)
    assert any("aria-checked=None, want 'true'" in p for p in problems)
    assert any("is not in the menu" in p for p in menu_toggle_problems({}, {}))


def test_grade_layout_controls_cover_the_inline_icons():
    assert set(LAYOUT_CONTROLS) <= set(SHIPPED_ICONS)


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunTabbarControls(
    ProductRunUi, LayoutUi, TerminalUi, TabsUi, SidebarUi, SystemTest
):
    phase = "Terminal toolbar"
    request_timeout = 90.0

    def _visible_buttons(self, test_id: str) -> list[dict[str, Any]]:
        items = self.driver.measure_element(test_id, "buttons")["items"]
        return [i for i in items if i["visible"] and i["testId"]]

    def _icons(self) -> dict[str, Optional[str]]:
        ids = [b["testId"] for b in self._visible_buttons(ACTIONS)] + [GROUP_ADD]
        return {tid: self.driver.get_attribute(tid, "data-icon") for tid in ids}

    def _sidebar_separated(self) -> bool:
        if not self.driver.exists(SIDEBAR_SEPARATOR):
            return False
        split = self.driver.measure_element(SPLIT_DOWN)["rect"]
        sep = self.driver.measure_element(SIDEBAR_SEPARATOR)["rect"]
        sidebar = self.driver.measure_element(SIDEBAR)["rect"]
        return split["x"] + split["width"] <= sep["x"] <= sidebar["x"]

    def _menu_rows(self) -> dict[str, dict[str, Optional[str]]]:
        self.driver.click(MORE)
        try:
            self.wait(lambda: self.driver.exists(MENU), what="the '…' menu")
            return {
                row: {
                    "role": self.driver.get_attribute(row, "role"),
                    "checked": self.driver.get_attribute(row, "aria-checked"),
                    "text": self.driver.get_text(row),
                }
                for row in TOGGLE_ROWS
                if self.driver.exists(row)
            }
        finally:
            if self.driver.exists(MENU):
                self.driver.press_key("Escape")

    def test_10_one_plus_on_the_toolbar(self):
        with self.step(
            "toolbar.one-plus",
            "With one tab group the toolbar shows one '+' (new terminal) and a "
            "'New tab group' control instead of a 'Main' pill with its own '+'",
            expect="#5849 (R-023): no 'Main' pill; left of the toolbar a stack icon reading "
            "'New tab group'; the only '+' is new terminal, right of it",
        ):
            self.ensure_terminal()
            groups = self.driver.get_state("tabGroups") or []
            chips = [
                b["testId"]
                for b in self._visible_buttons(GROUP_STRIP)
                if b["testId"].startswith("tab-group-chip-")
            ]
            icons = self._icons()
            add_text = self.driver.get_text(GROUP_ADD) or ""
            self.shot(label="one-plus")
            self.evidence(f"{len(groups)} tab group(s), chips {chips}; icons {icons}")
            self.evidence(f"tab-group control text {add_text!r}")
            problems = plus_problems(icons, chips, len(groups), add_text)
            assert not problems, problems

    def test_20_layout_icons_are_distinct(self):
        with self.step(
            "toolbar.layout-icons.distinct",
            "New terminal, split right, split down and the sidebar toggle draw four "
            "different glyphs, and a divider sets the sidebar toggle apart",
            expect="#5849 (R-067): '+', two split-square glyphs (a vertical and a horizontal "
            "split), a divider, then the panel-left sidebar icon",
        ):
            self.ensure_terminal()
            icons = self._icons()
            separated = self._sidebar_separated()
            self.shot(label="layout-icons")
            self.evidence(f"icons {icons}; sidebar separated: {separated}")
            problems = layout_icon_problems(icons, separated)
            assert not problems, problems

    def test_30_sidebar_toggle_shows_its_state(self):
        with self.step(
            "toolbar.sidebar-pressed",
            "The sidebar toggle reports pressed while the sidebar shows, and not "
            "pressed once it is hidden",
            expect="#5849: the sidebar icon sits on a filled background while the sidebar is "
            "open; hiding the sidebar clears the fill",
        ):
            self.ensure_terminal()
            problems: list[str] = []
            readings: list[str] = []
            for _ in range(2):
                shown = not self.driver.get_state("sidebarCollapsed")
                pressed = self.driver.get_attribute(SIDEBAR, "aria-pressed")
                readings.append(f"shown={shown} aria-pressed={pressed!r}")
                problems += sidebar_toggle_problems(pressed, shown)
                before = self.driver.get_state("sidebarCollapsed")
                self.driver.click(SIDEBAR)
                self.wait(
                    lambda b=before: self.driver.get_state("sidebarCollapsed") != b,
                    what="the sidebar to toggle",
                )
            self.evidence(f"readings {readings}")
            assert not problems, problems

    def test_40_menu_toggle_rows_show_their_state(self):
        with self.step(
            "toolbar.more-menu.toggle-state",
            "'Log session output' and 'Record automation' are checkbox rows: unticked while off, "
            "'Record automation' ticked while recording",
            expect="#5849 (R-066): the '…' menu shows a tick before 'Record automation' while a "
            "recording runs, and the 'Recording' chip shows beside the layout icons",
        ):
            self.ensure_terminal()
            off = self._menu_rows()
            self.evidence(f"idle rows {off}")
            problems = menu_toggle_problems(off, {})
            self.driver.click(MORE)
            self.wait(lambda: self.driver.exists(RECORD), what="the record row")
            self.driver.click(RECORD)
            self.wait(lambda: self.driver.exists(RECORDING_CHIP), what="the 'Recording' chip")
            try:
                self.driver.click(MORE)
                self.wait(lambda: self.driver.exists(MENU), what="the '…' menu")
                self.shot(label="menu-recording")
                self.driver.press_key("Escape")
                on = self._menu_rows()
            finally:
                # Nothing was typed, so stopping keeps no recording.
                if self.driver.exists(RECORDING_CHIP):
                    self.driver.click(RECORDING_CHIP)
            self.evidence(f"recording rows {on}")
            problems += menu_toggle_problems(on, {RECORD: True})
            assert not problems, problems
