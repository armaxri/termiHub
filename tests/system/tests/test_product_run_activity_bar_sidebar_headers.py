"""Product run: recognisable activity-bar glyphs, one "New ▾", sentence case (#5848).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261123T215628Z`` found the clapperboard (macros) and the scroll (log
viewer) hard to place and the Saved header's three bare icons unreadable
(R-022), a second "New connection" link in the compact empty line (R-096),
and uppercase sidebar headers against the copy style (R-088).

Now every activity-bar item names itself and tags its glyph (``data-icon``);
macros draw a bolt and the log viewer a text file; the Saved header holds one
"New ▾" menu with text entries; the compact empty line has no link; and the
sidebar headers are sentence case.

The grade reads the main window's chrome; no servers needed. It opens the
"New ▾" menu and closes it with Escape, creating nothing.

The ``test_grade_*`` functions grade fixed readings without an app and run in
the normal lane.
"""

from __future__ import annotations

from typing import Any, Optional

import pytest

from termihub_harness import ConnectionsUi, LayoutUi, SidebarUi, SystemTest
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.activity_bar_headers import (
    NEW_MENU,
    NEW_MENU_ROWS,
    SAVED_TOGGLE,
    activity_bar_problems,
    empty_line_problems,
    header_problems,
    heading_case_problems,
    menu_problems,
)

ACTIVITY_BAR = "activity-bar"
SAVED_HEADER = "sidebar-group-header-connections"
MENU = "connection-list-new-menu-content"
REMOTE_TOGGLE = "connection-list-remote-agents-toggle"
EMPTY = "connections-empty-state"
EMPTY_LINK = "connections-empty-new-connection"

#: The shipped activity bar.
SHIPPED_BAR = [
    {"testId": "activity-bar-connections", "label": "Connections", "icon": "network"},
    {"testId": "activity-bar-file-browser", "label": "File browser", "icon": "folder-open"},
    {"testId": "activity-bar-recent-sessions", "label": "Recent sessions", "icon": "history"},
    {"testId": "activity-bar-workspaces", "label": "Workspaces", "icon": "layout-grid"},
    {"testId": "activity-bar-automations", "label": "Automations", "icon": "zap"},
    {"testId": "activity-bar-ssh-tunnels", "label": "SSH tunnels", "icon": "arrow-left-right"},
    {"testId": "activity-bar-services", "label": "Services", "icon": "server"},
    {"testId": "activity-bar-network-tools", "label": "Network tools", "icon": "stethoscope"},
    {"testId": "activity-bar-plugins", "label": "Plugins", "icon": "puzzle"},
    {"testId": "activity-bar-logs", "label": "Log viewer", "icon": "file-text"},
    {"testId": "activity-bar-settings", "label": "Settings", "icon": "settings"},
]
SHIPPED_HEADER = [
    {"testId": SAVED_TOGGLE, "label": None, "text": "Saved"},
    {"testId": NEW_MENU, "label": "New", "text": "New"},
]


# ── app-free grade tests ──────────────────────────────────────────────────
def test_grade_shipped_activity_bar_passes():
    assert activity_bar_problems(SHIPPED_BAR) == []


def test_grade_unclear_glyphs_fail():
    # The R-022 shape: clapperboard for macros, scroll for the log viewer.
    bar = [
        {**i, "icon": {"zap": "clapperboard", "file-text": "scroll-text"}.get(i["icon"], i["icon"])}
        for i in SHIPPED_BAR
    ]
    problems = activity_bar_problems(bar)
    assert any("'clapperboard', unclear for automations" in p for p in problems)
    assert any("'scroll-text', unclear for the log viewer" in p for p in problems)


def test_grade_unnamed_untagged_or_duplicate_items_fail():
    bar = [dict(i) for i in SHIPPED_BAR]
    bar[1]["label"] = ""
    bar[2]["icon"] = None
    bar[3]["icon"] = "network"
    problems = activity_bar_problems(bar)
    assert any("activity-bar-file-browser has no accessible name" in p for p in problems)
    assert any("no glyph tag" in p for p in problems)
    assert any("draw the same glyph 'network'" in p for p in problems)
    assert activity_bar_problems([]) == ["the activity bar shows no items"]
    no_logs = [i for i in SHIPPED_BAR if i["testId"] != "activity-bar-logs"]
    assert "the log viewer item is missing" in activity_bar_problems(no_logs)


def test_grade_one_new_menu_header_passes():
    assert header_problems(SHIPPED_HEADER) == []


def test_grade_three_bare_icons_fail():
    # The R-022 shape: new folder, "+" and import as unlabelled icons.
    header = [
        SHIPPED_HEADER[0],
        {"testId": "connection-list-new-folder", "label": "New folder", "text": ""},
        {"testId": "connection-list-new-connection", "label": "New connection", "text": ""},
        {"testId": "connection-list-open-import-settings", "label": "Import", "text": ""},
    ]
    assert any("want only" in p for p in header_problems(header))
    icon_only = [SHIPPED_HEADER[0], {"testId": NEW_MENU, "label": "New", "text": ""}]
    assert any("want visible text 'New'" in p for p in header_problems(icon_only))


def test_grade_menu_rows():
    assert menu_problems(dict(NEW_MENU_ROWS)) == []
    rows = {**NEW_MENU_ROWS, "connection-list-new-folder": "Folder"}
    del rows["connection-list-open-import-settings"]
    problems = menu_problems(rows)
    assert any("reads 'Folder', want 'New folder'" in p for p in problems)
    assert any("open-import-settings is not in the New menu" in p for p in problems)


