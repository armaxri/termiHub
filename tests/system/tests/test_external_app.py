"""Guided-manual tests for external-app & OS integration (issue #917).

Part of the guided-manual epic (#913); builds on the guided-manual mode (#914).
These cover behaviours that **hand off to another application or an OS service
outside the app** — where the bridge can drive the in-app setup and assert the
in-app side, but the final confirmation lives in an external app, an OS store, or
a physical display the in-webview bridge cannot see.

Each test follows the guided-manual contract (#914): the **harness does all the
automatable work** — launch the app, build the connection/file/setting, trigger
the action, and verify whatever is observable in-app (the menu item exists, the
config flag persisted, the session connects) — then hands the operator only the
irreducibly-external step (VS Code launched, the X11 window appeared, the
clipboard pasted) via :meth:`ManualUi.manual_step` / :meth:`manual_confirm`.

Covered:

- **Clipboard** — copy the terminal buffer via the tab menu and via the
  platform copy shortcut, and paste into the terminal (MT-KB-01..04).

The operator-free checks that the VS Code menu item and toolbar action track
``vscodeAvailable`` (MT-FB-16/23) moved to the automated
``test_file_browser_local.py`` (#4928). The hand-offs themselves (Open in VS Code
for local and SFTP files and folders, Open in File Manager, the Setup SSH Agent
tab — MT-FB-04/14/15/21/22, MT-SSH-09) are graded by
``test_external_app_handoffs.py`` through recording PATH shims, and the
forwarded X11 window (MT-XPLAT-03, MT-SSH-15) by ``test_ssh.py`` with
``xdotool`` on Xvfb (#4932). SSH agent auth (MT-SSH-07) runs unattended in
``test_ssh_agent_auth.py`` against a private ssh-agent (#4953).

**OS credential stores (MT-CRED-01/02/03)** live in
``test_guided_credentials.py``: the app has an OS-keychain storage mode (#956),
and those tests check that a saved secret lands in the native store.

Marked ``manual`` + ``integration``, so they **skip** on CI / normal runs and run
only under ``./pytest.sh --manual -k external_app -s`` with an operator.
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    SidebarUi,
    ManualUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    read_os_clipboard,
)

pytestmark = [pytest.mark.integration, pytest.mark.manual]


class TestExternalApp(
    TerminalUi,
    TabsUi,
    SidebarUi,
    ManualUi,
    SystemTest,
):
    """External-app / OS-integration flows: harness sets up + triggers the action
    and verifies the in-app side; the operator confirms the external result."""

    # ── Clipboard copy/paste (MT-KB-01..04) ──────────────────────────────────
    def test_terminal_clipboard_copy_paste(self):
        """Harness copies the terminal buffer via the tab menu and verifies it
        landed on the OS clipboard (machine-checkable); the operator only
        exercises the keyboard copy/paste shortcuts and Ctrl+C interrupt."""
        self.close_all_tabs()
        self.ensure_terminal()
        marker = "CLIPBOARD_MARKER_7731"
        self.run_command(f"echo {marker}")
        self.wait_for_output(marker)

        tab = self.active_tab()
        assert tab is not None
        # Harness-driven copy: the tab context menu copies the whole buffer.
        self.driver.context_menu(f"tab-{tab['id']}")
        self.wait(
            lambda: self.driver.exists("tab-context-copy"),
            what="the tab context menu",
        )
        self.driver.click("tab-context-copy")

        # In-app verification (machine-checkable): the copy must actually land on
        # the OS clipboard. Reading it back catches a silently-failing copy
        # without depending on the operator's paste. The write is async, so poll
        # briefly; the clipboard state is printed either way for diagnosis.
        try:
            self.wait(
                lambda: (marker in (read_os_clipboard() or "")) or None,
                timeout=5.0,
                what=f"{marker!r} on the OS clipboard",
            )
            landed = True
        except AssertionError:
            landed = False
        clip_head = (read_os_clipboard() or "")[:120]
        print(f"[clipboard-check] marker landed on OS clipboard: {landed} · "
              f"content head: {clip_head!r}")
        assert landed, (
            "'Copy All' did not put the terminal buffer on the OS "
            f"clipboard — read back: {clip_head!r}"
        )

        # The copy is now machine-verified above, so the operator is asked only
        # for the irreducibly-manual part: the keyboard copy/paste shortcuts and
        # that plain Ctrl+C still interrupts (xterm key handling + SIGINT).
        self.manual_step(
            "In the terminal: select some text, copy it (Cmd+C, or Ctrl+Shift+C "
            "on Windows/Linux), paste it back (Cmd+V / Ctrl+Shift+V). Then run a "
            "command and press plain Ctrl+C.",
            "Copy and paste worked, and plain Ctrl+C cancelled the command.",
        )
