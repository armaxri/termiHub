"""Worked examples of guided-manual tests (issue #914).

These prove the defining property of guided-manual mode: the **harness does the
automatable setup** (launch the app, build connections/state through the usual
mixins) and only the *irreducibly-manual* bit is handed to a human. They are the
template to copy when migrating a ``tests/manual/*.yaml`` item that benefits from
harness setup.

Each is marked ``manual`` (and ``integration``, since it drives the real app), so
on CI / AI-agent / normal runs they **skip** — ``--manual`` plus an interactive
TTY is required to run them. Launch with, e.g.::

    ./pytest.sh --manual -k native_dialog -s
"""

import pytest

from termihub_harness import (
    ConnectionsUi,
    ManualUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = [pytest.mark.integration, pytest.mark.manual]


class TestGuidedManualExamples(
    TerminalUi, TabsUi, ConnectionsUi, SidebarUi, ManualUi, SystemTest
):
    """Three worked guided-manual tests: one visual, one native-dialog, one yes/no."""

    # ── Visual carve-out: the bridge can't read the GPU canvas ───────────────
    def test_ansi_colors_render(self):
        """Harness opens a shell and prints colored output; operator eyeballs it.

        Color fidelity lives in the xterm canvas, which the bridge can't read —
        exactly the kind of visual check that stays manual. :meth:`manual_observe`
        will attach a screenshot once the bridge gains the verb (#900).
        """
        self.close_all_tabs()
        self.ensure_terminal()
        # A red FAIL / green OK pair — automatable to *emit*, not to *see*.
        self.run_command(
            "printf '\\033[31mRED-FAIL\\033[0m \\033[32mGREEN-OK\\033[0m\\n'"
        )
        self.wait_for_output("GREEN-OK")
        self.manual_observe(
            "Look at the terminal output line.",
            "‘RED-FAIL’ is red and ‘GREEN-OK’ is green, with no rendering artifacts.",
            label="ansi-colors",
        )

    # ── Native-dialog carve-out: the OS save dialog is outside the webview ───
    def test_export_connections_native_dialog(self):
        """Harness creates a connection; operator drives the native Save dialog.

        The export menu and dialog title are E2E-testable, but the **native OS
        save dialog** (and that a real JSON file lands on disk) is not reachable
        from the in-webview bridge — so the harness sets up the exportable state
        and the operator performs the save.
        """
        self.close_all_tabs()
        name = unique_name("export-demo")
        self.create_local_connection(name)
        self.switch_to_connections_sidebar()
        self.manual_step(
            f"Open the sidebar ⋯ menu and choose ‘Export Connections’, then save "
            f"to a location you can find. The connection ‘{name}’ exists to export.",
            "A native Save dialog appears; choosing a path writes a JSON file "
            "containing the connection.",
        )

    # ── Yes/no carve-out: cursor blink is a timing/visual property ───────────
    def test_terminal_cursor_blinks(self):
        """Harness opens a shell; operator confirms the cursor blinks (yes/no)."""
        self.close_all_tabs()
        self.ensure_terminal()
        assert self.manual_confirm(
            "Watch the terminal cursor for a couple of seconds — does it blink?"
        )
