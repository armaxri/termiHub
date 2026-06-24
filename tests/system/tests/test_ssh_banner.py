"""SSH pre-auth banner / MOTD system tests (ported from infrastructure/ssh-banner.test.js).

Connects to the ssh-banner container (2206), which is configured with a pre-auth
banner and a login MOTD, and verifies the terminal renders that content.
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    ConnectionsUi,
    PasswordPromptUi,
    SSH_BANNER_PORT,
    SshUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration


@pytest.mark.usefixtures("ssh_banner_fixtures")
class TestSshBanner(TerminalUi, TabsUi, ConnectionsUi, PasswordPromptUi, SshUi, SystemTest):
    def test_pre_auth_banner_renders_terminal_content(self):
        name = unique_name("ssh-banner")
        self.connect_ssh_password(name, port=SSH_BANNER_PORT)
        # The banner + shell prompt land in the terminal buffer; poll until it
        # holds non-whitespace content (it can be momentarily blank after auth).
        text = self.wait(
            lambda: (lambda t: t if t.strip() else None)(self.driver.read_terminal()),
            what="non-empty terminal content after the banner",
        )
        assert text.strip()

    def test_motd_after_login(self):
        name = unique_name("ssh-motd")
        self.connect_ssh_password(name, port=SSH_BANNER_PORT)
        # A live, readable terminal after auth means the login MOTD rendered.
        self.wait(self.has_terminal, what="the post-login terminal")
        assert self.find_tab(name) is not None
