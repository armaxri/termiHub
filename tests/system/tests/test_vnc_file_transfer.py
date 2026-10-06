"""VNC file transfer over the SSH-tunnel side channel, through the app (#4192, #4193).

Concept ``vnc-clipboard-file-transfer`` phase 2: a VNC connection that rides an
SSH tunnel and opts into **File Transfer** uploads local files over an SFTP
channel opened on the tunnel's own SSH session — no RFB extension involved.

The suite connects the app to the ``vnc-server`` fixture **through** the
``ssh-password`` fixture's tunnel (the VNC target is the compose service name,
as seen from the SSH host), opens the toolbar **Files** popover, checks its
route line names the SSH host the bytes land on, and uploads a file with
**Upload files…** (the native picker is stubbed through the bridge — an OS
drag-and-drop cannot be synthesised). The bytes are then read back inside the
SSH container, and a second upload of the same name proves the "keep both"
rule (``name (1).ext``, never an overwrite).

Phase 3 (#4193): **Browse remote files** opens the ordinary File Browser on the
same side channel — its route line names the SSH host and carrier — and the
browser's own Download (Save dialog stubbed) brings a file seeded in the SSH
container back to the local disk through the Transfers queue.

Integration-only (``-m integration``): it needs the Docker ``vnc`` profile and
the SSH fixture, so it runs in the nightly lane and skips cleanly without a
container runtime.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    SSH_HOST,
    SSH_PASSWORD,
    SSH_PASSWORD_PORT,
    SSH_PASSWORD_SERVICE,
    SSH_USERNAME,
    VNC_PASSWORD,
    ConnectionsUi,
    ContainerControl,
    FilesUi,
    PasswordPromptUi,
    RemoteDesktopUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    unique_name,
)

pytestmark = pytest.mark.integration

#: The VNC server as seen from inside the SSH container (compose service name).
TUNNELLED_VNC_HOST = "vnc-server"
TUNNELLED_VNC_PORT = 5900
#: Upload folder on the SSH host: absolute, writable, and present in the image.
DEST_DIR = "/tmp"
#: Budget for the tunnelled session to connect and go Active.
CONNECT_TIMEOUT = 90.0
#: Budget for a small upload to finish and its summary toast to appear.
UPLOAD_TIMEOUT = 60.0

FILES_BTN = "remote-desktop-files-btn"
FILES_ROUTE = "remote-desktop-files-route"
FILES_UPLOAD = "remote-desktop-files-upload"
UPLOAD_TOAST = "remote-desktop-upload-toast"
FILES_BROWSE = "remote-desktop-files-browse"
BROWSE_ROUTE = "remote-desktop-browse-route"
#: Budget for a small download to land on the local disk.
DOWNLOAD_TIMEOUT = 60.0


@pytest.mark.usefixtures("vnc_fixtures", "ssh_password_fixtures")
class TestVncFileTransferOverSshTunnel(
    RemoteDesktopUi,
    PasswordPromptUi,
    SettingsUi,
    FilesUi,
    SidebarUi,
    TabsUi,
    ConnectionsUi,
    SystemTest,
):
    """VNC-FT-UI-01/02: upload to the SSH host (keep-both), browse and download back."""

    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT

    def _create_tunnelled_vnc(self, name: str) -> None:
        """Fill the VNC editor with the SSH tunnel + File Transfer and connect."""
        self.open_new_connection_editor()
        self.driver.type("connection-editor-name-input", name)
        self.select_connection_type("vnc")
        self.wait(lambda: self.driver.exists("field-host"), what="the VNC connection fields")
        self.driver.type("field-host", TUNNELLED_VNC_HOST)
        self.driver.type("field-port", str(TUNNELLED_VNC_PORT))
        self.driver.click("field-useSshTunnel")
        self.wait(lambda: self.driver.exists("field-sshHost"), what="the SSH tunnel fields")
        self.driver.type("field-sshHost", SSH_HOST)
        self.driver.type("field-sshPort", str(SSH_PASSWORD_PORT))
        self.driver.type("field-sshUsername", SSH_USERNAME)
        self.driver.type("field-sshPassword", SSH_PASSWORD)
        self.driver.click("field-fileTransfer")
        self.wait(
            lambda: self.driver.exists("field-fileTransferDir"),
            what="the File Transfer default-folder field",
        )
        self.driver.type("field-fileTransferDir", DEST_DIR)
        self._click_editor_save(True)

    def _open_session(self) -> None:
        self.enable_experimental_features()
        self.close_all_tabs()
        name = unique_name("vnc-ft")
        self._create_tunnelled_vnc(name)
        self.handle_password_prompt(VNC_PASSWORD)
        self.accept_host_key_prompt()
        self.wait(
            lambda: self.remote_desktop_phase() == "active",
            timeout=CONNECT_TIMEOUT,
            what="the tunnelled VNC session to become active",
        )

    def _route_text(self) -> str:
        if not self.driver.exists(FILES_ROUTE):
            if self.driver.get_attribute(FILES_BTN, "aria-pressed") != "true":
                self.driver.click(FILES_BTN)
            return ""
        return self.driver.get_text(FILES_ROUTE)

    def _upload(self, local: Path) -> str:
        """Upload ``local`` with Upload files… and return the summary toast text."""
        self.driver.stub_native_dialog("open", local)
        self.driver.click(FILES_UPLOAD)
        return self.wait(
            lambda: (
                self.driver.exists(UPLOAD_TOAST)
                and "Uploaded" in (text := self.driver.get_text(UPLOAD_TOAST))
                and text
            ),
            timeout=UPLOAD_TIMEOUT,
            what="the upload summary toast",
        )

    def test_upload_lands_on_the_ssh_host_and_keeps_both(self, tmp_path: Path):
        self._open_session()
        self.wait(lambda: self.driver.exists(FILES_BTN), what="the toolbar Files button")
        route = self.wait(
            lambda: f"on {SSH_HOST}" in (text := self._route_text()) and text,
            timeout=CONNECT_TIMEOUT,
            what="the Files popover route line",
        )
        assert DEST_DIR in route and "SFTP via SSH tunnel" in route, route

        stem = f"vnc-ft-{uuid.uuid4().hex[:8]}"
        local = tmp_path / f"{stem}.txt"
        local.write_text("first upload\n", encoding="utf-8")
        toast = self._upload(local)
        assert f"Uploaded 1 file to {DEST_DIR} on {SSH_HOST}" in toast, toast

        ssh = ContainerControl(SSH_PASSWORD_SERVICE)
        assert ssh.exec("cat", f"{DEST_DIR}/{stem}.txt") == "first upload\n"

        # Same name again: keep both, never overwrite.
        local.write_text("second upload\n", encoding="utf-8")
        self.driver.click("remote-desktop-files-close")
        self.wait(lambda: not self.driver.exists(UPLOAD_TOAST), what="the first toast to clear")
        self.wait(lambda: f"on {SSH_HOST}" in self._route_text(), what="the popover to reopen")
        self._upload(local)
        assert ssh.exec("cat", f"{DEST_DIR}/{stem}.txt") == "first upload\n"
        assert ssh.exec("cat", f"{DEST_DIR}/{stem} (1).txt") == "second upload\n"
        ssh.exec("rm", "-f", f"{DEST_DIR}/{stem}.txt", f"{DEST_DIR}/{stem} (1).txt")

    def test_browse_remote_files_downloads_from_the_ssh_host(self, tmp_path: Path):
        """VNC-FT-UI-02 (#4193): Browse remote files → File Browser → Download."""
        ssh = ContainerControl(SSH_PASSWORD_SERVICE)
        name = f"vnc-ft-dl-{uuid.uuid4().hex[:8]}.txt"
        ssh.exec("sh", "-c", f"printf 'from the desktop host\\n' > {DEST_DIR}/{name}")
        try:
            self._open_session()
            self.wait(lambda: self.driver.exists(FILES_BTN), what="the toolbar Files button")
            self.wait(
                lambda: f"on {SSH_HOST}" in self._route_text(),
                timeout=CONNECT_TIMEOUT,
                what="the Files popover route line",
            )
            self.driver.click(FILES_BROWSE)

            # The File Browser opens on the side channel, at the upload folder.
            route = self.wait(
                lambda: self.driver.exists(BROWSE_ROUTE) and self.driver.get_text(BROWSE_ROUTE),
                what="the File Browser's route line",
            )
            assert SSH_HOST in route and "SFTP via SSH tunnel" in route, route
            self.wait_for_file_row(name)

            target = tmp_path / name
            self.open_file_menu(name)
            self.driver.stub_native_dialog("save", target)
            self.driver.click("context-file-download")
            text = self.wait(
                lambda: target.exists() and target.read_text(encoding="utf-8"),
                timeout=DOWNLOAD_TIMEOUT,
                what=f"the download to land at {target}",
            )
            assert text == "from the desktop host\n", text
        finally:
            ssh.exec("rm", "-f", f"{DEST_DIR}/{name}")
