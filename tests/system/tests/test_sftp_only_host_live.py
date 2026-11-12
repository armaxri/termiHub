"""Files on an SFTP-only SSH host from the real app (#4078, #1330).

``ssh-sftp-only`` forces ``internal-sftp`` (``ForceCommand``), so it refuses the
interactive shell ("This service allows sftp connections only."). The app keeps
the SSH session up as **files-only**: the terminal tab shows a "no shell" info
panel with **Open files**, and the Files sidebar and editor work over SFTP.

This drives the user's path end to end:

- connect → the tab shows the no-shell panel (no disconnect overlay, the
  session stays);
- **Open files** → the Files sidebar lists the host over SFTP;
- open the root-owned ``/etc/hostname`` → the #1330 SFTP-only read-only fallback:
  the banner offers **Save a copy…** and **Download**, there is no "Edit with
  sudo", and Save is disabled;
- **Save a copy…** to a path in the user's home writes the (edited) buffer,
  read back from the container with ``docker exec``;
- **Download** in the read-only banner saves the file locally through the
  native Save dialog, stubbed with ``driver.stub_native_dialog`` (#4122): the
  "Downloaded …" toast shows and the local file holds the remote contents
  (#4128, was the manual MT-EDIT-01);
- the file browser's **Download** (context menu) and **Upload** (toolbar), whose
  native Save / Open dialogs are stubbed the same way, move the file over SFTP
  in both directions.

On the macOS native target (#5423) the host is the native sshd's ``sftponly``
variant (``ForceCommand internal-sftp`` for the fixture user). macOS has no
``/etc/hostname`` and its ``/etc`` is a symlink, so there the root-owned file
is ``/etc/hosts``, reached through ``/private/etc``; the host's files are read
back over the main sshd's key-auth exec as the same user.

The probes behind the fallback are covered without UI in
``src-tauri/src/files/sftp.rs``; the backend's files-only detection in
``core/tests/ssh_files_only.rs``.
"""

from __future__ import annotations

import tempfile
import time
from pathlib import Path

import pytest

from termihub_harness import (
    NATIVE_SSH_TARGET,
    SSH_SFTP_ONLY_PORT,
    SSH_SFTP_ONLY_SERVICE,
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
    native_ssh,
    ssh_server_control,
    unique_name,
)

pytestmark = pytest.mark.integration

#: The root-owned file the read-only fallback opens, and the directories the
#: browser walks into from ``/`` to reach it: ``/etc/hostname`` on the Linux
#: container; ``/etc/hosts`` through ``/private/etc`` on the macOS native host.
if NATIVE_SSH_TARGET is not None and native_ssh.serves_hosts():
    ROOT_OWNED_DIRS: tuple[str, ...] = ("private", "etc")
    ROOT_OWNED_NAME = "hosts"
else:
    ROOT_OWNED_DIRS = ("etc",)
    ROOT_OWNED_NAME = "hostname"
ROOT_OWNED_PATH = f"/etc/{ROOT_OWNED_NAME}"

#: The files-only "no shell" panel over the terminal (#4078).
FILES_ONLY_PANEL = "terminal-files-only-panel"
FILES_ONLY_OPEN_FILES = "terminal-files-only-open-files"
DISCONNECT_OVERLAY = "terminal-disconnect-overlay"
#: The editor's "Save a copy" dialog (#1330).
SAVE_COPY_DIALOG = "save-copy-dialog"
SAVE_COPY_INPUT = "save-copy-input"
SAVE_COPY_SUBMIT = "save-copy-submit"
#: The terminal success toast of a transfer ("Downloaded …" / "Uploaded …").
TRANSFER_DONE_TOAST = "transfer-done-toast"
#: The file browser's Download context-menu item and Upload toolbar button.
CTX_FILE_DOWNLOAD = "context-file-download"
FILE_BROWSER_UPLOAD = "file-browser-upload"


