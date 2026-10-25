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

- **OS file drop onto a pane** (MT-UI-34) — native drag-drop coordinates; harness
  prepares the file + terminal, the operator drops and confirms the path lands.

Retired to real OS input (#4935): the right-click menu vs Quick Copy/Paste
(MT-UI-26/27/28/30), dragging a connection into a folder (MT-CONN-01) and an
editor tab between panels (MT-FB-20) are graded with real OS pointer events
aimed at the test instance's PID in ``test_os_input_pointer.py``.

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

import pytest

from termihub_harness import ManualUi, SystemTest, TabsUi, TerminalUi

pytestmark = [pytest.mark.integration, pytest.mark.manual]


class TestInputRouting(TerminalUi, TabsUi, ManualUi, SystemTest):
    """Real-input & DnD flows: harness builds + asserts the state, operator
    performs the gesture the synthetic bridge cannot reproduce."""

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _scratch_file(self, prefix: str, name: str, contents: str) -> Path:
        """Write a throwaway file the operator drops / drags, returning its path."""
        target = Path(tempfile.mkdtemp(prefix=f"thub-{prefix}-")) / name
        target.write_text(contents, encoding="utf-8")
        return target

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
