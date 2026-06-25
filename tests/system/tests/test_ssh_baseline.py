"""SSH baseline system tests (ported from infrastructure/ssh-baseline.test.js).

Covers key auth, graceful disconnect, command output, immediate input, and a
connection-failure case against the Docker SSH containers.
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    ConnectionsUi,
    PasswordPromptUi,
    SSH_KEYS_PORT,
    SSH_KEY_PATH,
    SSH_PASSWORD_PORT,
    SSH_USERNAME,
    SshUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration

HOST = "127.0.0.1"


@pytest.mark.usefixtures("ssh_fixtures")
class TestSshBaseline(TerminalUi, TabsUi, ConnectionsUi, PasswordPromptUi, SshUi, SystemTest):
    def test_key_auth_connects_without_password_prompt(self):
        name = unique_name("ssh-key-baseline")
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_KEYS_PORT,
            username=SSH_USERNAME,
            auth_method="key",
            key_path=str(SSH_KEY_PATH),
            connect=True,
        )
        tab = self.wait(lambda: self.find_tab(name), what="the SSH key tab")
        assert tab is not None
        assert not self.password_prompt_open()
        self.wait(self.has_terminal, what="the SSH terminal session")

    def test_handles_session_exit_gracefully(self):
        name = unique_name("ssh-disconnect")
        self.connect_ssh_password(name)
        # `exit` ends the remote shell; the tab must remain (disconnected state).
        self.run_command("exit")
        self.wait(lambda: self.find_tab(name), what="the tab to persist after exit")
        assert self.find_tab(name) is not None

    def test_command_output_renders(self):
        name = unique_name("ssh-cmd-output")
        self.connect_ssh_password(name)
        self.run_command("echo TERMIHUB_TEST_MARKER")
        assert "TERMIHUB_TEST_MARKER" in self.wait_for_output("TERMIHUB_TEST_MARKER")

    def test_input_works_immediately_after_connect(self):
        name = unique_name("ssh-input")
        self.connect_ssh_password(name)
        # No explicit focus/click first — run_command drives the session directly.
        self.run_command("echo INPUT_WORKS")
        assert "INPUT_WORKS" in self.wait_for_output("INPUT_WORKS")

    def test_unreachable_port_is_handled_gracefully(self):
        name = unique_name("ssh-fail-baseline")
        self.create_ssh_connection(
            name, host=HOST, port=19997, username=SSH_USERNAME, connect=True
        )
        self.handle_password_prompt()
        assert isinstance(self.driver.get_state(), dict)
        assert not self.password_prompt_open()

    def test_sidebar_double_click_connects_password(self):
        # Exercises the bridge's doubleClick verb on the real sidebar-connect path
        # (ConnectionList.onDoubleClick → handleConnect), distinct from the editor's
        # Save & Connect: save a password connection, double-click it in the sidebar
        # to connect, answer the prompt it raises, and land in a terminal.
        name = unique_name("ssh-dblclick")
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_PASSWORD_PORT,
            username=SSH_USERNAME,
            connect=False,
        )
        self.require_connection(name)
        self.connect_connection(name)
        self.handle_password_prompt()
        tab = self.wait(lambda: self.find_tab(name), what="the double-click SSH tab")
        assert tab is not None
        self.wait(self.has_terminal, what="the SSH terminal session")

    def test_terminal_survives_window_resize(self):
        # SSH-BASELINE-RESIZE: resizing the window re-fits xterm and re-sizes the
        # PTY; the session must survive and stay interactive. Connect, resize the
        # window to two sizes (driving the fit → PTY-resize path), then confirm the
        # terminal still echoes a freshly typed command.
        name = unique_name("ssh-resize")
        self.connect_ssh_password(name)
        self.run_command("echo BEFORE_RESIZE")
        assert "BEFORE_RESIZE" in self.wait_for_output("BEFORE_RESIZE")

        self.driver.resize_window(800, 600)
        self.driver.resize_window(1024, 768)

        self.run_command("echo AFTER_RESIZE")
        assert "AFTER_RESIZE" in self.wait_for_output("AFTER_RESIZE")
