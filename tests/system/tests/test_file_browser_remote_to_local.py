"""Remote → local copy/paste in the file browser (#3563, #4007).

The paste engine is covered by ``useFileMoveTransfer.test.ts`` with every IPC
mocked; this drives the real app end to end. An entry is copied in the SFTP
browser of a live SSH session (the ``ssh-password`` fixture), the browser is
pointed at a local terminal's directory, and the toolbar Paste must land it —
byte for byte — on the local disk, while the SSH session that sourced the
clipboard stays open in its own tab:

- a single file;
- a nested folder (the tree is recreated, every file copied);
- a file whose name already exists locally — the replace prompt guards it:
  Cancel leaves the local file untouched, "Paste and Replace" overwrites it.

Not covered here: the same paste from a remote-agent session (#4007 keeps that
leg open).

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

#: The paste engine's replace prompt (``FileMoveConflictDialog``).
CONFLICT_DIALOG = "file-move-conflict-dialog"
CONFLICT_CONFIRM = "file-move-conflict-confirm"
CONFLICT_CANCEL = "file-move-conflict-cancel"


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

    def _copy_remote_file(self, name: str, *, seed: str | None = None) -> None:
        """Seed ``name`` in the SSH home dir, then Copy it in the SFTP browser.

        ``seed`` replaces the default seeding command (one file holding
        :data:`PAYLOAD`), e.g. to build a nested folder named ``name``.
        """
        self.connect_ssh_password(unique_name("r2l-conn"))
        # printf keeps the trailing newline exact (no shell-dependent echo).
        self.run_command(seed or f"printf 'remote-to-local paste payload\\n' > {name}")
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

    def _paste_when_enabled(self) -> None:
        """Click the toolbar Paste once the remote clipboard has enabled it."""
        self.wait(
            lambda: self.driver.get_attribute(self.PASTE, "disabled") is None,
            what="Paste to be enabled by the remote clipboard",
        )
        self.driver.click(self.PASTE)

    def test_copied_remote_file_pastes_into_a_local_folder(self):
        name = f"{unique_name('r2l')}.txt"
        self._copy_remote_file(name)
        ssh_tabs = self.tab_ids()

        self._browse_local_dest()
        self._paste_when_enabled()

        pasted = self._dest / name
        self.wait(
            lambda: pasted.is_file() and pasted.read_text() == PAYLOAD,
            what="the remote file to land in the local folder",
        )
        self.wait_for_file_row(name)
        # Copy, not cut: the session that sourced it is still open.
        assert all(t in self.tab_ids() for t in ssh_tabs)

    def test_copied_remote_folder_pastes_its_nested_tree_locally(self):
        """A copied folder lands with its whole tree: sub-folder and both files."""
        name = unique_name("r2l-dir")
        seed = (
            f"mkdir -p {name}/sub && printf 'top\\n' > {name}/top.txt"
            f" && printf 'nested\\n' > {name}/sub/nested.txt"
        )
        self._copy_remote_file(name, seed=seed)

        self._browse_local_dest()
        self._paste_when_enabled()

        top = self._dest / name / "top.txt"
        nested = self._dest / name / "sub" / "nested.txt"
        self.wait(
            lambda: top.is_file()
            and nested.is_file()
            and top.read_text() == "top\n"
            and nested.read_text() == "nested\n",
            what="the nested remote folder to land in the local folder",
        )
        self.wait_for_file_row(name)

    def test_pasting_over_an_existing_local_file_asks_before_replacing(self):
        """A name clash raises the replace prompt; nothing is written without it."""
        name = f"{unique_name('r2l-clash')}.txt"
        existing = self._dest / name
        existing.write_text("local original\n")
        self._copy_remote_file(name)

        self._browse_local_dest()
        self.wait_for_file_row(name)

        # Cancel: the prompt closes and the local file is untouched.
        self._paste_when_enabled()
        self.wait(lambda: self.driver.exists(CONFLICT_DIALOG), what="the replace prompt")
        assert name in self.driver.get_text(CONFLICT_DIALOG)
        self.driver.click(CONFLICT_CANCEL)
        self.wait(lambda: not self.driver.exists(CONFLICT_DIALOG), what="the prompt to close")
        assert existing.read_text() == "local original\n"

        # Confirm: the remote copy replaces the local file.
        self._paste_when_enabled()
        self.wait(lambda: self.driver.exists(CONFLICT_DIALOG), what="the replace prompt")
        self.driver.click(CONFLICT_CONFIRM)
        self.wait(
            lambda: existing.read_text() == PAYLOAD,
            what="the remote file to replace the local one",
        )
