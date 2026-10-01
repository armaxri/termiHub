"""Jump-host (ProxyJump) connection helpers (MT-SSH-44, issue #3688).

``JumpHostUi`` fills the connection editor's **Jump Host** section — the
``jump-host-enabled`` toggle plus the inline hop fields that
``JumpHostEntry`` renders through the schema-driven ``DynamicField`` with the
per-hop test ids ``jump-host-<field>-<index>`` — and creates an SSH connection
that reaches its target through one inline bastion hop. Compose it with
:class:`~termihub_harness.ui.ConnectionsUi` (the editor) and
:class:`~termihub_harness.ui.PasswordPromptUi` (the host-key prompts).
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Callable, Optional, Union

from ..fixtures import SSH_HOST, SSH_USERNAME
from .base import HarnessMixin


def jump_host_field_testid(field: str, index: int = 0) -> str:
    """Test id of an inline hop field (``JumpHostEntry``'s ``tid`` helper)."""
    return f"jump-host-{field}-{index}"


class JumpHostUi(HarnessMixin):
    """Create SSH connections that reach their target through a bastion hop."""

    #: The "Connect through a jump host" checkbox of the Jump Host section.
    JUMP_HOST_ENABLED = "jump-host-enabled"

    if TYPE_CHECKING:  # borrowed from the mixins suites combine this with
        def create_ssh_connection(self, name: str, *, host: str, port: int, username: str,
                                  auth_method: str = ..., key_path=...,
                                  save_password: bool = ..., auto_reconnect: bool = ...,
                                  connect: bool = ...,
                                  before_save: Optional[Callable[[], None]] = ...) -> None: ...
        def accept_host_key_prompt(self, *, remember: bool = ..., timeout: float = ...) -> bool: ...

    def fill_jump_host(
        self,
        *,
        host: str,
        port: int,
        username: str = SSH_USERNAME,
        key_path: Union[str, Path],
        index: int = 0,
    ) -> None:
        """Enable the Jump Host section and fill hop ``index`` inline, key auth.

        A fresh hop defaults to inline configuration, port 22 and key auth
        (``defaultHop`` in ``JumpHostSection``), so only host, port, username and
        the key path are typed. The key-path field is a ``KeyPathInput`` whose
        input id carries the ``-key-path-input`` suffix, like the main form's.
        """
        if index == 0:
            self.wait(
                lambda: self.driver.exists(self.JUMP_HOST_ENABLED),
                what="the Jump Host section",
            )
            self.driver.click(self.JUMP_HOST_ENABLED)
        host_field = jump_host_field_testid("host", index)
        self.wait(lambda: self.driver.exists(host_field), what=f"the jump-host hop {index} fields")
        self.driver.type(host_field, host)
        self.driver.type(jump_host_field_testid("port", index), str(port))
        self.driver.type(jump_host_field_testid("username", index), username)
        key_input = f"{jump_host_field_testid('key-path', index)}-key-path-input"
        self.wait(lambda: self.driver.exists(key_input), what=f"the jump-host hop {index} key path")
        self.driver.type(key_input, str(key_path))

    def create_jump_host_connection(
        self,
        name: str,
        *,
        target_host: str,
        target_port: int,
        bastion_port: int,
        key_path: Union[str, Path],
        bastion_host: str = SSH_HOST,
        username: str = SSH_USERNAME,
        auto_reconnect: bool = True,
        connect: bool = False,
    ) -> None:
        """Create a key-auth SSH connection to ``target_host`` through one inline
        bastion hop, then Save (or Save & Connect).

        Both the bastion and the target authenticate with ``key_path``.
        """
        self.create_ssh_connection(
            name,
            host=target_host,
            port=target_port,
            username=username,
            auth_method="key",
            key_path=str(key_path),
            auto_reconnect=auto_reconnect,
            connect=connect,
            before_save=lambda: self.fill_jump_host(
                host=bastion_host, port=bastion_port, username=username, key_path=key_path
            ),
        )

    def accept_jump_host_key_prompts(self, *, max_prompts: int = 2) -> int:
        """Accept the host-key trust prompt of each untrusted host in the chain.

        A jump-host connect verifies the bastion's key and then the target's, so
        a fresh app instance raises up to one prompt per hop plus the target.
        Stops at the first wait that sees no prompt (the chain completed, or the
        hosts are already trusted). Returns how many prompts it accepted.
        """
        accepted = 0
        while accepted < max_prompts and self.accept_host_key_prompt():
            accepted += 1
        return accepted
