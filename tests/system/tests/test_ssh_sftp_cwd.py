"""SFTP-follows-terminal-CWD system tests (ported from infrastructure/ssh-sftp-cwd.test.js).

After ``cd`` in an SSH terminal, opening the SFTP file browser follows that
working directory (PR #186).
"""

from __future__ import annotations

import time

import pytest

from termihub_harness import SSH_USERNAME, SystemTest, unique_name

pytestmark = pytest.mark.integration


@pytest.mark.usefixtures("ssh_fixtures")
class TestSshSftpCwd(SystemTest):
    @pytest.fixture(autouse=True)
    def _close_tabs_between_tests(self):
        # The file browser tracks the *active* tab's CWD, so leftover SSH tabs
        # from a previous test would skew the path. Mirror the old afterEach.
        yield
        self.close_all_tabs()
        self.switch_to_connections_sidebar()

    def test_follows_cd_to_tmp(self):
        self.connect_ssh_password(unique_name("sftp-cwd-tmp"))
        self.run_command("cd /tmp")
        self._cd_settles()
        path = self.connect_sftp_browser()
        assert self.wait(
            lambda: "/tmp" in self.file_browser_path(), what="the browser at /tmp"
        )

    def test_follows_cd_to_home(self):
        self.connect_ssh_password(unique_name("sftp-cwd-home"))
        self.run_command("cd /tmp")
        self._cd_settles()
        self.run_command("cd ~")
        self._cd_settles()
        self.connect_sftp_browser()
        assert self.wait(
            lambda: SSH_USERNAME in self.file_browser_path(),
            what="the browser at the home dir",
        )

    def test_follows_cd_to_var_log(self):
        self.connect_ssh_password(unique_name("sftp-cwd-var"))
        self.run_command("cd /var/log")
        self._cd_settles()
        self.connect_sftp_browser()
        assert self.wait(
            lambda: "/var/log" in self.file_browser_path(),
            what="the browser at /var/log",
        )

    def test_updates_when_switching_ssh_tabs(self):
        name1 = unique_name("sftp-switch1")
        name2 = unique_name("sftp-switch2")
        self.connect_ssh_password(name1)
        self.run_command("cd /tmp")
        self._cd_settles()

        self.switch_to_connections_sidebar()
        self.connect_ssh_password(name2)
        self.run_command("cd /var")
        self._cd_settles()

        # Active (second) tab's CWD shows in the browser.
        self.connect_sftp_browser()
        assert self.wait(lambda: self.file_browser_path() != "", what="a browser path")

        # Switching back to the first tab updates the browser.
        tab1 = self.find_tab(name1)
        assert tab1 is not None
        self.switch_to_tab(tab1["id"])
        assert self.wait(lambda: self.file_browser_path() != "", what="the updated path")

    def _cd_settles(self) -> None:
        # Give the shell + CWD tracking a beat to report the new directory.
        time.sleep(1.0)
