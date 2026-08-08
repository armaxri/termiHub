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

- **Shell-conflict key pass-through** (MT-KB-09/10/11) — Ctrl+W word delete,
  Ctrl+B tmux prefix, Ctrl+\\ SIGQUIT: needs real PTY signal/byte observation.
- **Pass-through toggle + context-aware routing** (MT-KB-12/13/14) — the
  harness flips ``terminalKeyPassthrough`` / focuses an editor vs a terminal
  (asserting the persisted flag + focus), the operator confirms the routing.
- **Right-click terminal: context menu vs Quick Copy/Paste** (MT-UI-26..30) —
  the harness opens the real context menu (asserting its items), the operator
  exercises real-clipboard Quick Copy/Paste.
- **Tab drag to edge / across groups / divider resize** (MT-TAB-06/07/16) — drop
  targets outside the bridge's dnd-kit coverage; harness asserts the resulting
  leaf count / panel tree after the operator's drag.
- **Drag a connection into a folder** (MT-CONN-01/24) — harness builds the
  connection + folder and asserts the connection's parent after the drop.
- **Drag an editor tab between panels** (MT-FB-20) — harness opens an editor in a
  split and asserts which panel holds it after the drag.
- **OS file drop onto a pane** (MT-UI-34) — native drag-drop coordinates; harness
  prepares the file + terminal, the operator drops and confirms the path lands.

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
CLOSE_PANEL = "terminal-view-close-panel"


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
    def _reset_to_single_terminal(self) -> None:
        """Collapse any splits and leave exactly one terminal panel open."""
        self.close_all_tabs()
        self.ensure_terminal()
        self.wait(lambda: self.leaf_count() == 1, what="a single panel")

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

    # ── Shell-conflict key pass-through (MT-KB-09/10/11) ──────────────────────
    def test_shell_keys_pass_through_to_pty(self):
        """Pass-through on: the harness types a command, the operator presses the
        shell chords, and confirms the PTY (not an app shortcut) received them.

        These chords (Ctrl+W word-delete, Ctrl+B tmux prefix, Ctrl+\\ SIGQUIT)
        only reach the PTY through the real OS input pipeline — a synthetic
        ``keydown`` cannot exercise xterm's key handler + the backend signal path.
        """
        self.close_all_tabs()
        # Ensure pass-through is on (the default) so the chords reach the shell.
        self.open_settings_category("keyboard")
        self.wait(
            lambda: self.driver.exists("keyboard-settings-passthrough"),
            what="the pass-through toggle",
        )
        if self.projection_region_cache(SETTINGS_REGION).get("terminalKeyPassthrough") is False:
            self.driver.click("keyboard-settings-passthrough")
        self.wait(
            lambda: self.projection_region_cache(SETTINGS_REGION).get("terminalKeyPassthrough") is not False,
            what="pass-through to be enabled",
        )

        self.ensure_terminal()
        self.run_command("echo READY_FOR_KEYS")
        self.wait_for_output("READY_FOR_KEYS")

        self.manual_step(
            "Click into the terminal so it has focus, then:\n"
            "  1. Type 'foo bar baz' (do NOT press Enter), then press Ctrl+W.\n"
            "  2. Press Ctrl+\\ to send SIGQUIT to a running command:\n"
            "       type  sleep 30  then Enter, then press Ctrl+\\.",
            "Ctrl+W deletes the last word ('baz'), and Ctrl+\\ quits the sleep "
            "with a 'Quit' / SIGQUIT message -- neither triggered an app shortcut.",
        )

        self.manual_step(
            "If tmux is installed, run  tmux  then press Ctrl+B then % (split).",
            "Ctrl+B reaches tmux as its prefix key (it splits the pane) rather "
            "than triggering a termiHub shortcut. (Skip if tmux is unavailable.)",
        )

    # ── Pass-through toggle (MT-KB-12) ────────────────────────────────────────
    def test_passthrough_toggle_changes_routing(self):
        """The harness flips the pass-through setting off (asserting it persisted)
        and the operator confirms a shell chord now triggers the app instead.

        The toggle's *persistence* is fully harness-verified; only the resulting
        routing change is operator-confirmed."""
        self.close_all_tabs()
        self.open_settings_category("keyboard")
        self.wait(
            lambda: self.driver.exists("keyboard-settings-passthrough"),
            what="the pass-through toggle",
        )
        # Force it on first, then turn it off, so we always exercise the off path.
        if self.projection_region_cache(SETTINGS_REGION).get("terminalKeyPassthrough") is False:
            self.driver.click("keyboard-settings-passthrough")
            self.wait(
                lambda: self.projection_region_cache(SETTINGS_REGION).get("terminalKeyPassthrough") is not False,
                what="pass-through to be enabled before the toggle test",
            )
        self.driver.click("keyboard-settings-passthrough")
        self.wait(
            lambda: self.projection_region_cache(SETTINGS_REGION).get("terminalKeyPassthrough") is False,
            what="pass-through to be disabled",
        )

        self.ensure_terminal()
        self.manual_step(
            "Pass-through is now OFF. Focus the terminal and press a chord bound "
            "to an app shortcut (e.g. Ctrl+W if it maps to 'close tab').",
            "With pass-through off the chord triggers the app shortcut instead of "
            "reaching the shell.",
        )

        # Restore the default so later suites start from pass-through on.
        self.open_settings_category("keyboard")
        self.wait(
            lambda: self.driver.exists("keyboard-settings-passthrough"),
            what="the pass-through toggle",
        )
        self.driver.click("keyboard-settings-passthrough")
        self.wait(
            lambda: self.projection_region_cache(SETTINGS_REGION).get("terminalKeyPassthrough") is not False,
            what="pass-through to be restored",
        )

    # ── Context-aware routing: Cmd+F editor vs terminal (MT-KB-13/14) ─────────
    def test_context_aware_find_routing(self):
        """The harness focuses an editor, then a terminal; the operator presses the
        Find shortcut in each and confirms it routes to the focused surface.

        The harness builds + opens both surfaces (asserting they mount); the
        OS-level shortcut dispatch + the resulting overlay are operator-confirmed."""
        self.close_all_tabs()
        # An editor surface: open a scratch file in the editor.
        fname = f"{unique_name('find-route')}.txt"
        self.ensure_terminal()
        self.open_file_browser()
        self.create_file_via_browser(fname)
        self.open_file_in_editor(fname)
        assert self.editor_status_present(), "editor did not mount for the routing test"

        self.manual_step(
            "The editor tab is focused. Press the Find shortcut "
            "(macOS: Cmd+F  ·  Windows/Linux: Ctrl+F).",
            "The editor's Find widget opens (Monaco), not the terminal search.",
        )

        # Now a terminal surface.
        self.open_new_terminal()
        self.wait(self.has_terminal, what="a terminal to focus for routing")
        self.manual_step(
            "Now click into the terminal pane to focus it and press the same Find "
            "shortcut (macOS: Cmd+F  ·  Windows/Linux: Ctrl+F).",
            "The terminal's search bar opens, not the editor Find widget -- the "
            "shortcut routed to the context-appropriate surface.",
        )

    # ── Right-click terminal: menu vs Quick Copy/Paste (MT-UI-26..30) ─────────
    def test_terminal_context_menu_and_quick_copy_paste(self):
        """The harness opens the real terminal context menu (asserting Copy All /
        Paste items), then the operator exercises Quick Copy/Paste via the real
        clipboard and the right-click menu items.

        The menu's *presence and items* are harness-verified via the
        ``terminal-context-trigger-<tab>`` testid; the actual clipboard transfer
        is operator-confirmed (the bridge cannot read the OS clipboard)."""
        self.close_all_tabs()
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
            "Right-click inside the terminal pane to open its context menu, then "
            "use 'Copy All' (or select text first and 'Copy Selection'). Paste "
            "the result into any external editor.",
            f"The pasted text contains {marker!r} -- the menu copied to the real "
            "clipboard.",
        )
        self.manual_step(
            "Now test Quick Copy/Paste on the terminal:\n"
            "  - select terminal text with the mouse (Quick Copy: it goes to the "
            "clipboard on selection, if enabled), and\n"
            "  - middle-click or right-click to Quick Paste it back.",
            "Quick Copy/Paste move text via the real clipboard as configured; the "
            "right-click menu is not shown when Quick Paste is the bound action.",
        )

    # ── Drag tab to a panel edge → split (MT-TAB-06) ──────────────────────────
    def test_drag_tab_to_edge_creates_split(self):
        """The harness builds two tabs in one panel; the operator drags one to a
        panel edge; the harness asserts a second leaf panel appeared.

        Edge drop zones (``PanelDropZone``) render only during an active drag and
        resolve through dnd-kit collision detection, which the synthetic
        ``drag_to`` cannot reproduce -- so the drag is operator-driven, the
        resulting split is harness-asserted from ``rootPanel``."""
        self._reset_to_single_terminal()
        self.driver.click(NEW_TERMINAL)
        self.wait(lambda: self.tab_count() >= 2, what="a second tab to drag")
        assert self.leaf_count() == 1

        self.manual_step(
            "Drag one of the two terminal tabs onto the LEFT (or RIGHT) edge of "
            "the terminal pane and drop it there (a split-preview highlight "
            "appears at the edge).",
            "The pane splits into two side-by-side panels, each with a terminal.",
        )

        self.wait(lambda: self.leaf_count() == 2, what="the drag to create a split")
        assert self.driver.get_state("rootPanel.type") == "split"
        assert self.driver.exists(CLOSE_PANEL)
        self.close_all_tabs()

    # ── Drag tab across groups (MT-TAB-07) ────────────────────────────────────
    def test_drag_tab_across_groups(self):
        """The harness builds a 2-panel split with a tab in the first; the operator
        drags a tab from one panel into the other (a cross-group move); the
        harness asserts the panel that now owns the tab changed."""
        self._reset_to_single_terminal()
        # Create a second panel (group) with its own terminal.
        self.driver.click(SPLIT_H)
        self.wait(lambda: self.leaf_count() == 2, what="two panels")
        self.driver.click(NEW_TERMINAL)
        # Two tabs in the active panel so one can be dragged to the other group.
        self.driver.click(NEW_TERMINAL)
        self.wait(lambda: self.tab_count() >= 3, what="tabs to move across groups")
        before = self.driver.get_state("rootPanel")

        self.manual_step(
            "Drag a tab from one split panel into the CENTER of the OTHER panel "
            "(drop onto the center zone, not an edge).",
            "The tab moves into the other group; the source panel keeps its "
            "remaining tab(s).",
        )

        self.wait(
            lambda: self.driver.get_state("rootPanel") != before,
            what="the panel tree to change after the cross-group move",
        )
        self.close_all_tabs()

    # ── Drag the split divider to resize (MT-TAB-16) ──────────────────────────
    def test_drag_divider_resizes_panels(self):
        """The harness creates a 2-panel split (so the resize handle exists); the
        operator drags the divider; the harness confirms the handle is present.

        The divider (``split-view-resize-handle``) drives react-resizable-panels'
        pointer-based resize; absolute pixel layout is operator-observed."""
        self._reset_to_single_terminal()
        self.driver.click(SPLIT_H)
        self.wait(lambda: self.leaf_count() == 2, what="two panels")
        assert self.driver.exists("split-view-resize-handle"), "no divider to drag"

        self.manual_observe(
            "Drag the vertical divider between the two panels left and right.",
            "The two panels resize smoothly as you drag the divider; the cursor "
            "shows a col-resize handle over it and the layout follows the pointer.",
            label="divider-resize",
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
