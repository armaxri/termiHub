"""Guided-manual tests for input routing & drag-and-drop (issue #920).

Part of the guided-manual epic (#913); builds on the guided-manual mode (#914).
These cover the interactions that depend on the **real OS input pipeline** or on
**drop targets the synthetic bridge cannot faithfully reproduce** — the cases the
fully-automated suites (``test_tab_management``'s in-list reorder,
``test_split_views``' button-driven splits) deliberately leave out.

Each test follows the guided-manual contract (#914): the **harness does all the
automatable work** — launch the app, build the tabs/panels/connections/settings,
and assert the resulting layout / store state after the gesture — then hands the
operator only the irreducibly-manual step (the real drag / keypress / right-click
/ file-drop, or a clipboard or PTY-signal effect the bridge cannot observe) via
:meth:`ManualUi.manual_step` / :meth:`manual_observe`.

Covered:

- **Right-click terminal: context menu vs Quick Copy/Paste** (MT-UI-26..30) —
  the harness opens the real context menu (asserting its items), the operator
  exercises real-clipboard Quick Copy/Paste.
- **Drag a connection into a folder** (MT-CONN-01/24) — harness builds the
  connection + folder and asserts the connection's parent after the drop.
- **Drag an editor tab between panels** (MT-FB-20) — harness opens an editor in a
  split and asserts which panel holds it after the drag.
- **OS file drop onto a pane** (MT-UI-34) — native drag-drop coordinates; harness
  prepares the file + terminal, the operator drops and confirms the path lands.

Retired to automation (#4928): the shell-chord pass-through, the pass-through
toggle and the editor-vs-terminal Find routing (MT-KB-09 … 14) are pinned per PR
by ``keybindings.test.ts``, ``terminalInputRouting.test.ts`` and
``useKeyboardShortcuts.test.ts``; tab drag to a panel edge and into another
panel (MT-TAB-06/07) are real drag gestures over the bridge in
``test_layout_scrollback_ui``; divider resize (MT-TAB-16) is automated in
``test_split_views`` since #3693.

Marked ``manual`` + ``integration``, so they **skip** on CI / normal runs and run
only under ``./pytest.sh --manual -k input_routing -s`` with an operator.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Optional

import pytest

from termihub_harness import (
    ConnectionsUi,
    EditorUi,
    FilesUi,
    LayoutUi,
    ManualUi,
    SETTINGS_REGION,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = [pytest.mark.integration, pytest.mark.manual]

SPLIT_H = "terminal-view-split-horizontal"
NEW_TERMINAL = "terminal-view-new-terminal"


class TestInputRouting(
    TerminalUi,
    TabsUi,
    LayoutUi,
    ConnectionsUi,
    SidebarUi,
    SettingsUi,
    EditorUi,
    FilesUi,
    ManualUi,
    SystemTest,
):
    """Real-input & DnD flows: harness builds + asserts the state, operator
    performs the gesture the synthetic bridge cannot reproduce."""

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _connection_folder(self, name: str) -> Optional[str]:
        """The ``folderId`` of the connection named ``name``, or None.

        A connection at the tree root has ``folderId`` null; one inside a folder
        carries that folder's id (see ``SavedConnection`` in connection.ts).
        """
        conn = self.require_connection(name)
        return conn.get("folderId")

    def _scratch_file(self, prefix: str, name: str, contents: str) -> Path:
        """Write a throwaway file the operator drops / drags, returning its path."""
        target = Path(tempfile.mkdtemp(prefix=f"thub-{prefix}-")) / name
        target.write_text(contents, encoding="utf-8")
        return target

    # ── Right-click terminal: menu vs Quick Copy/Paste (MT-UI-26..30) ─────────
    def test_terminal_context_menu_and_quick_copy_paste(self):
        """The harness opens the real terminal context menu (asserting Copy All /
        Paste items), then the operator exercises Quick Copy/Paste via the real
        clipboard and the right-click menu items.

        The menu's *presence and items* are harness-verified via the
        ``terminal-context-trigger-<tab>`` testid; the actual clipboard transfer
        is operator-confirmed (the bridge cannot read the OS clipboard)."""
        self.close_all_tabs()
        # MT-UI-26: a fresh profile leaves Right-Click Behavior unset (platform
        # default), which is the context menu on macOS/Linux (#4915).
        behavior = self.projection_region_cache(SETTINGS_REGION).get("rightClickBehavior")
        assert behavior is None, (
            f"Right-Click Behavior is {behavior!r}, expected the platform default "
            "(unset) -- reset it in Settings > Terminal before this run"
        )
        self.ensure_terminal()
        marker = "CTX_MENU_MARKER_5120"
        self.run_command(f"echo {marker}")
        self.wait_for_output(marker)

        tab = self.active_tab()
        assert tab is not None
        trigger = f"terminal-context-trigger-{tab['id']}"
        self.driver.context_menu(trigger)
        self.wait(
            lambda: self.driver.exists("terminal-context-copy-all"),
            what="the terminal context menu",
        )
        assert self.driver.exists("terminal-context-paste"), "Paste item missing"
        # Close the menu before handing off to the operator.
        self.driver.press_key("Escape")

        self.manual_step(
            "Right-click inside the terminal pane (a plain right-click, release "
            "without moving). Then use 'Copy All' (or select text first and "
            "'Copy Selection') and paste the result into any external editor.",
            "The menu opens and stays open on the release -- nothing is pasted "
            f"into the terminal -- and the pasted text contains {marker!r}.",
        )

        # MT-UI-27/28: Quick Copy/Paste is opt-in -- switch it on for the
        # operator, and restore the platform default afterwards.
        self.select_setting(
            "terminal", "settings-right-click-behavior", "quickAction",
            key="rightClickBehavior", expected="quickAction",
        )
        try:
            self.close_all_tabs()
            self.ensure_terminal()
            self.manual_step(
                "Quick Copy/Paste is now on. In the terminal:\n"
                "  - select some text with the mouse and right-click: it is copied "
                "(the selection clears), then\n"
                "  - right-click with nothing selected: the clipboard is pasted.",
                "Right-click copies the selection or pastes when nothing is "
                "selected; no menu is shown.",
            )
        finally:
            self.select_setting(
                "terminal", "settings-right-click-behavior", "__platform_default__",
                key="rightClickBehavior", expected=None,
            )
            self.close_all_tabs()

    # ── Drag a connection into a folder (MT-CONN-01/24) ───────────────────────
    def test_drag_connection_into_folder(self):
        """The harness creates a root connection and a folder; the operator drags
        the connection into the folder; the harness asserts the connection's
        parent is now that folder."""
        self.close_all_tabs()
        self.switch_to_connections_sidebar()
        conn_name = unique_name("dnd-conn")
        folder_name = unique_name("dnd-folder")
        self.create_local_connection(conn_name)
        folder = self.create_folder(folder_name)
        assert self._connection_folder(conn_name) != folder["id"], (
            "connection should start outside the folder"
        )

        self.manual_step(
            f"In the Connections sidebar, drag the connection {conn_name!r} and "
            f"drop it onto the folder {folder_name!r}.",
            "The connection moves inside the folder (it nests under it in the tree).",
        )

        self.wait(
            lambda: self._connection_folder(conn_name) == folder["id"],
            what="the connection to move into the folder",
        )

    # ── Drag an editor tab between panels (MT-FB-20) ──────────────────────────
    def test_drag_editor_tab_between_panels(self):
        """The harness opens an editor tab in a 2-panel split; the operator drags
        the editor tab into the other panel; the harness asserts the tree changed
        and the editor tab still exists."""
        self.close_all_tabs()
        fname = f"{unique_name('editor-dnd')}.txt"
        self.ensure_terminal()
        self.open_file_browser()
        self.create_file_via_browser(fname)
        self.open_file_in_editor(fname)
        editor_tab = self.find_tab(fname)
        assert editor_tab is not None, "editor tab did not open"

        # Make a second panel so there is a cross-panel target.
        self.driver.click(SPLIT_H)
        self.wait(lambda: self.leaf_count() == 2, what="a second panel for the editor")
        self.driver.click(NEW_TERMINAL)
        before = self.driver.get_state("rootPanel")

        self.manual_step(
            f"Drag the editor tab {fname!r} from its panel into the CENTER of the "
            "other panel and drop it there.",
            "The editor tab moves into the other panel and still shows the file.",
        )

        self.wait(
            lambda: self.driver.get_state("rootPanel") != before,
            what="the editor tab to move between panels",
        )
        assert self.find_tab(fname) is not None, "editor tab vanished after the move"
        self.close_all_tabs()

    # ── OS file drop onto a pane (MT-UI-34) ───────────────────────────────────
    def test_os_file_drop_onto_pane(self):
        """The harness prepares a terminal and a scratch file; the operator drags
        the file from the OS file manager onto the terminal pane; the operator
        confirms the dropped path is inserted.

        Native OS drag-drop carries real screen coordinates the in-webview bridge
        cannot synthesize, so the whole gesture is operator-driven."""
        self.close_all_tabs()
        self.ensure_terminal()
        dropped = self._scratch_file("filedrop", "drop-me.txt", "file-drop payload\n")

        self.manual_step(
            "From your OS file manager (Finder / Explorer / Files), drag this file "
            f"onto the terminal pane and drop it:\n      {dropped}",
            f"termiHub inserts the dropped file's path ({dropped.name}) into the "
            "terminal at the cursor (quoted/escaped as needed).",
        )
