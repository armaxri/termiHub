"""Automated external-app hand-off grades (#4932, part of #4927).

These replace guided-manual checks that asked an operator whether VS Code or
the OS file manager opened. The harness answers the machine-checkable half —
*what did termiHub hand the external program?* — without installing or
launching anything real:

- ``code`` (and on Linux ``xdg-open``) are recording PATH shims on the app's own
  ``PATH`` (:mod:`termihub_harness.external_shims`). The ``code`` shim answers
  ``--version`` so the app detects "VS Code", records every argv, and for
  ``--wait`` appends an edit to the file before it exits, like an editor would.
- Windows' Explorer is asked which folders it shows (``Shell.Application``);
  the windows the test opened are closed again.
- macOS opens folders with ``/usr/bin/open`` (no PATH lookup) and hosted runners
  refuse Finder automation, so there the grade is that the action succeeds
  without an error and that an ``.app`` bundle is revealed, never launched.
  A local run can add the Finder front-window check with
  ``TERMIHUB_ALLOW_FINDER_QUERY=1``.

Nothing here changes an OS default handler or touches the developer's own VS
Code or file manager, and no application is targeted by name.
"""

from __future__ import annotations

import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path

import psutil
import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    ConnectionsUi,
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
from termihub_harness.external_shims import (
    close_file_manager_folder,
    file_manager_folders,
    same_path,
)

pytestmark = pytest.mark.integration

#: Row context-menu items (``FileMenuItems`` with the ``context-file`` prefix).
_ROW_VSCODE = "context-file-vscode"
_ROW_FOLDER_VSCODE = "context-file-open-folder-vscode"
_ROW_FILE_MANAGER = "context-file-open-in-explorer"

_FILE = "handoff-notes.txt"
_SUBFOLDER = "handoff-subfolder"
_BUNDLE = "HandoffFixture.app"

#: Frontend log lines the file browser writes when a hand-off fails.
_HANDOFF_FAILED = re.compile(r"Open (folder )?in (VS Code|file manager) failed")


def _make_app_bundle(parent: Path) -> Path:
    """A minimal macOS ``.app`` whose executable drops a marker if it ever runs."""
    bundle = parent / _BUNDLE
    macos = bundle / "Contents" / "MacOS"
    macos.mkdir(parents=True)
    (bundle / "Contents" / "Info.plist").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<plist version="1.0"><dict>'
        "<key>CFBundleExecutable</key><string>HandoffFixture</string>"
        "<key>CFBundleIdentifier</key><string>dev.termihub.test.handoff-fixture</string>"
        "<key>CFBundlePackageType</key><string>APPL</string>"
        "</dict></plist>\n",
        encoding="utf-8",
    )
    exe = macos / "HandoffFixture"
    exe.write_text(f'#!/bin/sh\ntouch "{parent}/bundle-launched.marker"\n', encoding="utf-8")
    exe.chmod(0o755)
    return bundle


