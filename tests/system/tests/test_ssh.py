"""SSH infrastructure system tests (ported from tests/e2e/infrastructure/ssh.test.js).

Drives the real app over the test bridge against the Docker SSH containers
(``ssh-password`` on 2201, ``ssh-keys`` on 2203). The ``ssh_fixtures`` session
fixture brings those containers up and skips cleanly when Docker is unavailable.

Each ``SystemTest`` subclass gets its own fresh app instance; methods within a
class share it and run in order. Connection names are uniquified so tabs from
earlier methods never alias later ones.
"""

from __future__ import annotations

import time

import pytest

from termihub_harness import (
    SSH_KEY_PATH,
    SSH_KEYS_PORT,
    SSH_PASSWORD_PORT,
    SSH_USERNAME,
    SystemTest,
    unique_name,
)

pytestmark = pytest.mark.integration

HOST = "127.0.0.1"


@pytest.mark.usefixtures("ssh_fixtures")
class TestSshPasswordAuth(SystemTest):
    """SSH-01: password authentication opens a working terminal tab."""

    def test_connects_with_password_and_opens_a_tab(self):
        name = unique_name("ssh-pass")
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_PASSWORD_PORT,
            username=SSH_USERNAME,
            auth_method="password",
            connect=True,
        )
        self.handle_password_prompt()

        tab = self.wait(lambda: self.find_tab(name), what="the SSH tab to open")
        assert tab is not None
        active = self.active_tab()
        assert active is not None and name in (active.get("title") or "")

    def test_terminal_becomes_live_after_connect(self):
        name = unique_name("ssh-live")
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_PASSWORD_PORT,
            username=SSH_USERNAME,
            connect=True,
        )
        self.handle_password_prompt()
        self.wait(lambda: self.find_tab(name), what="the SSH tab")
        # Replaces the old `.xterm` DOM check: a readable terminal session is the
        # bridge-world signal that the terminal rendered and is live.
        self.wait(self.has_terminal, what="the SSH terminal session")


@pytest.mark.usefixtures("ssh_fixtures")
class TestSshPasswordPromptFlow(SystemTest):
    """SSH-PASSWORD: the password-prompt modal gates the connection."""

    def test_prompt_appears_on_connect(self):
        name = unique_name("ssh-prompt")
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_PASSWORD_PORT,
            username=SSH_USERNAME,
            auth_method="password",
            connect=True,
        )
        self.wait(
            lambda: self.driver.exists("password-prompt-input"),
            what="the password prompt",
        )
        assert self.password_prompt_open()
        self.cancel_password_prompt()

    def test_cancel_does_not_open_a_tab(self):
        before = self.tab_count()
        name = unique_name("ssh-cancel")
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_PASSWORD_PORT,
            username=SSH_USERNAME,
            connect=True,
        )
        self.wait(
            lambda: self.driver.exists("password-prompt-input"),
            what="the password prompt",
        )
        self.cancel_password_prompt()
        self.wait(lambda: not self.password_prompt_open(), what="the prompt to close")
        assert self.tab_count() == before

    def test_connects_after_entering_password(self):
        name = unique_name("ssh-enter")
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_PASSWORD_PORT,
            username=SSH_USERNAME,
            connect=True,
        )
        self.handle_password_prompt()
        assert self.wait(lambda: self.find_tab(name), what="the SSH tab")


@pytest.mark.usefixtures("ssh_fixtures")
class TestSshKeyAuth(SystemTest):
    """SSH-02: key-based authentication connects without a password prompt."""

    def test_connects_with_key_and_opens_a_tab(self):
        if not SSH_KEY_PATH.exists():
            pytest.skip(f"SSH key fixture missing: {SSH_KEY_PATH}")
        name = unique_name("ssh-key")
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_KEYS_PORT,
            username=SSH_USERNAME,
            auth_method="key",
            key_path=str(SSH_KEY_PATH),
            connect=True,
        )
        # Key auth must not raise a password prompt.
        tab = self.wait(lambda: self.find_tab(name), what="the SSH key-auth tab")
        assert tab is not None
        assert not self.password_prompt_open()
        self.wait(self.has_terminal, what="the SSH terminal session")


class TestSshConnectionFailure(SystemTest):
    """SSH-03: an unreachable host fails gracefully (no Docker needed)."""

    def test_unreachable_host_is_handled_gracefully(self):
        name = unique_name("ssh-fail")
        self.create_ssh_connection(
            name,
            host=HOST,
            port=19999,  # nothing listening here
            username=SSH_USERNAME,
            connect=True,
        )
        # Save & Connect raises the password prompt before connecting; provide the
        # password, then the TCP connection to a closed localhost port fails fast
        # (connection refused). The original WebdriverIO test's only real pass
        # condition was "the app does not hang or crash" — assert exactly that.
        self.handle_password_prompt()
        for _ in range(8):
            assert isinstance(self.driver.get_state(), dict)
            time.sleep(0.25)
        # The prompt must not be left stuck open after the failed attempt.
        assert not self.password_prompt_open()


@pytest.mark.usefixtures("ssh_fixtures")
class TestSshSessionOutput(SystemTest):
    """SSH-05: the SSH terminal is interactive and streams command output."""

    def test_terminal_echoes_command_output(self):
        name = unique_name("ssh-output")
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_PASSWORD_PORT,
            username=SSH_USERNAME,
            connect=True,
        )
        self.handle_password_prompt()
        self.wait(self.has_terminal, what="the SSH terminal session")

        marker = "SYS_SSH_OUTPUT_OK"
        self.run_command(f"echo {marker}")
        assert marker in self.wait_for_output(marker)


@pytest.mark.usefixtures("ssh_fixtures")
class TestSshMonitoring(SystemTest):
    """SSH-08: monitoring shows on an SSH tab and hides on a local tab."""

    def test_monitoring_tracks_the_active_tab(self):
        ssh_name = unique_name("ssh-mon")
        self.create_ssh_connection(
            ssh_name,
            host=HOST,
            port=SSH_PASSWORD_PORT,
            username=SSH_USERNAME,
            connect=True,
        )
        self.handle_password_prompt()
        ssh_tab = self.wait(lambda: self.find_tab(ssh_name), what="the SSH tab")

        # Monitoring is shown while the SSH tab is active.
        assert self.wait(
            self.monitoring_visible, what="monitoring to appear on the SSH tab"
        )

        # Open a local shell tab — it becomes active and monitoring hides.
        self.driver.click("terminal-view-new-terminal")
        self.wait(self.has_terminal, what="the local terminal")
        assert self.wait(
            lambda: not self.monitoring_visible(),
            what="monitoring to hide on the local tab",
        )

        # Switch back to the SSH tab — monitoring reappears.
        self.switch_to_tab(ssh_tab["id"])
        assert self.wait(
            self.monitoring_visible, what="monitoring to reappear on the SSH tab"
        )


# SSH-06 (server disconnect mid-session) and SSH-07 (X11 forwarding) were left
# unimplemented in the WebdriverIO suite for the same reasons here: stopping a
# shared container mid-test would break sibling tests, and X11 needs an X server
# on the host. Tracked as follow-ups.
@pytest.mark.skip(reason="needs to stop a shared container mid-test (SSH-06)")
def test_handles_server_disconnect():
    ...


@pytest.mark.skip(reason="needs an X server on the host (SSH-07)")
def test_forwards_x11_applications():
    ...
