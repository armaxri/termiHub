"""Terminal-driving helpers (issue #831).

``TerminalUi`` covers the create/type/read loop nearly every suite needs: make a
terminal exist, send a command, and poll its output. Suites that touch a shell
mix this in alongside :class:`~termihub_harness.SystemTest`.
"""

from __future__ import annotations

from typing import Optional

from ..bridge import BridgeError
from ..systemtest import DEFAULT_WAIT_TIMEOUT
from .base import HarnessMixin
from .lookups import iter_tabs

NEW_TERMINAL = "terminal-view-new-terminal"


class TerminalUi(HarnessMixin):
    """Create a terminal, send commands, and poll its output."""

    def has_terminal(self) -> bool:
        """Whether the **active** tab is a readable terminal.

        Reads the active-tab default (no ``tabId``). SSH/telnet suites poll this
        right after opening a connection, where the just-opened terminal becomes
        the active tab — so "active tab is a terminal" is the signal they want
        (e.g. waiting for a *second* connection's terminal). :meth:`ensure_terminal`
        deliberately does **not** rely on it (see there).
        """
        try:
            self.driver.read_terminal()
            return True
        except BridgeError:
            return False

    def _terminal_buffers(self) -> list[str]:
        """Buffer text of every registered terminal tab, by id (not active-tab).

        Walks the panel tree and reads each tab by its own id, skipping tabs that
        are not terminals or whose xterm is not registered yet (``BridgeError``).
        Reading by id sidesteps the active-tab default, which is the whole point
        for the post-restart focus race in :meth:`ensure_terminal`.
        """
        buffers: list[str] = []
        try:
            tabs = iter_tabs(self.driver.get_state("rootPanel"))
        except BridgeError:
            return buffers
        for tab in tabs:
            tab_id = tab.get("id")
            if not tab_id:
                continue
            try:
                buffers.append(self.driver.read_terminal(tab_id))
            except BridgeError:
                continue
        return buffers

    def ensure_terminal(self) -> None:
        """Make sure a terminal exists and its shell has printed a prompt.

        Polls terminal tabs **by id** rather than the active-tab default: right
        after :meth:`~termihub_harness.SystemTest.restart_app` the freshly-spawned
        terminal can briefly not be the active tab, so reading the active tab
        (``read_terminal()`` with no id) sees an empty/other buffer and times out
        even though the shell has already started (#867). Accepting a prompt on
        any terminal tab sidesteps that focus race. A non-empty buffer already
        implies a terminal exists, so a single wait covers both conditions.
        """
        if not self._terminal_buffers():
            self.driver.click(NEW_TERMINAL)
        self.wait(
            lambda: any(buf.strip() for buf in self._terminal_buffers()),
            what="a terminal with a shell prompt",
        )

    def open_new_terminal(self) -> None:
        """Click the toolbar "new terminal" button to open another terminal tab.

        Unlike :meth:`ensure_terminal` (which creates the *first* terminal only if
        none exists), this always opens an additional one — the primitive the
        performance suite uses to stand up many concurrent terminals.
        """
        self.driver.click(NEW_TERMINAL)

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
