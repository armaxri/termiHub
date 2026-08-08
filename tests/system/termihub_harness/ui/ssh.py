"""High-level SSH connect flow (issue #831).

``SshUi`` is the one-call "create + Save & Connect + answer prompt + wait for the
terminal" sequence nearly every SSH suite repeats. It composes
:class:`~termihub_harness.ui.ConnectionsUi` (editor),
:class:`~termihub_harness.ui.PasswordPromptUi` (the modal) and
:class:`~termihub_harness.ui.TerminalUi` (the session), so suites mix all of
those in alongside :class:`~termihub_harness.SystemTest`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ..fixtures import SSH_HOST, SSH_PASSWORD_PORT, SSH_USERNAME
from .base import HarnessMixin


class SshUi(HarnessMixin):
    """The repeated password-SSH connect-and-land-in-a-terminal flow."""

    if TYPE_CHECKING:  # borrowed from the mixins suites combine this with
        def create_ssh_connection(self, name: str, *, host: str, port: int, username: str,
                                  auth_method: str = ..., key_path=..., connect: bool = ...) -> None: ...
        def handle_password_prompt(self, password: str = ...) -> None: ...
        def accept_host_key_prompt(self, *, remember: bool = ..., timeout: float = ...) -> bool: ...
        def has_terminal(self) -> bool: ...

    def connect_ssh_password(self, name: str, *, port: int = SSH_PASSWORD_PORT) -> None:
        """Create + Save & Connect a password SSH connection, answer the prompt,
        and wait for its terminal — the sequence nearly every SSH suite repeats.

        Accepts the host-key trust prompt (#1959) that the first connect to a
        fresh app instance's untrusted host raises mid-handshake: without it the
        connection hangs and no session is ever established (#2398 / #2447).
        """
        self.create_ssh_connection(
            name, host=SSH_HOST, port=port, username=SSH_USERNAME, connect=True
        )
        self.handle_password_prompt()
        self.accept_host_key_prompt()
        self.wait(self.has_terminal, what="the SSH terminal session")
