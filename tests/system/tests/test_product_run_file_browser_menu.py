"""Product run: the file browser menu shows state, one sort control, one New (#5832).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261123T215628Z`` saw the "…" menu mix toggles with commands and no checked
state (R-011), "Sort by" duplicate the column headers without the current
direction (R-079, R-122), look-alike New file / New folder icons beside Up /
Upload (R-011), and no hint which folder the menu acts on (R-123).

The grade opens the local file browser in a folder with a hidden file, files
with sizes and dates, then:

1. opens "…": the first line names the folder, "Show hidden files" is a
   checkbox entry whose tick follows the listing (toggled on and back off),
   the terminal-folder command reads "Go to terminal folder";
2. at a wide and at the minimum sidebar width: "Sort by" is in the menu
   exactly while a column header is hidden, naming the current column and
   direction;
3. "New ▾" is one header button listing File and Folder, set apart from
   Up / Refresh; New ▸ Folder opens the name field.

No servers needed. The ``test_grade_*`` functions grade fixed readings
without an app and run in the normal lane.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import pytest

from termihub_harness import FilesUi, SidebarUi, SystemTest, TabsUi, TerminalUi
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.file_browser_menu import (
    MORE_ACTIONS,
    MORE_MENU,
    NEW_FILE,
    NEW_FOLDER,
    NEW_MENU,
    TOGGLE_HIDDEN,
    menu_state_problems,
    new_menu_problems,
    read_header,
    read_menu,
    sort_control_problems,
)

RESIZE_HANDLE = "sidebar-resize-handle"
HIDDEN_FILE = ".pr-hidden-file"
FOLDER = "pr-file-browser-menu"
NEW_FOLDER_INPUT = "file-browser-new-folder-input"


# ── app-free grade tests ──────────────────────────────────────────────────
def _menu(**over: Any) -> dict[str, Any]:
    m = {
        "folder_text": FOLDER,
        "folder_title": f"/tmp/{FOLDER}",
        "hidden_role": "menuitemcheckbox",
        "hidden_checked": "false",
        "cwd_role": "menuitem",
        "cwd_text": "Go to terminal folder",
        "sort_present": False,
        "sort_label": None,
        "sort_current": None,
    }
    m.update(over)
    return m


def _box(x: float, width: float = 28.0) -> dict[str, Any]:
    return {"rect": {"x": x, "y": 4.0, "width": width, "height": 28.0}}


def _header(**over: Any) -> dict[str, Any]:
    h = {
        "new_haspopup": "menu",
        "new_file_inline": False,
        "new_folder_inline": False,
        "up": _box(0.0),
        "refresh": _box(30.0),
        "new": _box(63.0, 40.0),  # 2px gap + 1px divider + 2px gap
        "headers": {"name": True, "modified": True, "size": True},
    }
    h.update(over)
    return h


ALL = {"name": True, "modified": True, "size": True}
NARROW = {"name": True, "modified": False, "size": False}


def test_grade_menu_state_passes():
    assert menu_state_problems(_menu(), folder=f"/tmp/{FOLDER}", hidden_on=False) == []
    on = _menu(hidden_checked="true")
    assert menu_state_problems(on, folder=f"/tmp/{FOLDER}", hidden_on=True) == []


def test_grade_toggle_without_state_fails():
    # The R-011 shape: a plain entry, or a checkbox whose tick lies.
    plain = _menu(hidden_role="menuitem", hidden_checked=None)
    problems = menu_state_problems(plain, folder=f"/tmp/{FOLDER}", hidden_on=True)
    assert any("not a checkbox" in p for p in problems)
    assert any("aria-checked" in p for p in problems)


def test_grade_follow_wording_fails():
    m = _menu(cwd_text="Follow terminal folder")
    problems = menu_state_problems(m, folder=f"/tmp/{FOLDER}", hidden_on=False)
    assert any("reads like a toggle" in p for p in problems)


def test_grade_missing_or_wrong_folder_line_fails():
    gone = menu_state_problems(_menu(folder_text=None), folder=f"/tmp/{FOLDER}", hidden_on=False)
    assert any("which folder" in p for p in gone)
    wrong = menu_state_problems(_menu(folder_text="tmp"), folder=f"/tmp/{FOLDER}", hidden_on=False)
    assert any("folder line reads" in p for p in wrong)


def test_grade_sort_only_while_headers_hidden():
    assert sort_control_problems(_menu(), ALL, sort_key="name", sort_dir="asc") == []
    shown = _menu(sort_present=True, sort_label="Sort by: Name, ascending", sort_current="Name")
    assert sort_control_problems(shown, NARROW, sort_key="name", sort_dir="asc") == []
    # R-079: a second sort control beside every header.
    dup = sort_control_problems(shown, ALL, sort_key="name", sort_dir="asc")
    assert any("duplicates" in p for p in dup)
    # Hidden headers and no menu entry: no way to sort by them.
    none = sort_control_problems(_menu(), NARROW, sort_key="name", sort_dir="asc")
    assert any("offers no 'Sort by'" in p for p in none)


def test_grade_sort_without_current_state_fails():
    # R-122: the menu does not say what is sorted, or which way.
    m = _menu(sort_present=True, sort_label="Sort by", sort_current="")
    problems = sort_control_problems(m, NARROW, sort_key="size", sort_dir="desc")
    assert any("not the current 'Size'" in p for p in problems)
    assert any("direction" in p for p in problems)


def test_grade_new_menu_passes_and_fails():
    assert new_menu_problems(_header(), [NEW_FILE, NEW_FOLDER]) == []
    old = _header(new_haspopup=None, new_file_inline=True, new_folder_inline=True)
    problems = new_menu_problems(old, [])
    assert any("no 'New' menu button" in p for p in problems)
    assert any("separate header icons" in p for p in problems)
    assert any("lacks" in p for p in problems)
    flush = _header(new=_box(60.0, 40.0))  # same 2px gap as Up-to-Refresh
    assert any("sets 'New' apart" in p for p in new_menu_problems(flush, [NEW_FILE, NEW_FOLDER]))


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunFileBrowserMenu(ProductRunUi, FilesUi, TerminalUi, TabsUi, SidebarUi,
                                    SystemTest):
    phase = "File browser menu"
    request_timeout = 90.0
    folder: Path | None = None

    def _resize_to(self, width: float) -> None:
        now = float(self.driver.get_state("sidebarWidth"))
        if abs(now - width) > 1:
            self.driver.drag(RESIZE_HANDLE, int(width - now))
            time.sleep(0.8)  # let the header and the columns re-measure
        self.evidence(f"sidebar {float(self.driver.get_state('sidebarWidth')):.0f}px")

    def _open_menu(self) -> dict[str, Any]:
        if not self.driver.exists(MORE_MENU):
            self.driver.click(MORE_ACTIONS)
        self.wait(lambda: self.driver.exists(MORE_MENU), what="the '…' menu")
        time.sleep(0.3)  # let the popover settle
        return read_menu(self.driver)

    def _close_menus(self) -> None:
        for _ in range(3):
            if self.driver.exists(MORE_MENU) or self.driver.exists(f"{NEW_MENU}-menu"):
                self.driver.press_key("Escape")
                time.sleep(0.2)

    def _hidden_listed(self) -> bool:
        return self.driver.exists(f"file-row-{HIDDEN_FILE}")

    def test_10_menu_names_folder_and_ticks_toggle(self):
        with self.step(
            "file-browser-menu.state",
            "The '…' menu names its folder and ticks 'Show hidden files' (#5832)",
            expect="#5832: the open '…' menu starts with a muted folder line "
            f"'{FOLDER}'; 'Show hidden files' carries a tick exactly while the dot-file is "
            "listed; the cwd command reads 'Go to terminal folder'",
        ):
            folder = self.recorder.run_dir / FOLDER
            folder.mkdir(parents=True, exist_ok=True)
            (folder / HIDDEN_FILE).write_text("hidden\n", encoding="utf-8")
            (folder / "a-small.txt").write_text("a\n", encoding="utf-8")
            (folder / "b-larger.txt").write_text("b" * 4096, encoding="utf-8")
            type(self).folder = folder
            before = self.tab_ids()
            self.switch_to_connections_sidebar()
            self.open_new_terminal()
            self.wait(lambda: len(self.tab_ids()) == len(before) + 1, what="a local terminal")
            tab = next(t for t in self.tab_ids() if t not in before)
            self.wait(lambda: self.driver.read_terminal(tab).strip(), what="the local prompt")
            self.run_command(f"cd '{folder}'")
            self.switch_to_files_sidebar()
            self.wait_for_path_contains(FOLDER)
            self.wait(lambda: self.driver.exists("file-row-a-small.txt"), what="the listing")
            problems: list[str] = []
            try:
                for flip in (False, True, True):
                    if flip:
                        self._open_menu()
                        self.driver.click(TOGGLE_HIDDEN)
                        time.sleep(0.6)  # the listing re-filters
                    hidden_on = self._hidden_listed()
                    m = self._open_menu()
                    self.shot(label=f"hidden-{'on' if hidden_on else 'off'}")
                    self.evidence(f"hidden files {'listed' if hidden_on else 'not listed'}: {m}")
                    problems += menu_state_problems(m, folder=str(folder), hidden_on=hidden_on)
                    self._close_menus()
            finally:
                self._close_menus()
            assert not problems, "; ".join(dict.fromkeys(problems))

    def test_20_one_sort_control(self):
        with self.step(
            "file-browser-menu.sort",
            "'Sort by' is in the menu only while a column header is hidden (#5832)",
            expect="#5832: with the sidebar wide, the '…' menu has no 'Sort by' (the Name / "
            "Modified / Size headers sort); at the minimum width 'Sort by' shows the current "
            "column with its arrow",
        ):
            self.require("file-browser-menu.state")
            before = float(self.driver.get_state("sidebarWidth"))
            problems: list[str] = []
            try:
                for where, width in (("wide", 420.0), ("min-width", 0.0)):
                    self._resize_to(width)
                    headers = read_header(self.driver)["headers"]
                    m = self._open_menu()
                    self.shot(label=f"sort-{where}")
                    self.evidence(f"{where}: headers {headers}; menu sort {m['sort_present']} "
                                  f"{m['sort_label']!r}")
                    found = sort_control_problems(m, headers, sort_key="name", sort_dir="asc")
                    problems += [f"{where}: {p}" for p in found]
                    self._close_menus()
            finally:
                self._close_menus()
                self._resize_to(before)
            assert not problems, "; ".join(problems)

    def test_30_one_new_menu(self):
        with self.step(
            "file-browser-menu.new",
            "'New ▾' is one header button for File / Folder, set apart from Up (#5832)",
            expect="#5832: the header reads Up · Refresh | New ▾ (a divider before New); its "
            "menu lists File and Folder; New ▸ Folder opens the folder name field",
        ):
            self.require("file-browser-menu.state")
            problems: list[str] = []
            try:
                self.reveal_file_browser_action(NEW_MENU)
                header = read_header(self.driver)
                if self.driver.exists(MORE_MENU):
                    header["up"] = header["refresh"] = header["new"] = None  # New collapsed
                self.driver.click(NEW_MENU)
                self.wait(lambda: self.driver.exists(NEW_FILE), what="the 'New' menu")
                entries = [e for e in (NEW_FILE, NEW_FOLDER) if self.driver.exists(e)]
                self.shot(label="new-menu")
                self.evidence(f"header {header}; New lists {entries}")
                problems += new_menu_problems(header, entries)
                self._close_menus()
                self.invoke_file_browser_action(NEW_FOLDER)
                if not self.wait(lambda: self.driver.exists(NEW_FOLDER_INPUT),
                                 what="the folder name field"):
                    problems.append("New ▸ Folder did not open the name field")
                self.driver.press_key("Escape")
            finally:
                self._close_menus()
            assert not problems, "; ".join(problems)
        self.close_all_tabs()
