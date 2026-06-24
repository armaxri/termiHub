"""SSH password-prompt modal helpers (issue #831).

``PasswordPromptUi`` drives the modal that Save & Connect (or an auto-connecting
SFTP browser) raises for password auth. It is a shared dependency of
:class:`~termihub_harness.ui.SshUi` and :class:`~termihub_harness.ui.SftpUi`, and
password-auth suites drive it directly.
"""

from __future__ import annotations

from ..fixtures import SSH_PASSWORD
from .base import HarnessMixin


class PasswordPromptUi(HarnessMixin):
    """Answer, cancel, or query the SSH password prompt."""

    def password_prompt_open(self) -> bool:
        """Whether the SSH password prompt modal is currently open."""
        return bool(self.driver.get_state("passwordPromptOpen"))

    def handle_password_prompt(self, password: str = SSH_PASSWORD) -> None:
        """Wait for the password prompt, enter ``password``, and click Connect."""
        self.wait(
            lambda: self.driver.exists("password-prompt-input"),
            what="the SSH password prompt",
        )
        self.driver.type("password-prompt-input", password)
        self.driver.click("password-prompt-connect")

    def cancel_password_prompt(self) -> None:
        """Dismiss the password prompt without connecting."""
        self.driver.click("password-prompt-cancel")
