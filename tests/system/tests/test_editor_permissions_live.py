"""Live editor permission flows on real SSH hosts (#1325 / #1329, #4007).

The unit/component suites mock the backend; ``src-tauri``'s live Rust tests
prove the probes and the elevated write against the containers but render no
UI. These drive the **real app** against the Docker fixtures and assert what the
user sees:

- **Read-only badge + banner (#1325)** — opening the fixtures' root-owned
  ``/etc/termihub-elevated-target.txt`` on ``ssh-sudo`` and ``ssh-nosudo`` shows
  the Read-only badge and banner; both hosts have a shell, so the primary action
  is "Edit with sudo", never the SFTP-only fallback.
- **Elevated (sudo) save (#1329)** — on ``ssh-sudo`` a wrong sudo password is
  re-prompted ("Attempt 2 of 3"), the right one saves: the tab enters sudo mode,
  the dirty flag clears, and the root-owned file on the host really changed.

The file is reached the way a user would: ``cd /etc`` in the terminal, which the
browser follows. The buffer is dirtied by toggling the EOL (see
:class:`~termihub_harness.EditorUi`), so the expected file contents are the
original with its line endings flipped.

Not covered here: the SFTP-only fallback (#1330) on ``ssh-sftp-only``. That host
refuses the shell, so its session is kept files-only (#4078); the fallback is
driven from the UI in ``test_sftp_only_host_live.py``.

The sudo-password secrecy checks (logs, persisted tab/workspace state) run per
PR instead: ``log_secrecy.rs`` and ``FileEditor.test.tsx``.
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    ELEVATED_TARGET_DIR,
    ELEVATED_TARGET_NAME,
    ELEVATED_TARGET_PATH,
    SSH_NOSUDO_PORT,
    SSH_PASSWORD,
    SSH_SUDO_PORT,
    SSH_SUDO_SERVICE,
    ConnectionsUi,
    EditorUi,
    FilesUi,
    PasswordPromptUi,
    SftpUi,
    SidebarUi,
    SshServerControl,
    SshUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration


def _flip_eol(text: str) -> str:
    """``text`` with its line endings toggled LF <-> CRLF, as the EOL toggle does."""
    if "\r\n" in text:
        return text.replace("\r\n", "\n")
    return text.replace("\n", "\r\n")


@pytest.mark.usefixtures("ssh_permission_fixtures")
class TestEditorPermissionsLive(
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
    @pytest.fixture(autouse=True)
    def _close_tabs_between_tests(self):
        # The browser tracks the active tab; leftover tabs would skew it.
        yield
        self.close_all_tabs()
        self.switch_to_connections_sidebar()

    # -- helpers -----------------------------------------------------------------
    def _open_root_owned_file(self, purpose: str, port: int) -> dict:
        """Connect to a shell host, follow ``cd /etc``, open the root-owned file.

        Returns the editor tab, once the write probe has marked it read-only.
        """
        self.connect_ssh_password(unique_name(purpose), port=port)
        self.run_command(f"cd {ELEVATED_TARGET_DIR}")
        self.connect_sftp_browser()
        self.wait_for_path_contains(ELEVATED_TARGET_DIR)
        self.open_file_in_editor(ELEVATED_TARGET_NAME)
        self.wait_for_readonly()
        tab = self.find_tab(ELEVATED_TARGET_NAME)
        assert tab is not None, "the editor tab for the root-owned file"
        return tab

    def _assert_shell_host_read_only_ui(self) -> None:
        """Badge + banner, and the shell-host affordance rather than the fallback."""
        assert self.driver.exists(self.REMOTE_BADGE)
        assert self.driver.exists(self.READONLY_BADGE)
        assert self.driver.exists(self.READONLY_BANNER)
        # A shell host can elevate: "Edit with sudo" replaces Save …
        assert self.driver.exists(self.EDIT_WITH_SUDO)
        assert not self.driver.exists(self.SAVE)
        # … and the SFTP-only fallback actions are not offered.
        assert not self.driver.exists(self.SAVE_COPY)
        assert not self.driver.exists(self.DOWNLOAD)
        # The banner can be dismissed; the badge stays.
        self.driver.click(self.READONLY_BANNER_DISMISS)
        self.wait(
            lambda: not self.driver.exists(self.READONLY_BANNER),
            what="the read-only banner to dismiss",
        )
        assert self.driver.exists(self.READONLY_BADGE)

    # -- #1325: read-only badge + banner ---------------------------------------
    def test_root_owned_file_is_read_only_on_the_sudo_host(self):
        self._open_root_owned_file("perm-ro-sudo", SSH_SUDO_PORT)
        self._assert_shell_host_read_only_ui()

    def test_root_owned_file_is_read_only_on_the_nosudo_host(self):
        self._open_root_owned_file("perm-ro-nosudo", SSH_NOSUDO_PORT)
        self._assert_shell_host_read_only_ui()

    # -- #1329: elevated (sudo) save -------------------------------------------
    def test_sudo_save_reprompts_a_wrong_password_then_writes_the_file(self):
        host = SshServerControl(SSH_SUDO_SERVICE)
        before = host.read_file(ELEVATED_TARGET_PATH)
        tab = self._open_root_owned_file("perm-sudo-save", SSH_SUDO_PORT)

        self.dirty_editor()
        self.wait(lambda: self.editor_tab_dirty(tab["id"]), what="the tab to become dirty")
        self.driver.click(self.EDIT_WITH_SUDO)

        # A wrong password keeps the prompt open and says so.
        self.submit_sudo_password(f"wrong-{unique_name('pw')}")
        self.wait(lambda: self.driver.exists(self.SUDO_ERROR), what="the wrong-password notice")
        assert "Attempt 2" in self.driver.get_text(self.SUDO_ERROR)
        assert self.editor_tab_dirty(tab["id"]), "a rejected password must not save"

        # The account password authorizes the save.
        self.submit_sudo_password(SSH_PASSWORD)
        self.wait(
            lambda: not self.driver.exists(self.SUDO_DIALOG),
            what="the sudo prompt to close after a successful save",
        )
        self.wait(lambda: self.driver.exists(self.SUDO_BADGE), what="the sudo-mode badge")
        self.wait(
            lambda: not self.editor_tab_dirty(tab["id"]),
            what="the dirty flag to clear after the elevated save",
        )
        assert not self.driver.exists(self.SAVE_ERROR)

        # The root-owned file on the host really holds the edited buffer.
        assert host.read_file(ELEVATED_TARGET_PATH) == _flip_eol(before)
