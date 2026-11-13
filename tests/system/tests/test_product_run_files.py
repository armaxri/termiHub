"""Product run, phase 3: the file browser over SFTP (#5535).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). An SSH session on the run's native sshd
(:mod:`termihub_harness.product_run.hosts`) opens the Files sidebar on a
scratch folder inside the fixture's state dir; every check is graded on the
host's disk (the native sshd serves this machine, so the remote side is read
back directly) and recorded with a window capture and an ``expect`` line.

Steps: open on the scratch folder, list, navigate in and up, new folder and
file, rename, delete, upload and download (native dialogs stubbed by the
test bridge), drag onto a folder (a server-side rename: same inode), a long
path typed into the path bar, remote → local copy/paste, and the optional
Raspberry Pi listing (read-only). The path bar is being redesigned (#5520 /
#5521), so the long-path step grades behaviour (where the browser is and
what it lists), not the header layout.

Nothing is written outside the run directory: the remote scratch folder lives
in the fixture's state dir (removed with it), the local side in the run dir.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from termihub_harness import (
    SSH_HOST,
    ConnectionsUi,
    FilesUi,
    PasswordPromptUi,
    SftpUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    file_row_testid,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.ssh_steps import HOSTKEY_ACCEPT_REMEMBER, SshPhaseUi

pytestmark = [
    pytest.mark.product_run,
    pytest.mark.integration,
    pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's sshd is POSIX-only"),
]

#: Seeded remote entries: name -> contents (``None`` = a folder).
SEED = {
    "alpha.txt": "alpha\n",
    "rename-me.txt": "rename me\n",
    "delete-me.txt": "delete me\n",
    "download-me.txt": "downloaded over sftp\n",
    "drag-me.txt": "drag me over sftp\n",
    "copy-me.txt": "remote to local\n",
    "beta": None,
    "beta/inner.txt": "inner\n",
}
#: The long path: six nested folders with long names, a file at the bottom.
LONG_SEGMENTS = [f"{i}-a-rather-long-folder-name-for-the-path-bar-check" for i in range(1, 7)]
CTX_RENAME = "context-file-rename"
CTX_DOWNLOAD = "context-file-download"
CTX_COPY = "context-file-copy"
RENAME_INPUT = "file-row-rename-input"
UPLOAD = "file-browser-upload"
PATH_EDIT = "file-browser-path-edit"
PATH_INPUT = "file-browser-path-input"


def _read(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return None


class TestProductRunFiles(
    ProductRunUi,
    SshPhaseUi,
    FilesUi,
    SftpUi,
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SystemTest,
):
    phase = "File browser / SFTP"
    request_timeout = 90.0

    # ── setup ────────────────────────────────────────────────────────────────
    def _seed(self, root: Path) -> None:
        root.mkdir(parents=True, exist_ok=True)
        for rel, content in SEED.items():
            path = root / rel
            if content is None:
                path.mkdir(exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")
        deep = root.joinpath(*LONG_SEGMENTS)
        deep.mkdir(parents=True, exist_ok=True)
        (deep / "deep-file.txt").write_text("at the bottom\n", encoding="utf-8")

    @property
    def remote(self) -> Path:
        return type(self).remote_root

    def _clear_filter(self) -> None:
        if self.driver.exists(self.FILTER):
            self.clear_entry_filter()

    def test_00_open(self):
        with self.step(
            "files.open",
            "The Files sidebar opens on the SSH session's folder over SFTP",
            expect="the Files sidebar listing the remote scratch folder (alpha.txt, beta, …) beside the SSH tab",
        ):
            native = self.need_native()
            root = (native.session_home or Path(native.target.state_dir)) / "pr-files"
            self._seed(root)
            type(self).remote_root = root
            name = unique_name("pr-files")
            self.switch_to_connections_sidebar()
            self.create_ssh_connection(
                name, host=SSH_HOST, port=native.target.port, username=native.target.username,
                auth_method="key", key_path=str(native.client_key), connect=True,
            )
            self.accept_all_hostkeys(timeout=15.0)
            tab_id = self.tab_id_of(name)
            self.wait_connected(tab_id)
            type(self).ssh_tab = tab_id
            # Into the scratch folder before the browser opens: never list the real home.
            self.run_command(f"cd '{root}'")
            self.echo_round_trip(tab_id, "PR_FILES_CD_OK")
            path = self.connect_sftp_browser()
            path = self.wait_for_path_contains("pr-files")
            self.evidence(f"browser path: {path}")
            assert path.rstrip("/").endswith("pr-files"), path

    def test_01_list_and_navigate(self):
        with self.step(
            "files.list",
            "The listing shows the seeded files and folder",
            expect="the remote folder's rows: alpha.txt, beta, copy-me.txt, delete-me.txt, …",
        ):
            self.require("files.open")
            for name in ("alpha.txt", "beta", "rename-me.txt", LONG_SEGMENTS[0]):
                self.wait_for_file_row(name, refresh_every=0)
            self._clear_filter()
            self.evidence("rows: alpha.txt, beta, rename-me.txt, the long-path folder")
        with self.step(
            "files.navigate",
            "Double-click enters a folder; Up returns to the parent",
            expect="the remote scratch folder again after entering beta and going up",
        ):
            self.require("files.open")
            inner = self.enter_directory("beta")
            self.wait_for_file_row("inner.txt", refresh_every=0)
            self.evidence(f"in: {inner}")
            assert inner.rstrip("/").endswith("/beta"), inner
            back = self.navigate_up()
            self.evidence(f"up: {back}")
            assert back.rstrip("/").endswith("pr-files"), back

    def test_02_create_rename_delete(self):
        with self.step(
            "files.new-folder",
            "New Folder creates a folder on the host",
            expect="the listing filtered to the new folder 'made-in-app'",
        ):
            self.require("files.open")
            self.create_folder_via_browser("made-in-app")
            self.wait(lambda: (self.remote / "made-in-app").is_dir(), what="the folder on the host")
        with self.step(
            "files.new-file",
            "New File creates an empty file on the host",
            expect="the listing filtered to the new file 'made-in-app.txt'",
        ):
            self.require("files.open")
            self._clear_filter()
            self.create_file_via_browser("made-in-app.txt")
            self.wait(lambda: (self.remote / "made-in-app.txt").is_file(), what="the file on the host")
        with self.step(
            "files.rename",
            "Rename (context menu, inline edit, Enter) renames the file on the host",
            expect="the listing showing renamed.txt where rename-me.txt was",
        ):
            self.require("files.open")
            self._clear_filter()
            self.open_file_menu("rename-me.txt")
            self.driver.click(CTX_RENAME)
            self.wait(lambda: self.driver.exists(RENAME_INPUT), what="the inline rename field")
            self.driver.type(RENAME_INPUT, "renamed.txt")
            self.driver.press_key("Enter", RENAME_INPUT)
            self.wait(
                lambda: _read(self.remote / "renamed.txt") == "rename me\n"
                and not (self.remote / "rename-me.txt").exists(),
                what="the rename on the host",
            )
            self.wait_for_file_row("renamed.txt")
        with self.step(
            "files.delete",
            "Delete (with confirmation) removes the file on the host",
            expect="the listing without delete-me.txt",
        ):
            self.require("files.open")
            self._clear_filter()
            self.delete_entry("delete-me.txt")
            self.wait(lambda: not (self.remote / "delete-me.txt").exists(), what="the file gone")

    def test_03_upload_download(self):
        local = self.recorder.run_dir / "files-local"
        local.mkdir(parents=True, exist_ok=True)
        with self.step(
            "files.upload",
            "Upload (toolbar) copies a picked local file into the remote folder",
            expect="the listing filtered to uploaded.txt",
        ):
            self.require("files.open")
            self._clear_filter()
            source = local / "uploaded.txt"
            source.write_text("uploaded by the product run\n", encoding="utf-8")
            self.driver.stub_native_dialog("open", source)
            self.driver.click(UPLOAD)
            self.wait(
                lambda: _read(self.remote / "uploaded.txt") == "uploaded by the product run\n",
                what="the uploaded file on the host",
            )
            self.wait_for_file_row("uploaded.txt")
        with self.step(
            "files.download",
            "Download (context menu) saves the remote file to the picked local path",
            expect="the remote listing after the download (a 'Downloaded' notice may show)",
        ):
            self.require("files.open")
            self._clear_filter()
            target = local / "downloaded.txt"
            self.open_file_menu("download-me.txt")
            self.driver.stub_native_dialog("save", target)
            self.driver.click(CTX_DOWNLOAD)
            self.wait(lambda: _read(target) == SEED["download-me.txt"], what="the local copy")
            self.evidence(f"local copy {target} holds {_read(target)!r}")

    def test_04_drag(self):
        with self.step(
            "files.drag",
            "Dragging a file onto a folder moves it on the host (a rename: same inode)",
            expect="the listing without drag-me.txt (it is now inside beta)",
        ):
            self.require("files.open")
            self._clear_filter()
            source, moved = self.remote / "drag-me.txt", self.remote / "beta" / "drag-me.txt"
            inode = os.stat(source).st_ino
            self.filter_entries("e")  # drag-me.txt and beta both contain an "e"
            self.wait(
                lambda: self.file_row_exists("drag-me.txt") and self.file_row_exists("beta"),
                what="both rows mounted",
            )
            dest = file_row_testid("beta")
            seen = self.driver.drag_to(file_row_testid("drag-me.txt"), dest, observe=[dest])
            self.evidence(f"drop highlight: {seen[dest]['attributes'].get('data-drop-highlight')!r}")
            self.wait(lambda: moved.is_file() and not source.exists(), what="the move on the host")
            assert _read(moved) == SEED["drag-me.txt"]
            assert os.stat(moved).st_ino == inode, "the move was not a server-side rename"

    def test_05_long_path(self):
        with self.step(
            "files.long-path",
            "A long path typed into the path bar opens; the listing and Up work there",
            expect="the browser six folders deep, listing deep-file.txt; the path bar is long "
            "(its layout is being redesigned in #5520/#5521, judge readability, not the old design)",
        ):
            self.require("files.open")
            deep = self.remote.joinpath(*LONG_SEGMENTS)
            self.evidence(f"path length: {len(str(deep))} characters")
            self.driver.click(PATH_EDIT)
            self.wait(lambda: self.driver.exists(PATH_INPUT), what="the path field")
            self.driver.type(PATH_INPUT, str(deep))
            self.driver.press_key("Enter", PATH_INPUT)
            path = self.wait_for_path_contains(LONG_SEGMENTS[-1])
            assert path.rstrip("/") == str(deep), f"browser is at {path!r}"
            self.wait_for_file_row("deep-file.txt", refresh_every=0)
            self.shot(label="deep")
            parent = self.navigate_up()
            assert parent.rstrip("/") == str(deep.parent), parent
            self.wait_for_path_contains(LONG_SEGMENTS[-2])
            self.evidence(f"Up -> {parent}")

    def test_06_remote_to_local(self):
        with self.step(
            "files.remote-to-local",
            "Copy a remote file, browse a local folder, Paste: it lands locally byte for byte",
            expect="the Files sidebar on the local folder listing copy-me.txt",
        ):
            self.require("files.open")
            dest = self.recorder.run_dir / "files-local" / "paste-here"
            dest.mkdir(parents=True, exist_ok=True)
            self.switch_to_tab(self.ssh_tab)
            self.switch_to_files_sidebar()
            self.driver.click(PATH_EDIT)
            self.wait(lambda: self.driver.exists(PATH_INPUT), what="the path field")
            self.driver.type(PATH_INPUT, str(self.remote))
            self.driver.press_key("Enter", PATH_INPUT)
            self.wait(lambda: self.file_browser_path().rstrip("/").endswith("pr-files"), what="the scratch folder")
            self.open_file_menu("copy-me.txt")
            self.driver.click(CTX_COPY)
            before = self.tab_ids()
            self.switch_to_connections_sidebar()
            self.open_new_terminal()
            self.wait(lambda: len(self.tab_ids()) == len(before) + 1, what="a local terminal")
            local_tab = next(t for t in self.tab_ids() if t not in before)
            self.wait(lambda: self.driver.read_terminal(local_tab).strip(), what="the local prompt")
            self.run_command(f"cd '{dest}'")
            self.switch_to_files_sidebar()
            self.wait_for_path_contains("paste-here")
            self.wait(lambda: self.driver.get_attribute(self.PASTE, "disabled") is None, what="Paste enabled")
            self.driver.click(self.PASTE)
            self.wait(lambda: _read(dest / "copy-me.txt") == SEED["copy-me.txt"], what="the local copy")
            self.wait_for_file_row("copy-me.txt")
            assert self.ssh_tab in self.tab_ids(), "the remote tab closed"

    def test_07_raspberry_pi(self):
        pi = self.inputs.get("raspberry_pi")
        if pi is None or not str(pi.get("key_path") or "").strip():
            reason = self.inputs.missing("raspberry_pi") or (
                "raspberry_pi.key_path not given (the SFTP listing leg runs with key auth only)"
            )
            self.not_tested("files.raspberry-pi", "Raspberry Pi home over SFTP (real device)", reason)
            return
        with self.step(
            "files.raspberry-pi",
            "Raspberry Pi: the Files sidebar lists its home over SFTP (read-only)",
            expect="the Files sidebar listing the Pi user's home folder",
        ):
            name = unique_name("pr-files-pi")
            self.close_all_tabs()
            self.switch_to_connections_sidebar()
            self.create_ssh_connection(
                name, host=str(pi["host"]), port=int(pi.get("port") or 22),
                username=str(pi["user"]), auth_method="key", key_path=str(pi["key_path"]),
                connect=True,
            )
            tab_id = self.tab_id_of(name)
            self.wait(
                lambda: self.hostkey_prompt_open() or self.session_status(tab_id) == "connected",
                timeout=120.0, what="the Pi host-key prompt or session",
            )
            if self.hostkey_prompt_open():
                self.answer_hostkey_prompt(HOSTKEY_ACCEPT_REMEMBER)
            self.wait_connected(tab_id, timeout=120.0)
            path = self.connect_sftp_browser()
            self.evidence(f"Pi browser path: {path}")
            assert path.startswith("/"), path
