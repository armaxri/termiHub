"""FTP file browser against the ``ftp-server`` fixture from the real app (#1333, #4006).

The FTP backend's listing/transfer code is covered without UI against the same
fixture in ``core/tests/ftp_file_browser.rs``. This drives the user's path end
to end over the test bridge:

- create a plain-FTP connection in the editor (anonymous login, the fixture's
  read-only browse account) and connect it from the sidebar, accepting the
  insecure-FTP warning (#1338) — FTP is terminal-less, so it opens a
  ``file-browser`` tab and browsing happens in the Files sidebar;
- list ``/pub`` and check it holds exactly the seeded top-level entries
  (``tests/docker/ftp-server/generate-test-data.sh``), then a subfolder;
- open ``/pub/readme.txt`` in the editor (an FTP-backed buffer);
- copy ``readme.txt`` and the binary ``data/dataset-8k.bin`` from the FTP
  browser and paste them into a local folder — the download path — then
  compare the bytes on disk against the fixture.

The fixture is plain FTP on ``TERMIHUB_TEST_FTP_PORT`` (base 2401, offset per
checkout). Its passive range is advertised as ``127.0.0.1`` so the data channel
reaches the published ports.
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

import pytest

from termihub_harness import (
    ComposeFixture,
    ConnectionsUi,
    ContainerRuntimeUnavailable,
    EditorUi,
    FilesUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
    wait_for_banner,
)
from termihub_harness.dev_local import service_port

pytestmark = pytest.mark.integration

#: The compose service (``tests/docker/ftp-server``) and its plain-FTP control port.
FTP_SERVICE = "ftp-server"
FTP_HOST = "127.0.0.1"
FTP_PORT = service_port("TERMIHUB_TEST_FTP_PORT", 2401)

#: The top-level entries ``generate-test-data.sh`` seeds under ``/pub``.
PUB_ENTRIES = ("docs", "images", "data", "readme.txt", "welcome.txt")
#: The four text files seeded under ``/pub/docs``.
PUB_DOCS = ("guide.txt", "manual.txt", "changelog.txt", "faq.txt")
#: Siblings of ``/pub`` in the anonymous root that must NOT list inside it.
NOT_IN_PUB = ("uploads", "links", "pub")

#: Fixed content of ``/pub/readme.txt`` (``printf '%s\\n'`` in the seed script).
README_BYTES = b"termiHub FTP test server. See pub/docs for more information.\n"
#: ``/pub/data/dataset-8k.bin``: 8192 zero bytes.
DATASET_8K_BYTES = b"\0" * 8192

#: The insecure-FTP pre-connect modal and its Connect Anyway button (#1338).
WARNING_MODAL = "insecure-ftp-warning"
CONFIRM = "confirm-dialog-confirm"
#: The terminal-less tab body; its Retry button only mounts on a failed connect.
FILE_BROWSER_TAB = "file-browser-tab"
FILE_BROWSER_TAB_RETRY = "file-browser-tab-retry"
#: Context-menu Copy on a file-browser row, and the FTP editor badge.
CTX_FILE_COPY = "context-file-copy"
FTP_EDITOR_BADGE = "file-editor-ftp-badge"


@pytest.fixture(scope="module")
def ftp_fixture():
    """Bring up ``ftp-server`` under this checkout's isolation, or skip."""
    fixture = ComposeFixture()
    try:
        fixture.ensure(FTP_SERVICE)
        # Docker's forwarder accepts before ProFTPD listens; wait for its greeting.
        wait_for_banner(FTP_HOST, FTP_PORT, b"220", timeout=90.0)
    except ContainerRuntimeUnavailable as exc:
        pytest.skip(f"FTP container fixture unavailable: {exc}")
    return fixture


