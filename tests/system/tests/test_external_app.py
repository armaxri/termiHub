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

- **VS Code availability** — the file-row "Open in VS Code" item (MT-FB-16) and
  the toolbar "open folder in VS Code" action (MT-FB-23, #2656) both track
  ``vscodeAvailable``.
- **SSH agent auth** — connecting with the ``agent`` auth method (MT-SSH-07).
- **Clipboard** — copy the terminal buffer via the tab menu and via the
  platform copy shortcut, and paste into the terminal (MT-KB-01..04).

The hand-offs themselves (Open in VS Code for local and SFTP files and folders,
Open in File Manager, the Setup SSH Agent tab — MT-FB-04/14/15/21/22,
MT-SSH-09) are graded automatically by ``test_external_app_handoffs.py`` through
recording PATH shims, and the forwarded X11 window (MT-XPLAT-03) by
``test_ssh.py`` with ``xdotool`` on Xvfb (#4932).

**OS credential stores (MT-CRED-01/02/03)** live in
``test_guided_credentials.py``: the app has an OS-keychain storage mode (#956),
and those tests check that a saved secret lands in the native store.

Marked ``manual`` + ``integration``, so they **skip** on CI / normal runs and run
only under ``./pytest.sh --manual -k external_app -s`` with an operator. The
SSH agent case additionally needs the Docker SSH fixtures up; without a
container runtime ``ssh_fixtures`` skips them cleanly.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from termihub_harness import (
    ConnectionsUi,
    FilesUi,
    SidebarUi,
    SSH_HOST,
    SSH_KEYS_PORT,
    SSH_USERNAME,
    ManualUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    agent_has_key,
    read_os_clipboard,
    unique_name,
)

pytestmark = [pytest.mark.integration, pytest.mark.manual]

#: The agent-auth key the operator is asked to load into their ssh-agent; the
#: ``ssh-keys`` fixture container (port 2203) authorizes it.
_AGENT_KEY_FIXTURE = (
    Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "ssh-keys" / "ed25519"
)

#: VS Code context-menu item on a file row (rendered only when VS Code is found).
_VSCODE_ITEM = "context-file-vscode"


class TestExternalApp(
    TerminalUi,
    TabsUi,
    ConnectionsUi,
    SidebarUi,
    FilesUi,
    ManualUi,
    SystemTest,
):
    """External-app / OS-integration flows: harness sets up + triggers the action
    and verifies the in-app side; the operator confirms the external result."""

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _vscode_available(self) -> bool:
        """Whether the app detected a VS Code install (drives the menu item)."""
        return bool(self.driver.get_state("vscodeAvailable"))

    def _make_local_file(self, name: str) -> None:
        """Open a local terminal's file browser and create a file in it."""
        self.ensure_terminal()
        self.open_file_browser()
        self.create_file_via_browser(name)

    # ── Open in VS Code: menu hidden when unavailable (MT-FB-16) ──────────────
    def test_vscode_menu_item_matches_availability(self):
        """The 'Open in VS Code' item is present iff the app detected VS Code.

        Fully harness-verified (no operator step): the item's presence must track
        ``vscodeAvailable``, which is exactly MT-FB-16's "menu item hidden" claim
        plus its inverse.
        """
        self.close_all_tabs()
        fname = f"{unique_name('vscode-avail')}.txt"
        self._make_local_file(fname)

        self.open_file_menu(fname)
        assert self.driver.exists(_VSCODE_ITEM) == self._vscode_available(), (
            "VS Code menu item presence does not match vscodeAvailable"
        )
        self.dismiss_menu()

    # ── Open-folder-in-VS-Code toolbar tracks availability (MT-FB-23, #2656) ──
    def test_open_folder_vscode_toolbar_matches_availability(self):
        """The toolbar "open folder in VS Code" action is present iff the app
        detected VS Code. The file-manager action is always present locally.

        Fully harness-verified (no operator step).
        """
        self.close_all_tabs()
        self.ensure_terminal()
        self.open_file_browser()

        assert self.driver.exists(self.OPEN_IN_EXPLORER), (
            "file-manager toolbar action should always be present in local mode"
        )
        assert self.driver.exists(self.OPEN_FOLDER_VSCODE) == self._vscode_available(), (
            "VS Code toolbar action presence does not match vscodeAvailable"
        )

    # ── SSH agent auth connects (MT-SSH-07) ──────────────────────────────────
    @pytest.mark.usefixtures("ssh_fixtures")
    def test_ssh_agent_auth_connects(self):
        """Harness connects with the ``agent`` auth method and asserts a terminal
        comes up — no password, no key path.

        The precondition (the fixture key loaded into the operator's ssh-agent)
        is *checked* programmatically rather than prompted: agent auth is only
        possible if the agent holds that key, and that is machine-verifiable via
        ``ssh-add -l`` fingerprints. So the test runs unattended when the key is
        present and skips with the exact ``ssh-add`` command when it is not —
        instead of gating an operator on a step a machine can confirm (#957).
        """
        self.close_all_tabs()
        if not agent_has_key(_AGENT_KEY_FIXTURE):
            pytest.skip(
                "ssh-agent has not loaded the fixture key — run:\n"
                f"      ssh-add {_AGENT_KEY_FIXTURE}\n"
                "(authorized by the ssh-keys fixture container), then re-run."
            )

        name = unique_name("agent-auth")
        self.create_ssh_connection(
            name,
            host=SSH_HOST,
            port=SSH_KEYS_PORT,
            username=SSH_USERNAME,
            auth_method="agent",
            connect=True,
        )
        # Agent auth needs no prompt — the session should establish on its own.
        assert self.wait(self.has_terminal, what="the agent-authenticated terminal")

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