class TestLocalHandoffs(TerminalUi, TabsUi, SidebarUi, FilesUi, ConnectionsUi, SystemTest):
    """Local file browser → VS Code / OS file manager / SSH-agent helper."""

    external_app_shims = ("code", "xdg-open")

    @pytest.fixture(scope="class", autouse=True)
    def _workspace(self, request):
        root = Path(tempfile.mkdtemp(prefix="thub_handoff_"))
        (root / _FILE).write_text("hand me to an editor\n", encoding="utf-8")
        (root / _SUBFOLDER).mkdir()
        if sys.platform == "darwin":
            _make_app_bundle(root)
        request.cls.workspace = root
        try:
            yield root
        finally:
            shutil.rmtree(root, ignore_errors=True)

    # ── helpers ──────────────────────────────────────────────────────────────
    def _browse_workspace(self) -> None:
        """A local terminal ``cd``'d into the workspace, with Files showing it."""
        self.ensure_terminal()
        self.switch_to_connections_sidebar()
        # Forward slashes: valid in PowerShell, Git Bash and POSIX shells (#2683).
        self.run_command(f'cd "{str(self.workspace).replace(chr(92), "/")}"')
        self.switch_to_files_sidebar()
        self.wait_for_path_contains(self.workspace.name)

    def _vscode_detected(self) -> None:
        self.wait(
            lambda: bool(self.driver.get_state("vscodeAvailable")),
            what="the app to detect the shimmed VS Code (vscodeAvailable)",
        )

    def _app_log_text(self) -> str:
        """The captured app output plus the app's own log files."""
        parts = []
        paths = [self.app.log_path, *sorted(Path(self.app.log_dir).glob("*.log"))]
        for path in paths:
            try:
                parts.append(Path(path).read_text(encoding="utf-8", errors="replace"))
            except OSError:
                continue
        return "\n".join(parts)

    def _assert_file_manager_opened(self, folder: Path, *, after: int) -> None:
        """The OS file manager was asked to show ``folder`` (per-platform proof)."""
        if sys.platform.startswith("linux"):
            inv = self.shims.wait_for_handoff(
                "xdg-open", lambda i: i.target is not None, after=after
            )
            assert len(inv.argv) == 1 and same_path(inv.target, str(folder)), (
                f"xdg-open was handed {list(inv.argv)}, expected only the folder {folder}"
            )
            return
        try:
            folders = None
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                folders = file_manager_folders()
                if folders is None or any(same_path(f, str(folder)) for f in folders):
                    break
                time.sleep(0.5)
            if folders is not None:
                assert any(same_path(f, str(folder)) for f in folders), (
                    f"the file manager does not show {folder}; it shows {folders}"
                )
        finally:
            close_file_manager_folder(str(folder))
        assert not _HANDOFF_FAILED.search(self._app_log_text()), (
            "the app logged a failed file-manager hand-off"
        )

    # ── MT-FB-04 / MT-FB-14 ──────────────────────────────────────────────────
    def test_open_in_vscode_hands_the_local_file_to_code(self):
        """MT-FB-04, MT-FB-14: "Open in VS Code" on a local file runs ``code <file>``.

        The shim makes the app detect VS Code, so the menu item renders; the
        click must hand exactly that file's absolute path to ``code``.
        """
        self._vscode_detected()
        self._browse_workspace()
        before = len(self.shims.handoffs("code"))
        self.open_file_menu(_FILE)
        self.driver.click(_ROW_VSCODE)
        inv = self.shims.wait_for_handoff("code", lambda i: i.target is not None, after=before)
        assert len(inv.argv) == 1 and same_path(inv.target, str(self.workspace / _FILE)), (
            f"code was handed {list(inv.argv)}, expected only {self.workspace / _FILE}"
        )
        self.dismiss_menu()

    # ── MT-FB-22 ─────────────────────────────────────────────────────────────
    def test_open_folder_in_vscode_hands_the_folder_to_code(self):
        """MT-FB-22: the toolbar and the folder-row action open a VS Code workspace.

        Both run ``code <folder>`` with the folder's absolute path: the toolbar
        the current folder, the row action the clicked sub-folder.
        """
        self._vscode_detected()
        self._browse_workspace()
        before = len(self.shims.handoffs("code"))
        self.driver.click(self.OPEN_FOLDER_VSCODE)
        inv = self.shims.wait_for_handoff("code", lambda i: i.target is not None, after=before)
        assert len(inv.argv) == 1 and same_path(inv.target, str(self.workspace))

        before = len(self.shims.handoffs("code"))
        self.open_file_menu(_SUBFOLDER)
        self.driver.click(_ROW_FOLDER_VSCODE)
        inv = self.shims.wait_for_handoff("code", lambda i: i.target is not None, after=before)
        assert len(inv.argv) == 1 and same_path(inv.target, str(self.workspace / _SUBFOLDER))
        self.clear_entry_filter()

    # ── MT-FB-21 / MT-FB-32 ──────────────────────────────────────────────────
    def test_open_in_file_manager_opens_folders_never_an_app(self):
        """MT-FB-21, MT-FB-32: "Open in File Manager" shows folders, never runs an app.

        Toolbar → the current folder; folder row → that folder. On macOS an
        ``.app`` row is revealed in its parent and its executable never runs.
        """
        self._browse_workspace()
        opened = len(self.shims.handoffs("xdg-open"))
        self.driver.click(self.OPEN_IN_EXPLORER)
        self._assert_file_manager_opened(self.workspace, after=opened)

        opened = len(self.shims.handoffs("xdg-open"))
        self.open_file_menu(_SUBFOLDER)
        self.driver.click(_ROW_FILE_MANAGER)
        self._assert_file_manager_opened(self.workspace / _SUBFOLDER, after=opened)
        self.clear_entry_filter()

        if sys.platform == "darwin":
            self.open_file_menu(_BUNDLE)
            self.driver.click(_ROW_FILE_MANAGER)
            time.sleep(3.0)  # long enough for LaunchServices to have started it
            marker = self.workspace / "bundle-launched.marker"
            exe = str(self.workspace / _BUNDLE / "Contents" / "MacOS" / "HandoffFixture")
            running = [p.pid for p in psutil.process_iter(["cmdline"])
                       if exe in " ".join(p.info.get("cmdline") or [])]
            assert not marker.exists() and not running, (
                f"revealing {_BUNDLE} launched it (marker={marker.exists()}, pids={running})"
            )
            assert not _HANDOFF_FAILED.search(self._app_log_text())
            self.clear_entry_filter()

    # ── MT-SSH-09 ────────────────────────────────────────────────────────────
    def test_setup_ssh_agent_button_runs_the_agent_setup_in_a_tab(self):
        """MT-SSH-09: "Setup SSH Agent" opens a tab that runs the agent setup.

        macOS/Linux: the tab evaluates ``ssh-agent -s`` (its "Agent pid N" line
        proves it ran) and the started agent is stopped by that PID afterwards.
        Windows: the PowerShell tab runs the elevated ``Set-Service ssh-agent``
        command; it raises a UAC prompt, so it only runs on a CI runner or with
        ``TERMIHUB_ALLOW_ELEVATION_PROMPT=1``.
        """
        if sys.platform == "win32" and not (
            os.environ.get("GITHUB_ACTIONS") == "true"
            or os.environ.get("TERMIHUB_ALLOW_ELEVATION_PROMPT") == "1"
        ):
            pytest.skip("raises a UAC prompt: runs on CI or with TERMIHUB_ALLOW_ELEVATION_PROMPT=1")
        self.close_all_tabs()
        self.open_new_connection_editor()
        self.driver.type("connection-editor-name-input", unique_name("agent-setup"))
        self.select_connection_type("ssh")
        self.wait(lambda: self.driver.exists("field-authMethod"), what="the SSH fields")
        self.driver.select("field-authMethod", "agent")
        self.wait(lambda: self.driver.exists("ssh-setup-agent"), what="the Setup SSH Agent button")
        self.driver.click("ssh-setup-agent")
        tab = self.wait(lambda: self.find_tab("Setup SSH Agent"), what="the Setup SSH Agent tab")
        if sys.platform == "win32":
            self._assert_windows_agent_setup(tab["id"])
        else:
            self._assert_posix_agent_setup(tab["id"])
        self.close_all_tabs()

    def _assert_posix_agent_setup(self, tab_id: str) -> None:
        output = self.wait_for_output("Agent pid ", tab_id=tab_id, timeout=30.0)
        match = re.search(r"Agent pid (\d+)", output)
        assert match, f"no 'Agent pid' line in the Setup SSH Agent tab: {output[-400:]!r}"
        try:
            agent = psutil.Process(int(match.group(1)))
            if agent.name().startswith("ssh-agent"):
                agent.terminate()
        except psutil.Error:
            pass

    def _assert_windows_agent_setup(self, tab_id: str) -> None:
        self.wait_for_output("Set-Service ssh-agent", tab_id=tab_id, timeout=30.0)
        time.sleep(3.0)
        for proc in psutil.process_iter(["name", "cmdline"]):
            cmdline = " ".join(proc.info.get("cmdline") or [])
            if (proc.info.get("name") or "").lower().startswith("powershell") and (
                "Set-Service ssh-agent" in cmdline and "pause" in cmdline
            ):
                try:
                    proc.kill()  # the elevated helper waits at `pause` forever
                except psutil.Error:
                    pass


