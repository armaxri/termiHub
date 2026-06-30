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
  the "Setup Agent" launcher in the connection-error dialog (MT-SSH-09).
- **X11 forwarding** — enabling ``enableX11Forwarding`` on a connection, proving
  the flag persists and the session connects, then confirming a remote X11 window
  appears (MT-SSH-14/15/16/18, MT-XPLAT-03).
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
    SSH_PASSWORD_PORT,
    SSH_USERNAME,
    ManualUi,
    SystemTest,
    TabsUi,
    TerminalUi,
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

        self.manual_step(
            f"termiHub just issued 'Open in VS Code' for the local file {fname!r}.",
            "VS Code opens (or focuses) with that file.",
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

        self.manual_step(
            f"termiHub issued 'Open in VS Code' for the remote (SFTP) file {fname!r}.",
            "VS Code opens with the downloaded file and termiHub keeps running "
            "(no crash — regression #828).",
        )
        # In-app side: the app is still responsive after the external hand-off.
        assert self.driver.get_state("vscodeAvailable") is not None

    # ── SSH agent auth connects (MT-SSH-07) ──────────────────────────────────
    @pytest.mark.usefixtures("ssh_fixtures")
    def test_ssh_agent_auth_connects(self):
        """Operator loads the fixture key into their agent; harness connects with
        the ``agent`` auth method and asserts a terminal comes up — no password,
        no key path."""
        self.close_all_tabs()
        self.manual_step(
            "Ensure an ssh-agent is running with this key loaded:\n"
            f"      ssh-add {_AGENT_KEY_FIXTURE}\n"
            "(this key is authorized by the ssh-keys fixture container).",
            "ssh-add reports the key is added.",
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
    @pytest.mark.usefixtures("ssh_fixtures")
    def test_setup_agent_launcher_opens_helper(self):
        """A failed agent connection surfaces the connection-error dialog with a
        'Setup Agent' button; clicking it opens the agent-setup helper.

        The helper is a Windows PowerShell elevation flow (MT-SSH-09); on a host
        where the button is not rendered, this skips.
        """
        self.close_all_tabs()
        self.manual_step(
            "Ensure NO ssh-agent key is loaded for the fixture host (so agent auth "
            "fails):\n      ssh-add -D",
            "ssh-add reports all identities removed.",
        )

        name = unique_name("agent-setup")
        self.create_ssh_connection(
            name,
            host=SSH_HOST,
            port=SSH_KEYS_PORT,
            username=SSH_USERNAME,
            auth_method="agent",
            connect=True,
        )
        self.wait(
            lambda: self.driver.exists("connection-error-setup-agent")
            or self.driver.exists("connection-error-close"),
            what="the connection-error dialog",
        )
        if not self.driver.exists("connection-error-setup-agent"):
            pytest.skip("Setup-Agent button not offered on this platform")

        self.driver.click("connection-error-setup-agent")
        self.manual_step(
            "termiHub clicked 'Setup Agent'.",
            "A local helper tab/terminal opens running the SSH-agent setup command "
            "(PowerShell elevation on Windows).",
        )

    # ── X11 forwarding (MT-SSH-14/15/16/18, MT-XPLAT-03) ─────────────────────
    @pytest.mark.skipif(
        "sys.platform == 'win32'", reason="X11 forwarding is a macOS/Linux feature"
    )
    @pytest.mark.usefixtures("ssh_fixtures")
    def test_x11_forwarding_window_appears(self):
        """Harness enables X11 on the connection (proving the flag persists) and
        connects; operator runs an X11 app and confirms a window appears."""
        self.close_all_tabs()
        name = unique_name("x11")
        self._fill_ssh_editor(name, port=SSH_PASSWORD_PORT)

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
        self.run_command("echo DISPLAY=$DISPLAY")

        self.manual_step(
            "In the SSH terminal (X11 forwarding is enabled), with a local X server "
            "running (XQuartz on macOS), run an X11 app, e.g.:\n"
            "      xeyes   (or: xclock)\n"
            "Note: $DISPLAY was just echoed above — it should read like "
            "'localhost:10.0'.",
            "An X11 window (xeyes/xclock) appears on your local display.",
        )

    # ── Clipboard copy/paste (MT-KB-01..04) ──────────────────────────────────
    def test_terminal_clipboard_copy_paste(self):
        """Harness copies the terminal buffer via the tab menu; operator pastes it
        out, then exercises the platform copy/paste shortcuts on a selection."""
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

        self.manual_step(
            "termiHub copied the terminal buffer to the clipboard (tab menu → "
            "Copy to Clipboard). Paste into any external editor.",
            f"The pasted text contains {marker!r}.",
        )

        self.manual_step(
            "Now test the keyboard shortcuts directly in the terminal:\n"
            "  1. Select some terminal text with the mouse.\n"
            "  2. Copy it — macOS: Cmd+C   ·   Windows/Linux: Ctrl+Shift+C.\n"
            "  3. Paste it back — macOS: Cmd+V   ·   Windows/Linux: Ctrl+Shift+V.\n"
            "  4. Confirm plain Ctrl+C (no Shift) still sends SIGINT (cancels a "
            "running command).",
            "Copy/paste use the platform shortcut, and Ctrl+C still interrupts.",
        )
