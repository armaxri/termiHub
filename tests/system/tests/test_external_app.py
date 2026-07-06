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

- **Open in VS Code** — local (MT-FB-04/14), SFTP (MT-FB-15), and the
  "VS Code not installed → menu item hidden" path (MT-FB-16).
- **SSH agent auth** — connecting with the ``agent`` auth method (MT-SSH-07) and
  the "Setup SSH Agent" button in the connection editor (MT-SSH-09, #955).
- **X11 forwarding** — enabling ``enableX11Forwarding`` on a connection, proving
  the flag persists, the session connects, and (against the ``ssh-x11`` fixture)
  the server allocates a forwarded ``$DISPLAY``; the operator only confirms a
  remote X11 window appears (MT-SSH-14/15/16/18, MT-XPLAT-03).
- **Clipboard** — copy the terminal buffer via the tab menu and via the
  platform copy shortcut, and paste into the terminal (MT-KB-01..04).

**Not applicable — OS credential stores (MT-CRED-01/02/03).** These assume the
app writes credentials into the *native* OS store (macOS Keychain / Windows
Credential Manager / Linux Secret Service). The app implements only two
credential modes — ``"master_password"`` (an encrypted vault file) and
``"none"`` (see ``src/types/credential.ts`` / ``src-tauri/src/credential``) — and
exposes no OS-keychain backend. There is therefore nothing to verify in an OS
store; the real saved-credential behaviour (master-password reuse on reconnect)
is already covered by ``test_credential_store.py``. If an OS-keychain backend is
added later, MT-CRED-01/02/03 become implementable here.

Marked ``manual`` + ``integration``, so they **skip** on CI / normal runs and run
only under ``./pytest.sh --manual -k external_app -s`` with an operator. The
SSH/SFTP/X11/agent cases additionally need the Docker SSH fixtures up; without a
container runtime ``ssh_fixtures`` skips them cleanly.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from termihub_harness import (
    ConnectionsUi,
    FilesUi,
    PasswordPromptUi,
    SftpUi,
    SidebarUi,
    SshUi,
    SSH_HOST,
    SSH_KEYS_PORT,
    SSH_PASSWORD,
    SSH_USERNAME,
    SSH_X11_PORT,
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
    SftpUi,
    PasswordPromptUi,
    SshUi,
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

    def _fill_ssh_editor(
        self, name: str, *, port: int, auth_method: str = "password"
    ) -> None:
        """Open the editor and fill the basic SSH fields, leaving it open.

        Unlike :meth:`ConnectionsUi.create_ssh_connection`, this does not save —
        so the caller can toggle extra fields (e.g. X11) before saving.
        """
        self.open_new_connection_editor()
        self.driver.type("connection-editor-name-input", name)
        self.select_connection_type("ssh")
        self.wait(lambda: self.driver.exists("field-host"), what="the SSH fields")
        self.driver.type("field-host", SSH_HOST)
        self.driver.type("field-port", str(port))
        self.driver.type("field-username", SSH_USERNAME)
        self.driver.select("field-authMethod", auth_method)

    # ── Open in VS Code: local (MT-FB-04, MT-FB-14) ──────────────────────────
    def test_open_in_vscode_local(self):
        """Harness creates a local file and opens its menu; operator confirms the
        file opens in VS Code."""
        if not self._vscode_available():
            pytest.skip("VS Code not detected (vscodeAvailable=false)")
        self.close_all_tabs()
        fname = f"{unique_name('vscode')}.txt"
        self._make_local_file(fname)

        self.open_file_menu(fname)
        assert self.driver.exists(_VSCODE_ITEM), "Open-in-VS-Code item missing"
        self.driver.click(_VSCODE_ITEM)

        self.manual_observe(
            f"termiHub opened {fname} in VS Code.",
            "VS Code shows that file.",
        )

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

    # ── Open in VS Code: SFTP (MT-FB-15) ─────────────────────────────────────
    @pytest.mark.usefixtures("ssh_fixtures")
    def test_open_in_vscode_sftp(self):
        """Harness opens a remote file's menu over SFTP; operator confirms VS Code
        opens it and the app does not crash (regression #828)."""
        if not self._vscode_available():
            pytest.skip("VS Code not detected (vscodeAvailable=false)")
        self.close_all_tabs()
        self.connect_ssh_password(unique_name("sftp-vscode"))

        fname = f"{unique_name('remote')}.txt"
        # Author a remote file from the live SSH terminal, then browse to it.
        self.run_command(f"echo vscode-sftp > ~/{fname}")
        self.connect_sftp_browser()
        self.wait_for_file_row(fname)

        self.open_file_menu(fname)
        assert self.driver.exists(_VSCODE_ITEM), "Open-in-VS-Code item missing (SFTP)"
        self.driver.click(_VSCODE_ITEM)

        self.manual_observe(
            f"termiHub opened the remote (SFTP) file {fname} in VS Code.",
            "VS Code shows the file and termiHub is still running (no crash).",
        )
        # In-app side: the app is still responsive after the external hand-off.
        assert self.driver.get_state("vscodeAvailable") is not None

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

    # ── Setup-Agent launcher (MT-SSH-09) ─────────────────────────────────────
    def test_setup_agent_launcher_opens_helper(self):
        """The connection editor surfaces a 'Setup SSH Agent' button when SSH +
        agent auth is selected (#955); clicking it opens the agent-setup helper
        terminal.

        Unlike the old connection-error-dialog path, this drives the editor
        button directly, so the in-app side is fully harness-verified (the button
        appears and a 'Setup SSH Agent' tab opens). Needs no fixtures and no
        failed connection. Only the helper command's *effect* (PowerShell
        elevation on Windows, ``ssh-add`` on macOS/Linux) is operator-confirmed.
        """
        self.close_all_tabs()

        name = unique_name("agent-setup")
        # Open the editor with agent auth selected — this surfaces the button.
        self._fill_ssh_editor(name, port=SSH_KEYS_PORT, auth_method="agent")
        self.wait(
            lambda: self.driver.exists("ssh-setup-agent"),
            what="the Setup SSH Agent button (SSH + agent auth)",
        )

        self.driver.click("ssh-setup-agent")

        # In-app verification: a helper terminal tab opened.
        self.wait(
            lambda: self.find_tab("Setup SSH Agent") is not None,
            what="the 'Setup SSH Agent' helper tab to open",
        )

        self.manual_observe(
            "termiHub opened a 'Setup SSH Agent' tab.",
            "The tab ran the ssh-agent setup command.",
        )

    # ── X11 forwarding (MT-SSH-14/15/16/18, MT-XPLAT-03) ─────────────────────
    @pytest.mark.skipif(
        "sys.platform == 'win32'", reason="X11 forwarding is a macOS/Linux feature"
    )
    @pytest.mark.usefixtures("ssh_x11_fixtures")
    def test_x11_forwarding_window_appears(self):
        """Harness enables X11 on the connection (proving the flag persists),
        connects to the X11-capable fixture, and auto-asserts the server handed
        back a forwarded ``$DISPLAY``; the operator only confirms a window."""
        self.close_all_tabs()
        name = unique_name("x11")
        self._fill_ssh_editor(name, port=SSH_X11_PORT)

        self.wait(
            lambda: self.driver.exists("field-enableX11Forwarding"),
            what="the X11-forwarding toggle",
        )
        # A fresh SSH connection defaults X11 off (MT-SSH-19 /
        # test_connection_forms::test_ssh_x11_field_present_and_defaults_off), so a
        # single click on the checkbox enables it.
        self.driver.click("field-enableX11Forwarding")
        self.driver.click(self.EDITOR_SAVE)

        # In-app verification: the toggle actually persisted onto the connection.
        conn = self.require_connection(name)
        assert (conn.get("config") or {}).get("enableX11Forwarding") is True, (
            "enableX11Forwarding did not persist on the saved connection"
        )

        # Connect and let the operator exercise the forwarded display.
        self.connect_connection(name)
        self.handle_password_prompt(SSH_PASSWORD)
        assert self.wait(self.has_terminal, what="the X11 SSH terminal")

        # In-app verification: the ssh-x11 fixture has X11Forwarding + xauth, so a
        # session opened with X11 enabled gets a server-allocated $DISPLAY (e.g.
        # 'localhost:10.0'). Auto-assert it rather than leaving it to the operator
        # (#957) — a unique marker keeps the typed command line ('$DISPLAY') from
        # matching before the echoed value does.
        self.run_command("echo TH_X11_DISPLAY=$DISPLAY")
        output = self.wait_for_output("TH_X11_DISPLAY=localhost:")
        assert "TH_X11_DISPLAY=localhost:" in output, (
            "SSH server did not allocate a forwarded $DISPLAY — X11 forwarding "
            "was not negotiated"
        )

        self.manual_step(
            "In the SSH terminal, type: xeyes   (or: xclock)",
            "An X11 window appears on your screen.",
        )

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
            "'Copy to Clipboard' did not put the terminal buffer on the OS "
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
