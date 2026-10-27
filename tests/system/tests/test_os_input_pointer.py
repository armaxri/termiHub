"""Automated OS-input grades: real pointer gestures at the test instance (#4935).

The bridge's ``dragTo`` / ``contextMenu`` dispatch synthetic pointer events
inside the webview. These grades move the **real** OS pointer with
:mod:`termihub_harness.os_input` — at screen coordinates calibrated from the
element's DOM rect — so window activation, implicit pointer grabs and releases
outside the window go through the OS exactly as for a user.

Retires the guided checks MT-NIN-07 (a tab released outside the window tears
off), MT-CONN-01 (drag a connection into a folder), MT-FB-20 (drag an editor tab
to another panel), MT-UI-26..28/30 (right-click: menu by default, opt-in Quick
Copy/Paste), MT-NIN-30 (Windows right-click pastes once) and MT-NIN-22 (one
click into an inactive window focuses the clicked pane, #4979).

Integration lane (nightly); on a developer machine the suite skips unless
``TERMIHUB_OS_INPUT_GLOBAL=1`` says nothing else is on the display.
"""

from __future__ import annotations

import sys
import tempfile
import time
import uuid
from pathlib import Path

import pytest

from termihub_harness import (
    SETTINGS_REGION,
    ConnectionsUi,
    EditorUi,
    FilesUi,
    LayoutUi,
    OsInputUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    WindowsUi,
    connection_item_testid,
    folder_toggle_testid,
    unique_name,
)
from termihub_harness.os_input import HelperWindow
from termihub_harness.ui.os_input_ui import has_line, linux_window_manager, terminal_echo
from termihub_harness.ui.terminal import NEW_TERMINAL
from termihub_harness.ui.windows import (
    CLOSE_DIALOG_END,
    SHORTCUT_FOCUS_TARGET,
    find_tab_by_session,
    window_tabs,
)

pytestmark = pytest.mark.integration

SPLIT_H = "terminal-view-split-horizontal"


@pytest.fixture(scope="class", autouse=True)
def _window_manager():
    with linux_window_manager():
        yield