def _host():
    """Server-side control of the SFTP-only host: the container, or on the
    macOS native target the main sshd's key-auth exec as the same user."""
    host = ssh_server_control(SSH_SFTP_ONLY_SERVICE)
    if not host.available:
        pytest.skip("no server-side access to read the saved copy back")
    return host


def _container_read(path: str) -> str:
    """``path`` read on the SFTP-only host."""
    return _host().read_file(path)


def _container_remove(path: str) -> None:
    """Best-effort removal of ``path`` on the host (test cleanup)."""
    try:
        _host().remove_path(path)
    except Exception:  # noqa: BLE001 - cleanup must not mask the test's outcome
        pass


def _flip_eol(text: str) -> str:
    """``text`` with its line endings toggled LF <-> CRLF, as the EOL toggle does."""
    if "\r\n" in text:
        return text.replace("\r\n", "\n")
    return text.replace("\n", "\r\n")


@pytest.mark.usefixtures("ssh_sftp_only_fixtures")
@pytest.mark.native_sshd(platforms=("darwin",))
class TestSftpOnlyHostLive(
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
        yield
        self.close_all_tabs()
        self.switch_to_connections_sidebar()

    # -- helpers -----------------------------------------------------------------
    def _connect_files_only(self, purpose: str) -> None:
        """Connect to the SFTP-only host and wait for the no-shell panel."""
        self.connect_ssh_password(unique_name(purpose), port=SSH_SFTP_ONLY_PORT)
        self.wait(
            lambda: self.driver.exists(FILES_ONLY_PANEL),
            what="the files-only no-shell panel",
        )

    def _open_files(self) -> str:
        """Click Open files on the panel; return the browser path once listed."""
        self.driver.click(FILES_ONLY_OPEN_FILES)
        self.wait(
            lambda: self.driver.get_state("sidebarView") == "files"
            and not self.driver.get_state("sidebarCollapsed"),
            what="the Files sidebar to open",
        )
        if self.password_prompt_open():
            self.handle_password_prompt()
        # Settled, not merely shown: until this session's first listing lands the
        # pane can still show the previous test's session directory (``/etc``).
        return self.wait_file_browser_settled()

    def _browse_to_etc(self) -> None:
        """Walk the browser from the home dir up to ``/`` and into ``/etc``."""
        for _ in range(8):  # bounded: home is a couple of levels deep
            if self.file_browser_path() == "/":
                break
            self.navigate_up()
        for name in ROOT_OWNED_DIRS:
            self.enter_directory(name)

    # -- tests -------------------------------------------------------------------
    def test_refused_shell_shows_the_panel_and_keeps_the_session(self):
        self._connect_files_only("sftp-only-panel")

        panel_text = self.driver.get_text(FILES_ONLY_PANEL)
        assert "This host doesn't allow a shell." in panel_text
        assert "Files are available in the sidebar." in panel_text
        assert self.driver.exists(FILES_ONLY_OPEN_FILES)
        # Not a dropped session: no disconnect overlay, and it stays that way.
        assert not self.driver.exists(DISCONNECT_OVERLAY)
        time.sleep(2)  # a refused shell settles within ~1 s; give it room to (not) drop
        assert self.driver.exists(FILES_ONLY_PANEL)
        assert not self.driver.exists(DISCONNECT_OVERLAY)

        path = self._open_files()
        assert path.startswith("/"), f"the SFTP browser lists a remote path, got {path!r}"

    def test_root_owned_file_takes_the_fallback_and_saves_a_copy_to_home(self):
        self._connect_files_only("sftp-only-fallback")
        self._open_files()
        self._browse_to_etc()
        self.open_file_in_editor(ROOT_OWNED_NAME)

        self.wait_for_readonly()
        # The SFTP-only fallback: copy / download, never sudo, Save disabled.
        self.wait(lambda: self.driver.exists(self.SAVE_COPY), what="the Save a copy action")
        assert self.driver.exists(self.DOWNLOAD)
        assert not self.driver.exists(self.EDIT_WITH_SUDO)

        original = _container_read(ROOT_OWNED_PATH)
        self.dirty_editor()
        # Even with a dirty buffer, Save stays disabled on the read-only file.
        assert self.driver.exists(self.SAVE)
        assert self.driver.get_attribute(self.SAVE, "disabled") is not None

        copy_path = f"{_host().home()}/{unique_name('hostname-copy')}.txt"
        self.driver.click(self.SAVE_COPY)
        self.wait(lambda: self.driver.exists(SAVE_COPY_INPUT), what="the Save a copy dialog")
        self.driver.type(SAVE_COPY_INPUT, copy_path)
        self.driver.click(SAVE_COPY_SUBMIT)
        self.wait(
            lambda: not self.driver.exists(SAVE_COPY_DIALOG),
            what="the Save a copy dialog to close after the write",
        )
        try:
            assert _container_read(copy_path) == _flip_eol(original), (
                "the copy in home must hold the edited buffer"
            )
            assert _container_read(ROOT_OWNED_PATH) == original, (
                "the root-owned original is untouched"
            )
        finally:
            _container_remove(copy_path)

    def _wait_local_file(self, path: Path, expected: str) -> None:
        """Wait until a transfer has written ``expected`` to local file ``path``."""

        def written() -> bool:
            try:
                return path.read_bytes().decode("utf-8") == expected
            except (OSError, UnicodeDecodeError):
                return False

        self.wait(written, what=f"the remote contents to be downloaded to {path}")

    def test_read_only_banner_download_saves_the_file_locally(self):
        """MT-EDIT-01: Download a read-only file through the native Save dialog."""
        self._connect_files_only("sftp-only-download")
        self._open_files()
        self._browse_to_etc()
        self.open_file_in_editor(ROOT_OWNED_NAME)
        self.wait_for_readonly()
        self.wait(lambda: self.driver.exists(self.DOWNLOAD), what="the Download action")

        target = Path(tempfile.mkdtemp(prefix="thub-sftp-download-")) / ROOT_OWNED_NAME
        self.driver.stub_native_dialog("save", target)
        self.driver.click(self.DOWNLOAD)
        toast = self.wait(
            lambda: self.driver.exists(TRANSFER_DONE_TOAST)
            and self.driver.get_text(TRANSFER_DONE_TOAST),
            what="the Downloaded toast",
        )
        assert f"Downloaded {ROOT_OWNED_NAME}" in toast, f"unexpected toast: {toast!r}"
        self._wait_local_file(target, _container_read(ROOT_OWNED_PATH))

    def test_file_browser_download_saves_the_file_locally(self):
        """The context-menu Download writes the remote file to the picked path."""
        self._connect_files_only("sftp-only-browser-download")
        self._open_files()
        self._browse_to_etc()

        target = Path(tempfile.mkdtemp(prefix="thub-sftp-browser-download-")) / ROOT_OWNED_NAME
        self.open_file_menu(ROOT_OWNED_NAME)
        self.wait(lambda: self.driver.exists(CTX_FILE_DOWNLOAD), what="the Download menu item")
        self.driver.stub_native_dialog("save", target)
        self.driver.click(CTX_FILE_DOWNLOAD)
        self._wait_local_file(target, _container_read(ROOT_OWNED_PATH))

    def test_file_browser_upload_writes_the_picked_file_to_the_host(self):
        """The toolbar Upload copies the picked local file into the listed folder."""
        self._connect_files_only("sftp-only-upload")
        home = self._open_files()

        name = f"{unique_name('upload')}.txt"
        source = Path(tempfile.mkdtemp(prefix="thub-sftp-upload-")) / name
        contents = f"uploaded by the harness: {name}\n"
        source.write_bytes(contents.encode("utf-8"))
        remote = f"{home.rstrip('/')}/{name}"
        self.driver.stub_native_dialog("open", source)
        self.driver.click(FILE_BROWSER_UPLOAD)
        try:
            self.wait_for_file_row(name)
            assert _container_read(remote) == contents, (
                "the uploaded file on the host must hold the local contents"
            )
        finally:
            _container_remove(remote)
