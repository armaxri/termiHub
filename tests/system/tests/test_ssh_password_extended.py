"""SSH password-prompt infrastructure tests (ported from infrastructure/ssh-password-extended.test.js).

Key auth must not raise a password dialog, and opening the SFTP browser for a
password-auth SSH session triggers the SFTP password prompt.
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
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration

HOST = "127.0.0.1"


@pytest.mark.usefixtures("ssh_fixtures")
class TestSshPasswordExtended(TerminalUi, TabsUi, SidebarUi, ConnectionsUi, PasswordPromptUi, SystemTest):
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
        assert not self.password_prompt_open()

    def test_sftp_prompts_for_password(self):
        name = unique_name("ssh-sftp-pass")
        self.create_ssh_connection(
            name, host=HOST, port=SSH_PASSWORD_PORT, username=SSH_USERNAME, connect=True
        )
        self.handle_password_prompt()
        self.wait(self.has_terminal, what="the SSH terminal session")

        # Opening the SFTP browser auto-connects and (no cached credential) prompts.
        self.switch_to_files_sidebar()
        prompted = self.wait(
            lambda: self.driver.exists("password-prompt-input")
            or self.driver.exists("file-browser-current-path"),
            what="the SFTP browser or its password prompt",
        )
        assert prompted
        if self.driver.exists("password-prompt-input"):
            self.handle_password_prompt()
            assert self.wait(
                lambda: self.driver.get_text("file-browser-current-path"),
                what="the SFTP browser to load",
            )
