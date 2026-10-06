"""Remote → local copy/paste in the file browser (#3563, #4007).

The paste engine is covered by ``useFileMoveTransfer.test.ts`` with every IPC
mocked; this drives the real app end to end. An entry is copied in the file
browser of a live remote session, the browser is pointed at a local terminal's
directory, and the toolbar Paste must land it — byte for byte — on the local
disk, while the remote session that sourced the clipboard stays open in its own
tab. The same three journeys run against two remote hosts:

- :class:`TestFileBrowserRemoteToLocal` — the SFTP browser of a direct SSH
  session (the ``ssh-password`` fixture);
- :class:`TestAgentFileBrowserRemoteToLocal` — the session browser of a shell
  hosted by a deployed remote agent (the ``remote-agent`` fixture, #4007). The
  download goes through the agent's session file layer (the transfer queue when
  the agent session is queue-capable, the byte round-trip otherwise) rather
  than SFTP.

Each journey covers:

- a single file;
- a nested folder (the tree is recreated, every file copied);
- a file whose name already exists locally — the replace prompt guards it:
  Cancel leaves the local file untouched, "Paste and Replace" overwrites it.

The agent suite skips cleanly when no container runtime is available or the
agent cross-build toolchain is missing (see ``remote_agent_fixtures``).

The local destination is a fresh temp dir, removed afterwards, so nothing lands
in ``$HOME``.
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

import pytest

from termihub_harness import (
    REMOTE_AGENT_PORT,
    SSH_HOST,
    SSH_PASSWORD,
    SSH_USERNAME,
    AgentUi,
    ConnectionsUi,
    FilesUi,
    PasswordPromptUi,
    SettingsUi,
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


class _RemoteToLocalPasteJourneys(TerminalUi, TabsUi, SidebarUi, FilesUi):
    """The three remote → local paste journeys, shared by both remote hosts.

    A concrete suite supplies :meth:`_open_remote_browser`: open a live remote
    session, run the seeding command in its shell, and show that session's file
    browser. Not collected itself (no ``Test`` prefix).
    """

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

    def _open_remote_browser(self, seed: str) -> None:
        """Open a remote session, run ``seed`` in its home dir, show its browser."""
        raise NotImplementedError

    def _copy_remote_file(self, name: str, *, seed: str | None = None) -> None:
        """Seed ``name`` in the remote home dir, then Copy it in the file browser.

        ``seed`` replaces the default seeding command (one file holding
        :data:`PAYLOAD`), e.g. to build a nested folder named ``name``.
        """
        # printf keeps the trailing newline exact (no shell-dependent echo).
        self._open_remote_browser(
            seed or f"printf 'remote-to-local paste payload\\n' > {name}"
        )
        self.wait_for_file_row(name)
        self.open_file_menu(name)
        self.driver.click("context-file-copy")

    def _browse_local_dest(self) -> None:
        """Open a local terminal, ``cd`` into the destination, show its listing."""
        before = self.tab_ids()
        self.switch_to_connections_sidebar()
        self.open_new_terminal()
        self.wait(
            lambda: len(self.tab_ids()) == len(before) + 1, what="a local terminal tab"
        )
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
        remote_tabs = self.tab_ids()

        self._browse_local_dest()
        self._paste_when_enabled()

        pasted = self._dest / name
        self.wait(
            lambda: pasted.is_file() and pasted.read_text() == PAYLOAD,
            what="the remote file to land in the local folder",
        )
        self.wait_for_file_row(name)
        # Copy, not cut: the session that sourced it is still open.
        assert all(t in self.tab_ids() for t in remote_tabs)

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
            lambda: (
                top.is_file()
                and nested.is_file()
                and top.read_text() == "top\n"
                and nested.read_text() == "nested\n"
            ),
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
        self.wait(
            lambda: self.driver.exists(CONFLICT_DIALOG), what="the replace prompt"
        )
        assert name in self.driver.get_text(CONFLICT_DIALOG)
        self.driver.click(CONFLICT_CANCEL)
        self.wait(
            lambda: not self.driver.exists(CONFLICT_DIALOG), what="the prompt to close"
        )
        assert existing.read_text() == "local original\n"

        # Confirm: the remote copy replaces the local file.
        self._paste_when_enabled()
        self.wait(
            lambda: self.driver.exists(CONFLICT_DIALOG), what="the replace prompt"
        )
        self.driver.click(CONFLICT_CONFIRM)
        self.wait(
            lambda: existing.read_text() == PAYLOAD,
            what="the remote file to replace the local one",
        )


@pytest.mark.usefixtures("ssh_password_fixtures")
class TestFileBrowserRemoteToLocal(
    _RemoteToLocalPasteJourneys,
    ConnectionsUi,
    PasswordPromptUi,
    SshUi,
    SftpUi,
    SystemTest,
):
    """The journeys from the SFTP browser of a direct SSH session."""

    def _open_remote_browser(self, seed: str) -> None:
        self.connect_ssh_password(unique_name("r2l-conn"))
        self.run_command(seed)
        self.connect_sftp_browser()


@pytest.mark.usefixtures("remote_agent_fixtures")
class TestAgentFileBrowserRemoteToLocal(
    _RemoteToLocalPasteJourneys,
    AgentUi,
    PasswordPromptUi,
    SettingsUi,
    SystemTest,
):
    """The journeys from the session browser of a remote-agent shell (#4007)."""

    @pytest.fixture(autouse=True)
    def _disconnect_agents(self):
        """Drop every agent connection after a test (frees the SSH + agent handshake)."""
        yield
        self.dismiss_connection_error_if_present()
        for agent in self.remote_agents():
            if agent.get("connectionState") not in (None, "disconnected"):
                self.disconnect_agent(agent["name"])

    def _open_remote_browser(self, seed: str) -> None:
        name = unique_name("r2l-agent")
        self.create_remote_agent(
            name, host=SSH_HOST, port=REMOTE_AGENT_PORT, username=SSH_USERNAME
        )
        self.connect_agent(name)
        self.handle_password_prompt(SSH_PASSWORD)
        self.wait_agent_connected(name)

        before = self.tab_count()
        self.new_shell_session(name)
        self.wait(lambda: self.tab_count() > before, what="the agent shell-session tab")
        self.wait(self.has_terminal, what="the agent shell terminal session")
        self.run_command(seed)
        # The agent-hosted shell's browser opens on the agent user's home dir
        # (``~``, resolved by the agent) — the same dir the seed ran in.
        self.switch_to_files_sidebar()
        self.wait_file_browser_settled()
