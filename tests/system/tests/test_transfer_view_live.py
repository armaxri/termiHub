"""The dual-pane transfer view against a live SSH host (PROD-007, #3558, #4007).

``TransferView.test.tsx`` covers the view with every IPC mocked. This drives the
real app against the Docker ``ssh-password`` fixture and checks the bytes, not
just the listing:

- **upload via the arrow** — a local file selected in the left pane and copied
  with the → button lands on the host, byte for byte;
- **pane-to-pane drag of a nested folder** — a remote folder dragged onto the
  local pane is recreated locally with its whole tree;
- **cancel a large transfer** — a 2 GiB upload cancelled from its row settles on
  ``cancelled`` and never reaches the host at full size;
- **close the SSH tab, then re-pick a remote** — the view outlives its session,
  asks for a remote, and browses the one picked from the header.

The view is opened the way a user does: the SFTP browser's "Open dual-pane
transfer view" button. The local pane is pointed at a fresh temp dir (removed
afterwards) through its path field, so nothing lands in ``$HOME``; every remote
path is a unique name in the test user's home, removed afterwards.
"""

from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

import pytest

from termihub_harness import (
    ConnectionsUi,
    ContainerRuntimeUnavailable,
    FilesUi,
    PasswordPromptUi,
    ProjectionHarness,
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

#: The ``ssh-password`` fixture user's home (``useradd -m testuser``).
REMOTE_HOME = "/home/testuser"
#: The upload the cancel test starts: big enough that a localhost SFTP upload is
#: still running when the cancel lands (a sparse local file, so it costs no disk).
LARGE_BYTES = 2 * 1024 * 1024 * 1024

OPEN_TRANSFER_VIEW = "file-browser-open-transfer-view"
VIEW = "transfer-view"
NO_REMOTE = "transfer-view-no-remote"
REMOTE_PICKER = "transfer-view-remote-picker"
COPY_TO_REMOTE = "transfer-view-copy-to-remote"
CANCEL = "transfer-cancel"


def pane_row(side: str, name: str) -> str:
    """The testid of ``name``'s row in the ``local`` / ``remote`` pane."""
    return f"transfer-pane-{side}-row-{name}"


@pytest.mark.usefixtures("ssh_password_fixtures")
class TestTransferViewLive(
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SshUi,
    SftpUi,
    FilesUi,
    ProjectionHarness,
    SystemTest,
):
    _transfers_sub_id: str | None = None

    @pytest.fixture(autouse=True)
    def _workspace(self):
        """A fresh local dir for the left pane; tabs + remote paths cleaned after."""
        self._host = SshServerControl()
        if not self._host.available:
            pytest.skip("no container runtime to check the host side of a transfer")
        self._local = Path(tempfile.mkdtemp(prefix="e2e_tv_"))
        self._remote_paths: list[str] = []
        try:
            yield
        finally:
            self.close_all_tabs()
            self.switch_to_connections_sidebar()
            shutil.rmtree(self._local, ignore_errors=True)
            for path in self._remote_paths:
                try:
                    self._host.remove_path(path)
                except ContainerRuntimeUnavailable:
                    pass

    # -- helpers -----------------------------------------------------------------
    def _remote(self, name: str) -> str:
        """``name`` in the remote home, registered for cleanup."""
        path = f"{REMOTE_HOME}/{name}"
        self._remote_paths.append(path)
        return path

    def _connect(self) -> str:
        """Connect a password SSH session; return its terminal tab id."""
        before = set(self.tab_ids())
        self.connect_ssh_password(unique_name("tv-conn"))
        return self.wait(
            lambda: next((t for t in self.tab_ids() if t not in before), None),
            what="the new SSH tab",
        )

    def _view_tab_id(self) -> str:
        return self.wait(
            lambda: next(
                (t["id"] for t in self._all_tabs() if t.get("contentType") == "transfer-view"),
                None,
            ),
            what="the transfer-view tab",
        )

    def _open_view(self) -> str:
        """Connect, open the view from the SFTP browser, point the local pane.

        Returns the SSH terminal tab id. The remote pane starts in the folder the
        browser shows (the home dir the terminal logs into).
        """
        ssh_tab = self._connect()
        self.connect_sftp_browser()
        self.wait_for_path_contains(REMOTE_HOME)
        self.driver.click(OPEN_TRANSFER_VIEW)
        self.wait(lambda: self.driver.exists(VIEW), what="the transfer view")
        self.wait(
            lambda: self.driver.get_value("transfer-pane-remote-path") == REMOTE_HOME,
            what="the remote pane to list the home dir",
        )
        self._point_local_pane()
        return ssh_tab

    def _point_local_pane(self) -> None:
        # Forward slashes: the local listing accepts them on Windows too (#2683).
        target = str(self._local).replace("\\", "/")
        self.driver.type("transfer-pane-local-path", target)
        self.driver.press_key("Enter", "transfer-pane-local-path")
        self.wait(
            lambda: self._local.name in self.driver.get_value("transfer-pane-local-path"),
            what="the local pane to enter the temp dir",
        )

    def _refresh(self, side: str) -> None:
        self.driver.click(f"transfer-pane-{side}-refresh")

    def _wait_for_row(self, side: str, name: str) -> None:
        def listed() -> bool:
            if self.driver.exists(pane_row(side, name)):
                return True
            self._refresh(side)
            return False

        self.wait(listed, what=f"{name!r} in the {side} pane")

    def _transfer_to(self, remote_path: str) -> dict | None:
        """The queue entry whose remote path is ``remote_path``, if registered.

        Read from the authoritative ``transfers`` projection region (#2229), not
        the DOM: the global Transfer Queue panel keeps earlier tests' rows, so a
        bare ``transfer-row-status`` read could hit another transfer's row.
        """
        if self._transfers_sub_id is None:
            self._transfers_sub_id = self.projection_subscribe("transfers")["subscriptionId"]
        cache = self.driver.projection_state(self._transfers_sub_id).get("cache") or {}
        queue = (cache.get("view") or {}).get("queue") or {}
        return next((e for e in queue.values() if e.get("path") == remote_path), None)

    # -- tests -------------------------------------------------------------------
    def test_arrow_uploads_the_selected_local_file(self):
        name = f"{unique_name('tv-up')}.txt"
        content = "uploaded through the transfer view\n"
        (self._local / name).write_bytes(content.encode())
        remote_path = self._remote(name)

        self._open_view()
        self._wait_for_row("local", name)
        self.driver.click(pane_row("local", name))
        self.wait(
            lambda: self.driver.get_attribute(COPY_TO_REMOTE, "disabled") is None,
            what="the → button to enable for the selection",
        )
        self.driver.click(COPY_TO_REMOTE)

        self.wait(
            lambda: self._host.path_exists(remote_path)
            and self._host.read_file(remote_path) == content,
            what="the file to land on the host byte for byte",
        )
        self._wait_for_row("remote", name)

    @pytest.mark.skipif(
        sys.platform == "win32",
        reason="the bridge's pointer drag never lands on Windows yet (#4110)",
    )
    def test_dragging_a_remote_folder_onto_the_local_pane_copies_its_tree(self):
        name = unique_name("tv-dir")
        remote_dir = self._remote(name)
        self._host.write_file(f"{remote_dir}/top.txt", "top\n", user="testuser")
        self._host.write_file(f"{remote_dir}/sub/nested.txt", "nested\n", user="testuser")

        self._open_view()
        self._wait_for_row("remote", name)
        self.driver.drag_to(pane_row("remote", name), "transfer-pane-local")

        top = self._local / name / "top.txt"
        nested = self._local / name / "sub" / "nested.txt"
        self.wait(
            lambda: top.is_file()
            and nested.is_file()
            and top.read_bytes() == b"top\n"
            and nested.read_bytes() == b"nested\n",
            what="the dragged folder's tree to land locally",
        )
        self._wait_for_row("local", name)

    def test_cancelling_a_large_upload_stops_it_short_of_the_host(self):
        name = f"{unique_name('tv-big')}.bin"
        with open(self._local / name, "wb") as f:
            f.truncate(LARGE_BYTES)  # sparse: no disk cost locally
        remote_path = self._remote(name)

        self._open_view()
        self._wait_for_row("local", name)
        self.driver.click(pane_row("local", name))
        self.driver.click(COPY_TO_REMOTE)

        # Earlier rows are settled (no Cancel), so the only Cancel is this upload's.
        self.wait(
            lambda: (self._transfer_to(remote_path) or {}).get("state") in ("queued", "active")
            and self.driver.exists(CANCEL),
            what="the running upload's Cancel",
        )
        self.driver.click(CANCEL)
        entry = self.wait(
            lambda: (lambda e: e if e and e.get("state") not in ("queued", "active") else None)(
                self._transfer_to(remote_path)
            ),
            what="the upload to settle",
        )
        assert entry["state"] == "cancelled", f"the upload settled as {entry['state']!r}"
        # Settled, not finished: the host never holds the whole file.
        size = self._host.file_size(remote_path)
        assert size is None or size < LARGE_BYTES, f"the cancelled upload completed ({size} B)"

    def test_closing_the_ssh_tab_then_picking_another_remote(self):
        name = f"{unique_name('tv-repick')}.txt"
        self._host.write_file(self._remote(name), "pick me\n", user="testuser")

        first = self._open_view()
        view = self._view_tab_id()

        # The view outlives the session it was opened for and asks for a remote.
        self.close_tab(first)
        self.wait(lambda: first not in self.tab_ids(), what="the SSH tab to close")
        self.switch_to_tab(view)
        self.wait(lambda: self.driver.exists(NO_REMOTE), what="the view to ask for a remote")

        # A new session becomes selectable; picking it browses its home.
        second = self._connect()
        self.switch_to_tab(view)
        self.wait(lambda: self.driver.exists(VIEW), what="the transfer view")
        self.driver.select(REMOTE_PICKER, second)
        self.wait(lambda: not self.driver.exists(NO_REMOTE), what="the picked remote to attach")
        self._wait_for_row("remote", name)
