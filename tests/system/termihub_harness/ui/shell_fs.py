"""Cross-platform home-directory fixtures for the local UI suites (#886, #4025).

``ShellFsUi`` authors and cleans up fixture files in the **home directory** the
local shell (and so a fresh file browser) shows. The app runs on the same host as
the test runner and inherits its environment, so the shell's home is the runner's
home (``Path.home()``: ``$HOME``, or ``%USERPROFILE%`` on Windows) and the
helpers write there **directly on disk**.

They used to type a ``printf`` / PowerShell command into the active terminal
instead. That raced the shell's startup: on a loaded Windows runner a freshly
spawned PowerShell could still be blank (no prompt drawn) when the command was
sent, the command never ran, and the editor suite timed out waiting for a file
row that was never created (#4025). A fixture is setup, not the behaviour under
test, so it no longer depends on the terminal at all. Callers then wait for the
entry with :meth:`~termihub_harness.ui.FilesUi.wait_for_file_row`, which
refreshes the browser on a bounded poll.

:attr:`shell` still exposes the host-shell
:class:`~termihub_harness.shell.ShellCommands` builder for the suites whose
*behaviour under test* is the shell itself (``cd`` / ``pwd`` checks).

Mixes in alongside :class:`~termihub_harness.SystemTest`.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Optional

from ..shell import ShellCommands
from .base import HarnessMixin


class ShellFsUi(HarnessMixin):
    """Author/remove fixture files in the shell's home dir, on the host disk."""

    _shell_commands: Optional[ShellCommands] = None

    @property
    def shell(self) -> ShellCommands:
        """The command builder for the host's default shell (cached per instance)."""
        if self._shell_commands is None:
            self._shell_commands = ShellCommands.for_host()
        return self._shell_commands

    def home_dir(self) -> Path:
        """The directory a fresh local shell starts in (and the browser shows)."""
        return Path.home()

    def _home_path(self, name: str) -> Path:
        return self.home_dir() / name

    # -- author ------------------------------------------------------------------
    def write_home_file(self, name: str, content: str) -> None:
        """Write text ``content`` to ``name`` in the home directory.

        Written as UTF-8 bytes with the newlines verbatim (no ``\\r\\n``
        translation on Windows), so the file holds exactly ``content``.
        """
        self._home_path(name).write_bytes(content.encode("utf-8"))

    def write_home_file_empty(self, name: str) -> None:
        """Create (or truncate) an empty file ``name`` in the home directory."""
        self._home_path(name).write_bytes(b"")

    def write_home_bytes(self, name: str, data: bytes) -> None:
        """Write raw ``data`` (e.g. a non-UTF-8 file) to ``name`` in home."""
        self._home_path(name).write_bytes(data)

    def touch_home(self, name: str) -> None:
        """Create an empty file at home-relative ``name`` if it does not exist."""
        self._home_path(name).touch(exist_ok=True)

    def make_home_dir(self, name: str) -> None:
        """Create directory ``name`` (and parents) under home."""
        self._home_path(name).mkdir(parents=True, exist_ok=True)

    # -- clean up ----------------------------------------------------------------
    def remove_home(self, name: str) -> None:
        """Delete file ``name`` under home (no error if absent)."""
        self._home_path(name).unlink(missing_ok=True)

    def remove_home_tree(self, name: str) -> None:
        """Recursively delete ``name`` under home (no error if absent)."""
        path = self._home_path(name)
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)

    def remove_home_glob(self, pattern: str) -> None:
        """Delete home **files** matching ``pattern`` (e.g. ``e2e_ed_*``).

        Best-effort, like the ``rm -f`` it replaces: an entry that vanished or is
        still held open (Windows) is skipped rather than failing setup.
        Directories are left alone — use :meth:`remove_home_tree` for those.
        """
        for path in self.home_dir().glob(pattern):
            if path.is_dir() and not path.is_symlink():
                continue
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