class TestOsPointerGrades(
    OsInputUi,
    TerminalUi,
    TabsUi,
    LayoutUi,
    ConnectionsUi,
    SidebarUi,
    SettingsUi,
    EditorUi,
    FilesUi,
    WindowsUi,
    SystemTest,
):
    """Real pointer gestures into the test instance, graded from the app state."""

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _wait_echo(self, tab_id: str, tag: str) -> str:
        return self.wait(
            lambda: (lambda got: None if got is None else [got])(
                terminal_echo(self.driver.read_terminal(tab_id), tag)
            ),
            what=f"the {tag} echo",
        )[0]

    # ── MT-FB-20: drag an editor tab to another panel ────────────────────────
    def test_drag_editor_tab_between_panels(self):
        """MT-FB-20: an editor tab dropped on the centre of the other panel moves
        there and still shows its file."""
        osi = self.os_input()
        self.close_all_tabs()
        self.wait(lambda: self.tab_count() == 0, what="every tab to close")
        folder = Path(tempfile.mkdtemp(prefix="thub-editor-dnd-"))
        self.ensure_terminal()
        self.run_command(f'cd "{folder}"')
        self.open_file_browser()
        self.wait_for_path_contains(folder.name)
        name = f"{unique_name('editor-dnd')}.txt"
        self.create_file_via_browser(name)
        self.open_file_in_editor(name)
        editor = self.find_tab(name)
        assert editor is not None
        source_panel = self.panel_of_tab(editor["id"])
        self.driver.click(SPLIT_H)
        self.wait(lambda: self.leaf_count() == 2, what="a second panel")
        self.driver.click(NEW_TERMINAL)
        target = self.wait(
            lambda: next(
                (t for t in window_tabs(self.driver) if self.panel_of_tab(t["id"]) != source_panel),
                None,
            ),
            what="a terminal in the other panel",
        )
        self.wait(lambda: self.driver.read_terminal(target["id"]).strip(), what="its prompt")
        screen = self.os_activate()
        osi.drag(
            screen.point(f"tab-{editor['id']}"), screen.point(f"terminal-renderer-{target['id']}")
        )
        self.wait(
            lambda: self.panel_of_tab(editor["id"]) == self.panel_of_tab(target["id"]),
            what="the editor tab in the other panel",
        )
        assert self.find_tab(name) is not None

    # ── MT-CONN-01: drag a connection into a folder ──────────────────────────
    def test_drag_connection_into_folder(self):
        """MT-CONN-01: dragging a root connection onto a folder nests it there, and
        the very next click still acts (#4978)."""
        osi = self.os_input()
        self.close_all_tabs()
        self.switch_to_connections_sidebar()
        conn_name = unique_name("os-dnd-conn")
        self.create_local_connection(conn_name)
        folder = self.create_folder(unique_name("os-dnd-folder"))
        conn = self.require_connection(conn_name)
        assert conn.get("folderId") != folder["id"]
        screen = self.os_activate()
        osi.drag(
            screen.point(connection_item_testid(conn["id"])),
            screen.point(folder_toggle_testid(folder["id"])),
        )
        self.wait(
            lambda: self.require_connection(conn_name).get("folderId") == folder["id"],
            what="the connection to move into the folder",
        )
        # The first click right after the drop must act (#4978): dnd-kit used to
        # swallow it on Linux/Windows, where this release fires no click.
        self.driver.click(NEW_TERMINAL)
        self.wait(lambda: self.tab_count() == 1, what="the click after the drop to open a tab")

    # ── MT-UI-26..28, MT-NIN-30: right-click in the terminal ─────────────────
    def _quick_copy_then_paste(self, tab_id: str) -> None:
        """Right-click with a selection copies it; with none it pastes once."""
        osi = self.os_input()
        marker = f"RCMARK{uuid.uuid4().hex[:10]}"
        self.run_command(f"echo {marker}")
        self.wait(
            lambda: has_line(self.driver.read_terminal(tab_id), marker),
            what="the marker's output line",
        )
        screen = self.os_activate()
        self.os_select_terminal_word(tab_id, marker, screen)
        renderer = f"terminal-renderer-{tab_id}"
        self.os_click(renderer, screen=screen, button="right")
        assert not self.driver.exists("terminal-context-copy-all"), "a menu opened"
        osi.type_text("echo RC_")
        self.os_click(renderer, screen=screen, button="right", fy=0.9)
        osi.type_text("_\n")
        assert self._wait_echo(tab_id, "RC") == marker

    def test_right_click_platform_default_and_quick_copy_paste(self):
        """MT-UI-26: on macOS/Linux a plain right-click opens the terminal menu
        and pastes nothing. MT-NIN-30: on Windows (Quick Copy/Paste by default) a
        right-click with no selection pastes exactly once. MT-UI-27, MT-UI-28:
        with Quick Copy/Paste on, right-click copies the selection, or pastes
        without one. MT-UI-30: switching back to the default restores the menu."""
        self.os_input()
        self.close_all_tabs()
        behavior = self.projection_region_cache(SETTINGS_REGION).get("rightClickBehavior")
        assert behavior is None, f"Right-Click Behavior is {behavior!r}, not the platform default"
        self.ensure_terminal()
        tab_id = self.active_tab()["id"]  # type: ignore[index]
        if sys.platform == "win32":
            self._quick_copy_then_paste(tab_id)
        else:
            self._menu_opens_without_paste(tab_id)

        self.select_setting(
            "terminal", "settings-right-click-behavior", "quickAction",
            key="rightClickBehavior", expected="quickAction",
        )  # fmt: skip
        try:
            self.close_all_tabs()
            self.ensure_terminal()
            self._quick_copy_then_paste(self.active_tab()["id"])  # type: ignore[index]
        finally:
            self.select_setting(
                "terminal", "settings-right-click-behavior", "__platform_default__",
                key="rightClickBehavior", expected=None,
            )  # fmt: skip
            self.close_all_tabs()
        if sys.platform != "win32":
            self.ensure_terminal()
            tab_id = self.active_tab()["id"]  # type: ignore[index]
            self._menu_opens_without_paste(tab_id)

    def _menu_opens_without_paste(self, tab_id: str) -> None:
        """A real right-click opens the terminal menu and inserts nothing."""
        self.run_command("echo MENU_ready_")
        self.wait(
            lambda: terminal_echo(self.driver.read_terminal(tab_id), "MENU") == "ready",
            what="the echo's output line",
        )
        time.sleep(0.5)  # let the prompt redraw settle before the snapshot
        before = self.driver.read_terminal(tab_id)
        screen = self.os_activate()
        self.os_click(f"terminal-renderer-{tab_id}", screen=screen, button="right")
        self.wait(
            lambda: self.driver.exists("terminal-context-copy-all"), what="the terminal menu"
        )
        assert self.driver.exists("terminal-context-paste")
        assert self.trusted_events(kind="contextmenu"), "the menu came from a synthetic event"
        self.os_input().key("escape")
        self.wait(
            lambda: not self.driver.exists("terminal-context-copy-all"), what="the menu to close"
        )
        assert self.driver.read_terminal(tab_id) == before, "the right-click pasted"

    # ── MT-NIN-22: one click into an inactive window ─────────────────────────
    def _two_shell_panes(self) -> tuple[str, str]:
        """Two side-by-side shells; their tab ids, left pane first."""
        self.close_all_tabs()
        self.wait(lambda: self.tab_count() == 0, what="every tab to close")
        self.ensure_terminal()
        self.driver.click(SPLIT_H)
        self.wait(lambda: self.leaf_count() == 2, what="a second panel")
        self.driver.click(NEW_TERMINAL)
        self.wait(lambda: self.tab_count() == 2, what="a shell in each pane")
        left_panel = self.leaf_ids()[0]
        tabs = window_tabs(self.driver)
        left = next(t["id"] for t in tabs if self.panel_of_tab(t["id"]) == left_panel)
        right = next(t["id"] for t in tabs if t["id"] != left)
        for tab_id in (left, right):
            self.wait(lambda t=tab_id: self.driver.read_terminal(t).strip(), what="its prompt")
        return left, right

    def test_click_into_inactive_window_focuses_clicked_pane(self):
        """MT-NIN-22: with another app in front, ONE real click into the right
        shell of an inactive termiHub window activates the window and the keys
        typed next land in the right pane only (Windows/Linux). macOS may keep
        the first click for the window activation: there the keys land in the
        pane the app shows focused, never in an unfocused one."""
        osi = self.os_input()
        left, right = self._two_shell_panes()
        with HelperWindow() as helper:
            osi.allow_pid(helper.pid)
            screen = self.os_activate()
            self.os_click(f"terminal-renderer-{left}", screen=screen)
            self.wait(
                lambda: (self.active_tab() or {}).get("id") == left, what="the left pane active"
            )
            osi.activate(helper.pid)
            self.wait(lambda: not self.has_focus(), what="termiHub to lose focus")
            self.reset_input_probe()

            self.os_click(f"terminal-renderer-{right}", screen=screen)
            self.wait(
                lambda: osi.frontmost_pid() == self.app.pid,
                what=f"the click to front termiHub (frontmost PID {osi.frontmost_pid()})",
            )
            self.wait(self.has_focus, what="the clicked window to take the focus")
            expected = right if sys.platform != "darwin" else None
            if expected is not None:
                self.wait(
                    lambda: (self.active_tab() or {}).get("id") == right,
                    what=f"the right pane active (pointer events: "
                    f"{[e['type'] for e in self.trusted_events()]})",
                )
            osi.type_text("echo N22_abc_\n")
            focused = (self.active_tab() or {}).get("id")
            target = expected or focused
            assert target in (left, right), f"no shell pane is focused ({focused})"
            assert self._wait_echo(target, "N22") == "abc"
            other = left if target == right else right
            assert terminal_echo(self.driver.read_terminal(other), "N22") is None, (
                "the keys also reached the unfocused pane"
            )
        assert "abc" not in helper.typed(), "the keys went to the other app"

    # Last in the suite: it leaves a resized window behind.
    # ── MT-NIN-07: tab tear-off ──────────────────────────────────────────────
    def test_tab_drag_released_outside_window_tears_off(self):
        """MT-NIN-07 (#4916): a tab released inside the window off every drop
        target changes nothing; released outside the window it opens in a new
        window with its session intact."""
        osi = self.os_input()
        self.close_all_tabs()
        self.ensure_terminal()
        self.driver.click(NEW_TERMINAL)
        self.wait(lambda: self.tab_count() == 2, what="two tabs")
        moved = window_tabs(self.driver)[-1]
        session_id = self.live_session_id(self.driver, moved["id"])
        self.run_command("echo torn-off")
        self.wait_for_output("torn-off", tab_id=moved["id"])
        # Leave screen space around the window for the release outside it.
        self.driver.resize_window(900, 620)
        screen = self.os_activate()

        before = self.driver.get_state("rootPanel")
        osi.drag(screen.point(f"tab-{moved['id']}"), screen.point(SHORTCUT_FOCUS_TARGET))
        self.wait(lambda: self.driver.get_state("rootPanel") == before, what="an unchanged layout")
        assert len(self.driver.windows()) == 1

        labels_before = set(self.driver.windows())
        screen = self.os_activate()
        osi.drag(screen.point(f"tab-{moved['id']}"), screen.outside_point())
        self.wait(lambda: set(self.driver.windows()) - labels_before, what="the torn-off window")
        (label,) = set(self.driver.windows()) - labels_before
        torn = self.driver.window(label)
        tab = self.wait(lambda: find_tab_by_session(torn, session_id), what="the moved session")
        self.wait(lambda: "torn-off" in torn.read_terminal(tab["id"]), what="its scrollback")
        assert self.tab_count() == 1
        assert find_tab_by_session(self.driver, session_id) is None
        # Close the torn-off window so later suites see one window again.
        torn.close_window()
        self.wait(lambda: torn.exists(CLOSE_DIALOG_END), what="the torn window's close dialog")
        torn.click(CLOSE_DIALOG_END)
        self.wait(lambda: len(self.driver.windows()) == 1, what="the torn window to close")
        # Give the main window the OS focus back, as a user's click would.
        self.os_activate()