@pytest.mark.usefixtures("ssh_fixtures")
class TestSftpVscodeHandoff(
    TerminalUi, TabsUi, SidebarUi, ConnectionsUi, PasswordPromptUi, SshUi, SftpUi, FilesUi,
    SystemTest,
):
    """SFTP file → ``code --wait`` on a local copy → the edit is uploaded back."""

    external_app_shims = ("code",)
    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT

    def test_open_in_vscode_over_sftp_uploads_the_edit_back(self):
        """MT-FB-15: "Open in VS Code" on an SFTP file edits a local copy and re-uploads.

        The app downloads the file, runs ``code --wait <copy>``, and uploads the
        copy when VS Code exits. The shim appends a marker line before exiting,
        so the remote file must end up with it — and the app must still run
        (regression #828).
        """
        self.close_all_tabs()
        self.connect_ssh_password(unique_name("sftp-vscode"))
        fname = f"{unique_name('remote')}.txt"
        marker = f"edited-by-vscode-{fname[:-4]}"
        self.run_command(f"printf 'original\\n' > ~/{fname}")
        self.connect_sftp_browser()
        self.wait(lambda: bool(self.driver.get_state("vscodeAvailable")), what="vscodeAvailable")
        self.shims.wait_edit = f"{marker}\n"

        self.open_file_menu(fname)
        self.driver.click(_ROW_VSCODE)
        inv = self.shims.wait_for_handoff("code", lambda i: "--wait" in i.argv)
        assert inv.argv[0] == "--wait" and Path(inv.target).name.endswith(fname), (
            f"code was handed {list(inv.argv)}, expected --wait and a local copy of {fname}"
        )

        # The quotes split the sentinel in the typed line, so only the echo matches.
        self.run_command(
            f"for i in $(seq 60); do grep -q {marker} ~/{fname} && break; sleep 0.5; done; "
            f"grep -c {marker} ~/{fname}; echo TH_REUP''LOAD_DONE"
        )
        output = self.wait_for_output("TH_REUPLOAD_DONE", timeout=45.0)
        assert re.search(r"^1\s*$", output.split("TH_REUPLOAD_DONE")[0], re.M), (
            f"the edited copy was not uploaded back to ~/{fname}: {output[-400:]!r}"
        )
        assert self.app.is_running(), "the app exited after the VS Code hand-off (#828)"
        self.close_all_tabs()
