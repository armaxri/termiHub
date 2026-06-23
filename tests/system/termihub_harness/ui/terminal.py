"""Terminal-driving helpers (issue #831).

``TerminalUi`` covers the create/type/read loop nearly every suite needs: make a
terminal exist, send a command, and poll its output. Suites that touch a shell
mix this in alongside :class:`~termihub_harness.SystemTest`.
"""

from __future__ import annotations

from typing import Optional

from ..bridge import BridgeError
from .base import HarnessMixin

DEFAULT_WAIT_TIMEOUT = 20.0


class TerminalUi(HarnessMixin):
    """Create a terminal, send commands, and poll its output."""

    def has_terminal(self) -> bool:
        """Whether a readable terminal currently exists."""
        try:
            self.driver.read_terminal()
            return True
        except BridgeError:
            return False

    def ensure_terminal(self) -> None:
        """Make sure a terminal exists and its shell has printed a prompt."""
        if not self.has_terminal():
            self.driver.click("terminal-view-new-terminal")
        self.wait(self.has_terminal, what="a terminal to exist")
        self.wait(lambda: self.driver.read_terminal().strip() != "", what="the shell prompt")

    def run_command(self, command: str) -> None:
        """Type a command into the active terminal (a newline is appended).

        Retries while the backend session is still registering: an SSH session
        connects asynchronously, so the terminal buffer can be readable a moment
        before its session accepts input. A failed send transmits nothing, so the
        retry never double-sends.
        """
        self.wait(
            lambda: self._send_terminal_input(command),
            what="the terminal session to accept input",
        )

    def _send_terminal_input(self, command: str) -> bool:
        """``driver.terminal_input`` that returns True, for :meth:`wait`."""
        self.driver.terminal_input(command)
        return True

    def wait_for_output(
        self, needle: str, *, tab_id: Optional[str] = None, timeout: float = DEFAULT_WAIT_TIMEOUT
    ) -> str:
        """Poll a terminal until it contains ``needle``; return the full text.

        Reads the active terminal unless ``tab_id`` names a specific one.
        """
        return self.wait(
            lambda: (lambda t: t if needle in t else None)(self.driver.read_terminal(tab_id)),
            timeout=timeout,
            what=f"{needle!r} in terminal output",
        )