def test_grade_heading_case():
    ok = {"panel": ("Connections", "none"), "saved": ("Saved", "none")}
    assert heading_case_problems(ok) == []
    # The R-088 shape: CSS-uppercased headers.
    problems = heading_case_problems({"saved": ("Saved", "uppercase"), "x": ("SAVED", "none")})
    assert any("saved is uppercased by CSS" in p for p in problems)
    assert any("written in capitals" in p for p in problems)
    assert heading_case_problems({"x": ("saved", "none")})
    # Acronyms inside sentence case are fine.
    assert heading_case_problems({"tunnels": ("SSH tunnels", "none")}) == []


def test_grade_empty_line():
    assert empty_line_problems(compact=True, has_link=False) == []
    assert empty_line_problems(compact=False, has_link=True) == []
    assert empty_line_problems(compact=True, has_link=True)


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunActivityBarSidebarHeaders(
    ProductRunUi, LayoutUi, ConnectionsUi, SidebarUi, SystemTest
):
    phase = "Main window"
    request_timeout = 90.0

    def _show_connections(self) -> None:
        self.dismiss_menu()
        self.set_sidebar_visible(True)
        self.switch_to_connections_sidebar()
        self.wait(lambda: self.driver.exists(NEW_MENU), what="the Saved header's New menu")

    def _visible_buttons(self, test_id: str) -> list[dict[str, Any]]:
        items = self.driver.measure_element(test_id, "buttons")["items"]
        return [i for i in items if i["visible"] and i["testId"]]

    def _heading(self, test_id: str) -> tuple[str, str]:
        text = (self.driver.get_text(test_id) or "").strip()
        return text, self.driver.get_computed_style("text-transform", test_id)

    def test_10_activity_bar_glyphs(self):
        with self.step(
            "activity-bar.glyphs",
            "Every activity-bar item names itself and draws its own glyph; macros a bolt, "
            "the log viewer a text file",
            expect="#5848 (R-022): a lightning bolt for Macros and a page of text lines for "
            "the log viewer near the gear; hovering any icon shows its name",
        ):
            self._show_connections()
            items = [
                {
                    "testId": b["testId"],
                    "label": b["label"],
                    "icon": self.driver.get_attribute(b["testId"], "data-icon"),
                }
                for b in self._visible_buttons(ACTIVITY_BAR)
            ]
            self.shot(label="activity-bar")
            self.evidence(f"items {[(i['testId'], i['icon']) for i in items]}")
            problems = activity_bar_problems(items)
            assert not problems, problems

    def test_20_saved_header_has_one_new_menu(self):
        with self.step(
            "sidebar.saved.new-menu",
            "The Saved header carries one 'New' menu listing New connection, New folder "
            "and Import connections…",
            expect="#5848 (R-022): right of 'Saved' a '+ New ▾' button; opened, it lists "
            "'New connection', 'New folder' and 'Import connections…'",
        ):
            self._show_connections()
            buttons = self._visible_buttons(SAVED_HEADER)
            self.evidence(f"header buttons {[(b['testId'], b['text']) for b in buttons]}")
            problems = header_problems(buttons)
            rows: dict[str, Optional[str]] = {}
            self.driver.click(NEW_MENU)
            try:
                self.wait(lambda: self.driver.exists(MENU), what="the New menu")
                rows = {
                    tid: self.driver.get_text(tid)
                    for tid in NEW_MENU_ROWS
                    if self.driver.exists(tid)
                }
                self.shot(label="new-menu")
            finally:
                if self.driver.exists(MENU):
                    self.driver.press_key("Escape")
            self.evidence(f"menu rows {rows}")
            problems += menu_problems(rows)
            assert not problems, problems

    def test_30_headings_are_sentence_case(self):
        with self.step(
            "sidebar.headings.case",
            "The sidebar title and section headers are sentence case, not uppercased",
            expect="#5848 (R-088): 'Connections' above 'Saved' (and 'Remote agents' when "
            "shown), in normal case at a muted weight",
        ):
            self._show_connections()
            headings = {
                "panel title": self._heading("sidebar-title"),
                "Saved": self._heading(SAVED_TOGGLE),
            }
            if self.driver.exists(REMOTE_TOGGLE):
                headings["Remote agents"] = self._heading(REMOTE_TOGGLE)
            self.evidence(f"headings {headings}")
            problems = heading_case_problems(headings)
            assert not problems, problems

    def test_40_empty_line_has_no_second_entry_point(self):
        with self.step(
            "sidebar.saved.empty-line",
            "The compact empty line does not repeat the New menu's 'New connection'",
            expect="#5848 (R-096): with agents listed and nothing saved, the line reads "
            "'No saved connections. Add one with “New” above.' with no link",
        ):
            self._show_connections()
            if not self.driver.exists(EMPTY):
                self.evidence("no Connections empty state on screen (connections saved)")
                return
            cls = self.driver.get_attribute(EMPTY, "class") or ""
            compact = "connections-empty--compact" in cls
            has_link = self.driver.exists(EMPTY_LINK)
            self.evidence(f"empty state class {cls!r}, link shown: {has_link}")
            problems = empty_line_problems(compact, has_link)
            assert not problems, problems
