"""SFTP file-browser helpers (issue #831).

``SftpUi`` opens the file browser for the active SSH tab and reads its path. It
builds on :class:`~termihub_harness.ui.SidebarUi` (to show the Files view) and
:class:`~termihub_harness.ui.PasswordPromptUi` (SFTP auto-connect may prompt), so
suites combine all three alongside :class:`~termihub_harness.SystemTest`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ..fixtures import SSH_PASSWORD
from .base import HarnessMixin


class SftpUi(HarnessMixin):
    """Open the SFTP browser for the active tab and read its current path."""

    if TYPE_CHECKING:  # borrowed from the mixins suites combine this with
        def switch_to_files_sidebar(self) -> None: ...
        def handle_password_prompt(self, password: str = ...) -> None: ...

    def connect_sftp_browser(self, password: str = SSH_PASSWORD) -> str:
        """Open the file browser for the active SSH tab and wait for its path.

        Switches to the Files sidebar; SFTP auto-connects (prompting for a
        password when none is cached) and the browser follows the terminal's CWD.
        Returns the displayed path.
        """
        self.switch_to_files_sidebar()
        # wait() returns truthy or raises, so no outer guard is needed.
        self.wait(
            lambda: self.driver.exists("password-prompt-input")
            or self.driver.exists("file-browser-current-path"),
            what="the SFTP browser or its password prompt",
        )
        if self.driver.exists("password-prompt-input"):
            self.handle_password_prompt(password)
        return self.wait(
            lambda: self.driver.get_text("file-browser-current-path"),
            what="the file-browser path",
        )

    def file_browser_path(self) -> str:
        """The path currently shown in the file browser (empty if none)."""
        if not self.driver.exists("file-browser-current-path"):
            return ""
        return self.driver.get_text("file-browser-current-path")
