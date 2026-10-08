"""Drag-to-move in the SFTP file browser is a server-side rename (PROD-006, #3454, #4007).

``FileBrowser.drag-move.test.tsx`` proves a same-session SFTP move reaches the
backend as one rename with every IPC mocked; the local twin
(``test_file_browser_local.py``) drives the real pointer gesture against the
host disk. This drives the same gesture in the SFTP browser of a live SSH session
on the Docker ``ssh-password`` fixture and checks the result **on the host**
through a container exec:

- the file appears at its new path with its bytes intact, and the old path is
  gone;
- it keeps its **inode** — a rename, not a download/upload or copy-then-delete,
  which would give the file a new inode.

Every remote path is a unique name in the test user's home, removed afterwards.
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    ConnectionsUi,
    ContainerRuntimeUnavailable,
    FilesUi,
    PasswordPromptUi,
    SftpUi,
    SidebarUi,
    SshServerControl,
    SshUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    file_row_testid,
    unique_name,
)

pytestmark = pytest.mark.integration

#: The ``ssh-password`` fixture user's home (``useradd -m testuser``).
REMOTE_HOME = "/home/testuser"
#: What the dragged file holds; the moved file must match it exactly.
PAYLOAD = "drag me over sftp\n"


@pytest.mark.usefixtures("ssh_password_fixtures")
class TestFileBrowserDragSftpLive(
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
    def _host(self):
        """Exec access to the fixture host; tabs + remote paths cleaned after."""
        self._server = SshServerControl()
        if not self._server.available:
            pytest.skip("no container runtime to check the host side of the move")
        self._remote_paths: list[str] = []
        try:
            yield
        finally:
            self.close_all_tabs()
            self.switch_to_connections_sidebar()
            for path in self._remote_paths:
                try:
                    self._server.remove_path(path)
                except ContainerRuntimeUnavailable:
                    pass

    def test_dragging_a_remote_file_onto_a_folder_renames_it_on_the_server(self):
        prefix = f"{unique_name('sftp-dm')}_"
        dest_name, file_name = f"{prefix}dest", f"{prefix}file.txt"
        dest = f"{REMOTE_HOME}/{dest_name}"
        source = f"{REMOTE_HOME}/{file_name}"
        moved = f"{dest}/{file_name}"
        self._remote_paths += [dest, source]

        self.connect_ssh_password(unique_name("sftp-dm-conn"))
        # The SSH shell logs into the home dir the SFTP browser then shows.
        # printf keeps the payload byte-exact (no shell-dependent echo).
        self.run_command(f"mkdir {dest_name} && printf 'drag me over sftp\\n' > {file_name}")
        self.wait(lambda: self._server.path_exists(source), what="the seeded remote file")
        inode = self._server.inode(source)

        self.connect_sftp_browser()
        self.wait_for_path_contains(REMOTE_HOME)
        self.wait_for_file_row(file_name)
        self.filter_entries(prefix)  # both rows mounted, side by side
        self.wait(
            lambda: self.file_row_exists(file_name) and self.file_row_exists(dest_name),
            what="the file and folder rows",
        )

        dest_row = file_row_testid(dest_name)
        seen = self.driver.drag_to(file_row_testid(file_name), dest_row, observe=[dest_row])

        assert seen[dest_row]["attributes"].get("data-drop-highlight") == "valid"
        self.wait(
            lambda: self._server.path_exists(moved) and not self._server.path_exists(source),
            what="the file to move into the folder on the host",
        )
        assert self._server.read_file(moved) == PAYLOAD
        assert self._server.inode(moved) == inode, "the move was not a server-side rename"
