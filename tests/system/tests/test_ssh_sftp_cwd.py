"""SFTP-follows-terminal-CWD system tests (ported from infrastructure/ssh-sftp-cwd.test.js).

After ``cd`` in an SSH terminal, opening the SFTP file browser follows that
working directory (PR #186).

On macOS the suite runs against the native sshd fixture (#5421). There ``/tmp``
and ``/var`` are symlinks into ``/private``, so the browser may show the path the
shell was given or the one SFTP ``realpath`` resolves it to (``/private/tmp``).
The checks are substring matches, which accept both.

On Windows the suite runs against the native sshd with Git Bash as the login
shell (#5449, #6147). Win32-OpenSSH is followed only through the shell hook, so
the connection turns Command Marks on there. The suite changes into drive
folders (``/c/Users``), which the browser opens as the server's ``/C:/Users``,
and into the MSYS mount ``/tmp``: the hook reports the folder Git Bash maps it
to (``pwd -W``, #6170), ``C:/Users/<user>/AppData/Local/Temp``.
"""

from __future__ import annotations

import sys
import time

import pytest

from termihub_harness import (
    ConnectionsUi,
    FilesUi,
    PasswordPromptUi,
    SSH_USERNAME,
    SftpUi,
    SidebarUi,
    SshUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration

WINDOWS = sys.platform == "win32"

#: Two folders to change into. Windows: Git Bash drive paths, which the browser
#: opens as the server's ``/C:/…`` (its header may keep the path it was given).
FIRST_DIR, SECOND_DIR = ("/c/Users", "/c/Windows") if WINDOWS else ("/tmp", "/var/log")

#: An entry each Windows folder lists: the browser really opened it, rather than
#: keeping the path it was given over a failed listing.
LISTS = {"/c/Users": "Public", "/c/Windows": "System32"}


def _shows(path: str, folder: str) -> bool:
    """Whether the browser's ``path`` is at ``folder`` (or a resolved form of it).

    A substring check: macOS may resolve ``/tmp`` to ``/private/tmp``, and on
    Windows ``/c/Users`` and ``/C:/Users`` are the same folder.
    """
    if WINDOWS:
        return folder.lower() in path.replace(":", "").lower()
    return folder in path


@pytest.mark.usefixtures("ssh_fixtures")
@pytest.mark.native_sshd
class TestSshSftpCwd(
    TerminalUi, TabsUi, SidebarUi, ConnectionsUi, PasswordPromptUi, SshUi, SftpUi, FilesUi,
    SystemTest,
):
    @pytest.fixture(autouse=True)
    def _close_tabs_between_tests(self):
        # The file browser tracks the *active* tab's CWD, so leftover SSH tabs
        # from a previous test would skew the path. Mirror the old afterEach.
        yield
        self.close_all_tabs()
        self.switch_to_connections_sidebar()

    def _connect(self, name: str) -> None:
        # A Windows host is followed only through the shell hook (#5028).
        self.connect_ssh_password(name, command_marks=True if WINDOWS else None)

    def test_follows_cd_to_tmp(self):
        self._connect(unique_name("sftp-cwd-tmp"))
        self.run_command(f"cd {FIRST_DIR}")
        self._cd_settles()
        self.connect_sftp_browser()
        # A substring: "/private/tmp" on macOS (see the module docstring).
        assert self.wait(
            lambda: _shows(self.file_browser_path(), FIRST_DIR), what=f"the browser at {FIRST_DIR}"
        )
        self._lists(FIRST_DIR)

    @pytest.mark.skipif(not WINDOWS, reason="an MSYS mount only exists on a Git Bash host")
    def test_follows_cd_to_an_msys_mount(self):
        # #6170: /tmp is a Git Bash mount, not a Windows folder; the hook
        # reports where it points, and the browser opens that folder.
        probe = unique_name("th-6170-probe")
        self._connect(unique_name("sftp-cwd-mount"))
        self.run_command(f"cd /tmp && touch {probe}")
        self._cd_settles()
        self.connect_sftp_browser()
        assert self.wait(
            lambda: "appdata/local/temp" in self.file_browser_path().replace("\\", "/").lower(),
            what="the browser at the folder /tmp maps to",
        )
        self.wait_for_file_row(probe)
        self.run_command(f"rm -f {probe}")

    def test_follows_cd_to_home(self):
        self._connect(unique_name("sftp-cwd-home"))
        self.run_command(f"cd {FIRST_DIR}")
        self._cd_settles()
        self.run_command("cd ~")
        self._cd_settles()
        self.connect_sftp_browser()
        assert self.wait(
            lambda: SSH_USERNAME in self.file_browser_path(),
            what="the browser at the home dir",
        )

    def test_follows_cd_to_var_log(self):
        self._connect(unique_name("sftp-cwd-var"))
        self.run_command(f"cd {SECOND_DIR}")
        self._cd_settles()
        self.connect_sftp_browser()
        assert self.wait(
            lambda: _shows(self.file_browser_path(), SECOND_DIR),
            what=f"the browser at {SECOND_DIR}",
        )
        self._lists(SECOND_DIR)

    def test_updates_when_switching_ssh_tabs(self):
        name1 = unique_name("sftp-switch1")
        name2 = unique_name("sftp-switch2")
        self._connect(name1)
        self.run_command(f"cd {FIRST_DIR}")
        self._cd_settles()

        self.switch_to_connections_sidebar()
        self._connect(name2)
        self.run_command(f"cd {SECOND_DIR}")
        self._cd_settles()

        # Active (second) tab's CWD shows in the browser.
        self.connect_sftp_browser()
        assert self.wait(lambda: self.file_browser_path() != "", what="a browser path")

        # Switching back to the first tab updates the browser.
        tab1 = self.find_tab(name1)
        assert tab1 is not None
        self.switch_to_tab(tab1["id"])
        assert self.wait(lambda: self.file_browser_path() != "", what="the updated path")

    def _lists(self, folder: str) -> None:
        if folder in LISTS:
            self.wait_for_file_row(LISTS[folder])

    def _cd_settles(self) -> None:
        # Give the shell + CWD tracking a beat to report the new directory.
        time.sleep(1.0)
