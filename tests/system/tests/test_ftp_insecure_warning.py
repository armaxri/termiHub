"""Insecure-FTP pre-connect warning modal — Python-bridge E2E (issue #1493).

Drives the real app over the test bridge to cover the plaintext-FTP warning
modal shipped in #1338 (PR #1492). When a plain-FTP connection (``tlsMode ==
"none"``) whose per-connection ``suppressSecurityWarning`` flag is unset is
connected from the sidebar, the app must raise the ``insecure-ftp-warning``
modal *before* any control connection opens (before a tab is created). FTPS
connections, and plain-FTP connections whose warning has been suppressed via
"Don't warn again", connect without the modal.

No live FTP server is needed: the whole flow under test — modal appears, Cancel
aborts, Connect Anyway proceeds, "Don't warn again" persists — happens on the
frontend before the control connection opens, and ``addTab`` creates the tab
synchronously regardless of whether the subsequent connect succeeds. So a tab
appearing (or not) is a server-independent signal that the connect was (or was
not) initiated. The connect-through happy path against a real FTP endpoint is
therefore out of scope here (see the PR notes).
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    ConnectionsUi,
    SystemTest,
    TabsUi,
    unique_name,
)

pytestmark = pytest.mark.integration

WARNING_MODAL = "insecure-ftp-warning"
CONFIRM = "confirm-dialog-confirm"
CANCEL = "confirm-dialog-cancel"
DONT_WARN = "confirm-dialog-dont-ask-again"


class TestInsecureFtpWarning(ConnectionsUi, TabsUi, SystemTest):
    """FTP-SEC-01: the plaintext-FTP warning modal gates the sidebar connect."""

    def _warning_open(self) -> bool:
        """Whether the insecure-FTP warning modal is currently mounted."""
        return self.driver.exists(WARNING_MODAL)

    def _suppress_flag(self, name: str) -> object:
        """The persisted ``suppressSecurityWarning`` value for ``name`` (or None)."""
        conn = self.find_connection(name)
        if conn is None:
            return None
        return conn.get("config", {}).get("config", {}).get("suppressSecurityWarning")

    def test_plain_ftp_warns_and_cancel_aborts(self):
        """Plain FTP raises the modal before any tab; Cancel closes it and aborts."""
        name = unique_name("ftp-plain")
        self.create_ftp_connection(name, tls_mode="none")
        before = self.tab_count()

        self.connect_connection(name)
        self.wait(self._warning_open, what="the insecure-FTP warning modal")
        # The control connection must not have opened yet — no tab created.
        assert self.find_tab(name) is None
        assert self.tab_count() == before

        self.driver.click(CANCEL)
        self.wait(lambda: not self._warning_open(), what="the modal to close")
        # Cancel aborts: still no tab for this connection.
        assert self.find_tab(name) is None
        assert self.tab_count() == before

    def test_connect_anyway_proceeds(self):
        """Connect Anyway (toggle off) dismisses the modal and opens the tab."""
        name = unique_name("ftp-anyway")
        self.create_ftp_connection(name, tls_mode="none")

        self.connect_connection(name)
        self.wait(self._warning_open, what="the insecure-FTP warning modal")

        self.driver.click(CONFIRM)
        self.wait(lambda: not self._warning_open(), what="the modal to close")
        # The connect proceeds — a tab is created for the connection.
        self.wait(lambda: self.find_tab(name), what="the FTP tab to open")
        # With the toggle off, no per-connection suppression is persisted.
        assert self._suppress_flag(name) is not True

    def test_dont_warn_again_persists_and_skips_modal(self):
        """"Don't warn again" persists suppression so the next connect skips the modal."""
        name = unique_name("ftp-suppress")
        self.create_ftp_connection(name, tls_mode="none")

        # First connect: raise the modal, tick "Don't warn again", Connect Anyway.
        self.connect_connection(name)
        self.wait(self._warning_open, what="the insecure-FTP warning modal")
        self.driver.click(DONT_WARN)
        self.driver.click(CONFIRM)
        self.wait(lambda: not self._warning_open(), what="the modal to close")
        self.wait(lambda: self.find_tab(name), what="the first FTP tab")

        # The suppression flag is persisted onto the connection.
        self.wait(
            lambda: self._suppress_flag(name) is True,
            what="suppressSecurityWarning to persist",
        )

        # Second connect: the modal is skipped and a second tab opens directly.
        before = self.tab_count()
        self.connect_connection(name)
        self.wait(lambda: self.tab_count() > before, what="a second FTP tab to open")
        assert not self._warning_open()


class TestFtpsNoWarning(ConnectionsUi, TabsUi, SystemTest):
    """FTP-SEC-02: an FTPS connection connects without the insecure-FTP modal."""

    def test_ftps_connects_without_warning(self):
        name = unique_name("ftps-explicit")
        self.create_ftp_connection(name, tls_mode="explicit")

        self.connect_connection(name)
        # FTPS never raises the warning — the connect proceeds straight to a tab.
        self.wait(lambda: self.find_tab(name), what="the FTPS tab to open")
        assert not self.driver.exists(WARNING_MODAL)