@pytest.mark.usefixtures("ftp_fixture")
class TestFtpFileBrowserLive(
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    FilesUi,
    EditorUi,
    SystemTest,
):
    @pytest.fixture(autouse=True)
    def _local_dest(self):
        """A fresh local paste destination; tabs are closed afterwards."""
        dest = Path(tempfile.mkdtemp(prefix="e2e_ftp_"))
        self._dest = dest
        try:
            yield dest
        finally:
            self.close_all_tabs()
            self.switch_to_connections_sidebar()
            shutil.rmtree(dest, ignore_errors=True)

    # -- helpers -----------------------------------------------------------------
    def _connect_ftp(self, purpose: str) -> str:
        """Create + connect an anonymous FTP connection; return the browser path.

        Plain FTP raises the insecure-FTP modal on the sidebar connect; Connect
        Anyway opens the ``file-browser`` tab, whose session the Files sidebar
        then lists.
        """
        name = unique_name(purpose)
        self.create_ftp_connection(
            name, host=FTP_HOST, port=FTP_PORT, tls_mode="none", anonymous=True
        )
        self.connect_connection(name)
        self.wait(lambda: self.driver.exists(WARNING_MODAL), what="the insecure-FTP warning")
        self.driver.click(CONFIRM)
        self.wait(lambda: self.find_tab(name), what="the FTP tab to open")
        self.wait(lambda: self.driver.exists(FILE_BROWSER_TAB), what="the FTP file-browser tab")

        self.switch_to_files_sidebar()

        def listed() -> str | None:
            if self.driver.exists(FILE_BROWSER_TAB_RETRY):
                raise AssertionError(
                    "FTP connect failed: " + self.driver.get_text(FILE_BROWSER_TAB)
                )
            return self.file_browser_path() or None

        return self.wait(listed, what="the FTP listing")

    def _assert_lists_exactly(self, expected: tuple[str, ...]) -> None:
        """Every ``expected`` entry lists; nothing from ``NOT_IN_PUB`` does."""
        for entry in expected:
            # Filters to the entry (and refreshes) until its row mounts.
            self.wait_for_file_row(entry)
        self.clear_entry_filter()
        for entry in expected:
            assert self.file_row_exists(entry), f"{entry!r} missing from the listing"
        for stray in NOT_IN_PUB:
            assert not self.file_row_exists(stray), f"{stray!r} must not list here"

    def _open_pub(self) -> str:
        """Connect and enter ``/pub``; return its path."""
        root = self._connect_ftp("ftp-pub")
        assert root.startswith("/"), f"the FTP browser shows a remote path, got {root!r}"
        path = self.enter_directory("pub")
        assert path.rstrip("/").endswith("/pub"), path
        return path

    def _browse_local_dest(self) -> None:
        """Open a local terminal, ``cd`` into the paste destination, show it."""
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

    def _download_via_paste(self, name: str, size: int) -> bytes:
        """Copy FTP row ``name``, paste it into the local dest, return its bytes.

        Waits until the local copy reaches the fixture's ``size`` — the transfer
        queue writes it asynchronously — then hands back the whole file.
        """
        self.wait_for_file_row(name)
        self.open_file_menu(name)
        self.wait(lambda: self.driver.exists(CTX_FILE_COPY), what="the file Copy action")
        self.driver.click(CTX_FILE_COPY)

        self._browse_local_dest()
        self.wait(
            lambda: self.driver.get_attribute(self.PASTE, "disabled") is None,
            what="Paste to be enabled by the FTP clipboard",
        )
        self.driver.click(self.PASTE)

        landed = self._dest / name
        self.wait(
            lambda: landed.is_file() and landed.stat().st_size == size,
            what=f"{name!r} ({size} bytes) to land in the local folder",
        )
        return landed.read_bytes()

    # -- tests -------------------------------------------------------------------
    def test_lists_pub_and_its_subfolder(self):
        self._open_pub()
        self._assert_lists_exactly(PUB_ENTRIES)

        self.enter_directory("docs")
        self._assert_lists_exactly(PUB_DOCS)

    def test_opens_a_pub_file_in_the_editor(self):
        self._open_pub()
        self.open_file_in_editor("readme.txt")
        # The buffer is FTP-backed: the editor marks it with the FTP badge.
        self.wait(lambda: self.driver.exists(FTP_EDITOR_BADGE), what="the FTP editor badge")
        assert not self.driver.exists(self.ERROR), "the text file must load, not error"

    def test_downloads_a_text_file_matching_the_fixture(self):
        self._open_pub()
        content = self._download_via_paste("readme.txt", len(README_BYTES))
        assert content == README_BYTES

    def test_downloads_a_binary_file_matching_the_fixture(self):
        self._open_pub()
        self.enter_directory("data")
        content = self._download_via_paste("dataset-8k.bin", len(DATASET_8K_BYTES))
        assert content == DATASET_8K_BYTES
