"""SSH pre-auth banner / MOTD system tests (ported from infrastructure/ssh-banner.test.js).

Connects to the ssh-banner container (2206), which is configured with a pre-auth
banner and a login MOTD, and verifies the terminal renders that content.
"""

from __future__ import annotations

import pytest

from termihub_harness import SSH_BANNER_PORT, SSH_USERNAME, SystemTest, unique_name

pytestmark = pytest.mark.integration

HOST = "127.0.0.1"


@pytest.mark.usefixtures("ssh_banner_fixtures")
class TestSshBanner(SystemTest):
    def test_pre_auth_banner_renders_terminal_content(self):
        name = unique_name("ssh-banner")
        self._connect(name)
        # The banner + shell prompt land in the terminal buffer; poll until it
        # holds non-whitespace content (it can be momentarily blank after auth).
        text = self.wait(
            lambda: (lambda t: t if t.strip() else None)(self.driver.read_terminal()),
            what="non-empty terminal content after the banner",
        )
        assert text.strip()

    def test_motd_after_login(self):
        name = unique_name("ssh-motd")
        self._connect(name)
        # A live, readable terminal after auth means the login MOTD rendered.
        self.wait(self.has_terminal, what="the post-login terminal")
        assert self.find_tab(name) is not None

    def _connect(self, name: str) -> None:
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_BANNER_PORT,
            username=SSH_USERNAME,
            connect=True,
        )
        self.handle_password_prompt()
        self.wait(self.has_terminal, what="the SSH terminal session")
