"""SFTP file-browser & remote-editor infrastructure system tests.

Ports the portable scenarios from three WebdriverIO infrastructure specs onto
the Python bridge harness (issue #814, part of #803 / epic #799):

- ``infrastructure/sftp-extended.test.js``     (MT-FB-01/02/03/13/19)
- ``infrastructure/file-browser-infra.test.js`` (SFTP connect/browse, edit-keeps
  -parent-dir, new file, download menu, double-click open)
- ``infrastructure/editor-infra.test.js``      ([Remote] badge on SFTP edit)

The Docker SSH container stays as a **fixture** (``ssh-password`` on port 2201,
via ``ssh_fixtures``); only the driver changes. Each ``data-testid`` interaction
maps to a bridge step and each assertion to a check, reusing the existing
``SftpUi`` / ``FilesUi`` / ``EditorUi`` mixins.

Scenarios that the in-webview bridge cannot drive faithfully stay as manual
tests (see ``docs/testing.md``):

- **Serial "no filesystem" placeholder** (MT-FB-06) — needs a serial connection,
  but the virtual socat PTY is not OS-enumerated, so it cannot be selected
  through the bridge (same constraint as the serial port field in #813).
- **Actual SFTP upload / download transfer** (MT-FB-02/03 beyond menu presence)
  and **mid-session SFTP loss** (MT-FB-17) — drive an OS-native file dialog and
  fault injection respectively, outside the in-app bridge's reach.
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    ConnectionsUi,
    EditorUi,
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


@pytest.mark.usefixtures("ssh_fixtures")
class TestSftpInfra(
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SshUi,
    SftpUi,
    FilesUi,
    EditorUi,
    SystemTest,
):
    """SFTP browsing + remote file editing over the password-auth SSH fixture."""

    @pytest.fixture(autouse=True)
    def _close_tabs_between_tests(self):
        # The file browser tracks the *active* tab, so leftover SSH/editor tabs
        # from a previous test would skew what it shows. Mirror the old afterEach.
        yield
        self.close_all_tabs()
        self.switch_to_connections_sidebar()

    # -- helpers -----------------------------------------------------------------
    def _connect_and_browse(self, purpose: str) -> str:
        """Connect a password SSH session and open its SFTP browser; return path."""
        self.connect_ssh_password(unique_name(purpose))
        return self.connect_sftp_browser()

    def _seed_remote_file(self, name: str) -> None:
        """Create ``name`` in the SSH session's CWD via the terminal."""
        self.run_command(f"touch {name}")

    # -- listing -----------------------------------------------------------------
    def test_sftp_lists_remote_files(self):
        """MT-FB-01: connecting SFTP shows the remote filesystem.

        Seed a known file over the live shell, then confirm the SFTP browser
        lists it — proving the browser reads the remote directory, not a stub.
        """
        name = unique_name("sftp-list")
        self.connect_ssh_password(unique_name("sftp-list-conn"))
        self._seed_remote_file(name)
        path = self.connect_sftp_browser()
        assert path, "the SFTP browser should show a remote path"
        self.wait_for_file_row(name)
        assert self.file_row_exists(name)

    # -- toolbar / context menu --------------------------------------------------
    def test_sftp_upload_button_present(self):
        """MT-FB-02: the Upload control is available in SFTP mode."""
        self._connect_and_browse("sftp-upload")
        assert self.driver.exists("file-browser-upload")

    def test_sftp_row_context_menu_offers_download(self):
        """MT-FB-03/13: right-clicking a remote file offers Download."""
        name = unique_name("sftp-dl")
        self.connect_ssh_password(unique_name("sftp-dl-conn"))
        self._seed_remote_file(name)
        self.connect_sftp_browser()
        self.open_file_menu(name)  # right-click → context menu (waits for delete item)
        assert self.driver.exists("context-file-download")
        self.driver.press_key("Escape")  # dismiss the menu

    # -- remote editing ----------------------------------------------------------
    def test_sftp_edit_shows_remote_badge(self):
        """editor-infra / MT-FB-19: editing an SFTP file shows the [Remote] badge."""
        name = unique_name("sftp-badge")
        self.connect_ssh_password(unique_name("sftp-badge-conn"))
        self._seed_remote_file(name)
        self.connect_sftp_browser()
        self.open_file_in_editor(name)  # right-click → Edit
        assert self.wait(
            lambda: self.driver.exists("file-editor-remote-badge"),
            what="the editor [Remote] badge",
        )

    def test_sftp_edit_keeps_browser_at_parent_dir(self):
        """file-browser-infra (PR #57): opening a remote file keeps the browser
        on the file's parent directory rather than losing context."""
        name = unique_name("sftp-parent")
        self.connect_ssh_password(unique_name("sftp-parent-conn"))
        self._seed_remote_file(name)
        parent = self.connect_sftp_browser()
        self.open_file_in_editor(name)
        # The browser navigates to (and stays on) the file's parent directory.
        assert self.wait(
            lambda: self.file_browser_path() == parent,
            what="the browser to stay on the parent directory",
        )

    # -- creation / activation ---------------------------------------------------
    def test_sftp_new_file_via_browser(self):
        """file-browser-infra (PR #58): the New File input creates a remote file."""
        self._connect_and_browse("sftp-new")
        name = unique_name("sftp-created")
        self.create_file_via_browser(name)
        assert self.file_row_exists(name)

    def test_sftp_double_click_opens_editor_tab(self):
        """file-browser-infra (PR #61): double-clicking a remote file opens an
        editor tab."""
        name = unique_name("sftp-dbl")
        self.connect_ssh_password(unique_name("sftp-dbl-conn"))
        self._seed_remote_file(name)
        self.connect_sftp_browser()
        before = self.tab_count()
        self.open_file_in_editor(name, via="double")
        assert self.wait(lambda: self.tab_count() > before, what="a new editor tab")
