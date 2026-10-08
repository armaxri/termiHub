"""SSH password-prompt infrastructure tests (ported from infrastructure/ssh-password-extended.test.js).

Key auth must not raise a password dialog, and opening the SFTP browser for a
password-auth SSH session loads it (prompting for the password when none is
cached). Both accept the fresh app's host-key prompt (#1959) first, so the
handshake completes and auth actually runs.
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    ConnectionsUi,
    PasswordPromptUi,
    SSH_KEYS_PORT,
    SSH_KEY_PATH,
    SSH_PASSWORD_PORT,
    SSH_USERNAME,
    SftpUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration

HOST = "127.0.0.1"


@pytest.mark.usefixtures("ssh_fixtures")
class TestSshPasswordExtended(
    TerminalUi, TabsUi, SidebarUi, ConnectionsUi, PasswordPromptUi, SftpUi, SystemTest
):
    def test_key_auth_shows_no_password_dialog(self):
        name = unique_name("ssh-key-nopass")
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_KEYS_PORT,
            username=SSH_USERNAME,
            auth_method="key",
            key_path=str(SSH_KEY_PATH),
            connect=True,
        )
        tab = self.wait(lambda: self.find_tab(name), what="the SSH key tab")
        assert tab is not None
        # The fresh app does not trust the fixture's host key yet (#1959). Left
        # unanswered, the handshake stalls and fails with "Unknown server key", so
        # the no-dialog assertion below would pass without auth ever running.
        self.accept_host_key_prompt()
        self.wait(self._terminal_has_output, what="the SSH key session's shell output")
        assert not self.password_prompt_open()

    def test_sftp_prompts_for_password(self):
        name = unique_name("ssh-sftp-pass")
        self.create_ssh_connection(
            name, host=HOST, port=SSH_PASSWORD_PORT, username=SSH_USERNAME, connect=True
        )
        self.handle_password_prompt()
        # Prompt order on a password connect: password -> TCP -> host-key prompt
        # (#1959). Unanswered, the handshake stalls and fails with "Unknown server
        # key"; the tab never gets a session, so the file browser stays "none".
        # This test used to pass only by catching the closing password modal's
        # input in the DOM (#4017).
        self.accept_host_key_prompt()
        self.wait(self.has_terminal, what="the SSH terminal session")
        # ``has_terminal`` only proves the xterm mounted; real shell output proves
        # the session connected.
        self.wait(self._terminal_has_output, what="the SSH session's shell output")

        # Opening the file browser browses the session over SFTP, prompting for a
        # password only when none is cached for it.
        assert self.connect_sftp_browser()

    def _terminal_has_output(self) -> bool:
        return bool(self.driver.read_terminal().strip())
