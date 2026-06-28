"""Cross-platform file authoring through the terminal (#886).

``ShellFsUi`` wraps :class:`~termihub_harness.shell.ShellCommands` so a suite can
author and clean up files **through the active shell** without hard-coding POSIX
syntax — the helper emits the right command for the host's default shell (POSIX,
or PowerShell on Windows). Each path is taken relative to the shell's home
directory (the one a fresh terminal reliably shows).

Mixes in alongside :class:`~termihub_harness.ui.TerminalUi` (it drives
``run_command``) and :class:`~termihub_harness.SystemTest`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from ..shell import ShellCommands
from .base import HarnessMixin


class ShellFsUi(HarnessMixin):
    """Author/remove files in the shell's home dir, cross-platform."""

    _shell_commands: Optional[ShellCommands] = None

    if TYPE_CHECKING:  # provided by TerminalUi, with which suites combine this
        def run_command(self, command: str) -> None: ...

    @property
    def shell(self) -> ShellCommands:
        """The command builder for the host's default shell (cached per instance)."""
        if self._shell_commands is None:
            self._shell_commands = ShellCommands.for_host()
        return self._shell_commands

    # -- author ------------------------------------------------------------------
    def write_home_file(self, name: str, content: str) -> None:
        """Write text ``content`` to ``name`` in the shell's home directory."""
        self.run_command(self.shell.write_text(name, content))

    def write_home_file_empty(self, name: str) -> None:
        """Create an empty file ``name`` in the home directory."""
        self.run_command(self.shell.write_empty(name))

    def write_home_bytes(self, name: str, data: bytes) -> None:
        """Write raw ``data`` (e.g. a non-UTF-8 file) to ``name`` in home."""
        self.run_command(self.shell.write_bytes(name, data))

    def touch_home(self, name: str) -> None:
        """Create an empty file at home-relative ``name`` if it does not exist."""
        self.run_command(self.shell.touch(name))

    def make_home_dir(self, name: str) -> None:
        """Create directory ``name`` (and parents) under home."""
        self.run_command(self.shell.mkdir(name))

    # -- clean up ----------------------------------------------------------------
    def remove_home(self, name: str) -> None:
        """Delete file ``name`` under home (no error if absent)."""
        self.run_command(self.shell.remove(name))

    def remove_home_tree(self, name: str) -> None:
        """Recursively delete ``name`` under home (no error if absent)."""
        self.run_command(self.shell.remove_tree(name))

    def remove_home_glob(self, pattern: str) -> None:
        """Delete home entries matching ``pattern`` (e.g. ``e2e_ed_*``)."""
        self.run_command(self.shell.remove_glob(pattern))
