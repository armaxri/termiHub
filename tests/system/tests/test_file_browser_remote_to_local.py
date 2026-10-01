"""Remote → local copy/paste in the file browser (#3563, #4007).

The paste engine is covered by ``useFileMoveTransfer.test.ts`` with every IPC
mocked; this drives the real app end to end. A file is copied in the SFTP
browser of a live SSH session (the ``ssh-password`` fixture), the browser is
pointed at a local terminal's directory, and the toolbar Paste must land the
file — byte for byte — on the local disk, while the SSH session that sourced
the clipboard stays open in its own tab.

The local destination is a fresh temp dir, removed afterwards, so nothing lands
in ``$HOME``.
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

import pytest

from termihub_harness import (
    ConnectionsUi,
    FilesUi,
    PasswordPromptUi,
    SftpUi,
    SidebarUi,
    SshUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration

#: What the remote file holds; the pasted local copy must match it exactly.
PAYLOAD = "remote-to-local paste payload\n"


@pytest.mark.usefixtures("ssh_password_fixtures")
class TestFileBrowserRemoteToLocal(
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SshUi,
    SftpUi,
    FilesUi,
    SystemTest,
):
    @pytest.fixture(autouse=True)
    def _local_dest(self):
        """A fresh local destination dir; tabs are closed afterwards."""
        dest = Path(tempfile.mkdtemp(prefix="e2e_r2l_"))
        self._dest = dest
        try:
            yield dest
        finally:
            self.close_all_tabs()
            self.switch_to_connections_sidebar()
            shutil.rmtree(dest, ignore_errors=True)

    def _copy_remote_file(self, name: str) -> None:
        """Seed ``name`` in the SSH home dir, then Copy it in the SFTP browser."""
        self.connect_ssh_password(unique_name("r2l-conn"))
        # printf keeps the trailing newline exact (no shell-dependent echo).
        self.run_command(f"printf 'remote-to-local paste payload\\n' > {name}")
        self.connect_sftp_browser()
        self.wait_for_file_row(name)
        self.open_file_menu(name)
        self.driver.click("context-file-copy")

    def _browse_local_dest(self) -> None:
        """Open a local terminal, ``cd`` into the destination, show its listing."""
        before = self.tab_ids()
        self.switch_to_connections_sidebar()
        self.open_new_terminal()
        self.wait(lambda: len(self.tab_ids()) == len(before) + 1, what="a local terminal tab")
        local_tab = next(t for t in self.tab_ids() if t not in before)
        self.wait(
            lambda: self.driver.read_terminal(local_tab).strip() != "",
            what="the local shell's prompt",
        )
        # Forward slashes so the cd works in Git Bash and PowerShell alike (#2683).
        self.run_command(f'cd "{str(self._dest).replace(chr(92), "/")}"')
        self.switch_to_files_sidebar()
        self.wait_for_path_contains(self._dest.name)

    def test_copied_remote_file_pastes_into_a_local_folder(self):
        name = f"{unique_name('r2l')}.txt"
        self._copy_remote_file(name)
        ssh_tabs = self.tab_ids()

        self._browse_local_dest()
        self.wait(
            lambda: self.driver.get_attribute(self.PASTE, "disabled") is None,
            what="Paste to be enabled by the remote clipboard",
        )
        self.driver.click(self.PASTE)

        pasted = self._dest / name
        self.wait(
            lambda: pasted.is_file() and pasted.read_text() == PAYLOAD,
            what="the remote file to land in the local folder",
        )
        self.wait_for_file_row(name)
        # Copy, not cut: the session that sourced it is still open.
        assert all(t in self.tab_ids() for t in ssh_tabs)
