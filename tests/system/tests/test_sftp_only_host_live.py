"""Files on an SFTP-only SSH host from the real app (#4078, #1330).

``ssh-sftp-only`` forces ``internal-sftp`` (``ForceCommand``), so it refuses the
interactive shell ("This service allows sftp connections only."). The app keeps
the SSH session up as **files-only**: the terminal tab shows a "no shell" info
panel with **Open Files**, and the Files sidebar and editor work over SFTP.

This drives the user's path end to end:

- connect → the tab shows the no-shell panel (no disconnect overlay, the
  session stays);
- **Open Files** → the Files sidebar lists the host over SFTP;
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

The probes behind the fallback are covered without UI in
``src-tauri/src/files/sftp.rs``; the backend's files-only detection in
``core/tests/ssh_files_only.rs``.
"""

from __future__ import annotations

import subprocess
import tempfile
import time
from pathlib import Path

import pytest

from termihub_harness import (
    SSH_HOST,
    ComposeFixture,
    ConnectionsUi,
    ContainerRuntimeUnavailable,
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
    container_runtime,
    unique_name,
)
from termihub_harness.dev_local import compose_project, service_port

pytestmark = pytest.mark.integration

#: The SFTP-only SSH container (``tests/docker/ssh-sftp-only``).
SSH_SFTP_ONLY_SERVICE = "ssh-sftp-only"
SSH_SFTP_ONLY_PORT = service_port("TERMIHUB_TEST_SSH_SFTP_ONLY_PORT", 2215)
#: The test user's home on that container (``useradd -m testuser``).
SFTP_ONLY_HOME = "/home/testuser"

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


@pytest.fixture(scope="module")
def sftp_only_fixture():
    """Bring up ``ssh-sftp-only`` under this checkout's isolation, or skip."""
    fixture = ComposeFixture()
    try:
        fixture.ensure(SSH_SFTP_ONLY_SERVICE, ports=[(SSH_HOST, SSH_SFTP_ONLY_PORT)])
    except ContainerRuntimeUnavailable as exc:
        pytest.skip(f"SSH container fixtures unavailable: {exc}")
    return fixture


def _container_read(path: str) -> str:
    """``path`` read inside this checkout's ``ssh-sftp-only`` container."""
    host = SshServerControl(SSH_SFTP_ONLY_SERVICE)
    if not host.available:
        pytest.skip("no container runtime to read the saved copy back")
    return host.read_file(path)


def _container_remove(path: str) -> None:
    """Best-effort removal of ``path`` inside the container (test cleanup)."""
    runtime = container_runtime()
    if runtime is None:
        return
    container = f"{compose_project()}-{SSH_SFTP_ONLY_SERVICE}"
    subprocess.run(
        [runtime, "exec", container, "rm", "-f", path],
        check=False,
        timeout=30,
        capture_output=True,
    )


def _flip_eol(text: str) -> str:
    """``text`` with its line endings toggled LF <-> CRLF, as the EOL toggle does."""
    if "\r\n" in text:
        return text.replace("\r\n", "\n")
    return text.replace("\n", "\r\n")


@pytest.mark.usefixtures("sftp_only_fixture")
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
        """Click Open Files on the panel; return the browser path once listed."""
        self.driver.click(FILES_ONLY_OPEN_FILES)
        self.wait(
            lambda: self.driver.get_state("sidebarView") == "files"
            and not self.driver.get_state("sidebarCollapsed"),
            what="the Files sidebar to open",
        )
        if self.password_prompt_open():
            self.handle_password_prompt()
        return self.wait(lambda: self.file_browser_path() or None, what="the SFTP listing")

    def _browse_to_etc(self) -> None:
        """Walk the browser from the home dir up to ``/`` and into ``/etc``."""
        for _ in range(8):  # bounded: home is a couple of levels deep
            if self.file_browser_path() == "/":
                break
            self.navigate_up()
        self.enter_directory("etc")

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
        self.open_file_in_editor("hostname")

        self.wait_for_readonly()
        # The SFTP-only fallback: copy / download, never sudo, Save disabled.
        self.wait(lambda: self.driver.exists(self.SAVE_COPY), what="the Save a copy action")
        assert self.driver.exists(self.DOWNLOAD)
        assert not self.driver.exists(self.EDIT_WITH_SUDO)

        original = _container_read("/etc/hostname")
        self.dirty_editor()
        # Even with a dirty buffer, Save stays disabled on the read-only file.
        assert self.driver.exists(self.SAVE)
        assert self.driver.get_attribute(self.SAVE, "disabled") is not None

        copy_path = f"{SFTP_ONLY_HOME}/{unique_name('hostname-copy')}.txt"
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
            assert _container_read("/etc/hostname") == original, (
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
        self.open_file_in_editor("hostname")
        self.wait_for_readonly()
        self.wait(lambda: self.driver.exists(self.DOWNLOAD), what="the Download action")

        target = Path(tempfile.mkdtemp(prefix="thub-sftp-download-")) / "hostname"
        self.driver.stub_native_dialog("save", target)
        self.driver.click(self.DOWNLOAD)
        toast = self.wait(
            lambda: self.driver.exists(TRANSFER_DONE_TOAST)
            and self.driver.get_text(TRANSFER_DONE_TOAST),
            what="the Downloaded toast",
        )
        assert "Downloaded hostname" in toast, f"unexpected toast: {toast!r}"
        self._wait_local_file(target, _container_read("/etc/hostname"))

    def test_file_browser_download_saves_the_file_locally(self):
        """The context-menu Download writes the remote file to the picked path."""
        self._connect_files_only("sftp-only-browser-download")
        self._open_files()
        self._browse_to_etc()

        target = Path(tempfile.mkdtemp(prefix="thub-sftp-browser-download-")) / "hostname"
        self.open_file_menu("hostname")
        self.wait(lambda: self.driver.exists(CTX_FILE_DOWNLOAD), what="the Download menu item")
        self.driver.stub_native_dialog("save", target)
        self.driver.click(CTX_FILE_DOWNLOAD)
        self._wait_local_file(target, _container_read("/etc/hostname"))

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
