"""SSH agent-auth error feedback (SSH-AGENT-ERROR, ported from
infrastructure/ssh-agent-error.test.js).

Selects the ``agent`` auth method in the connection editor and connects to the
``ssh-password`` fixture with no SSH agent reachable. The app must fail
gracefully: the tab shows the "Connection failed" overlay with the backend's
agent error, the ssh-agent start command as the remedy, and a Retry button, and
the app keeps running.

The SSH ConnectionType schema offers ``agent`` as an ``authMethod``
(``core/src/backends/ssh/mod.rs``), and auth dispatches on it
(``core/src/backends/ssh/auth.rs``). This test was parked for a long time on the
wrong premise that the option did not exist (#4339).

The suite's app is launched without ``SSH_AUTH_SOCK``, so on macOS/Linux no
agent is reachable whatever the runner has running. The ``ssh-password``
container is Linux-only, so the suite skips where no container runtime is
available.
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    SSH_PASSWORD_PORT,
    SSH_USERNAME,
    ConnectionsUi,
    PasswordPromptUi,
    SystemTest,
    TabsUi,
    unique_name,
)

pytestmark = pytest.mark.integration

HOST = "127.0.0.1"
OVERLAY = "terminal-connection-overlay"


@pytest.mark.usefixtures("ssh_password_fixtures")
class TestSshAgentAuthError(TabsUi, ConnectionsUi, PasswordPromptUi, SystemTest):
    """SSH-AGENT-ERROR: agent auth with no agent fails gracefully."""

    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT
    unset_app_env = ("SSH_AUTH_SOCK",)

    def _overlay_text(self) -> str:
        if not self.driver.exists(OVERLAY):
            return ""
        return self.driver.get_text(OVERLAY) or ""

    def test_agent_auth_shows_helpful_error_when_no_agent(self):
        self.close_all_tabs()
        name = unique_name("agent-no-agent")
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_PASSWORD_PORT,
            username=SSH_USERNAME,
            auth_method="agent",
            auto_reconnect=False,
            connect=True,
        )
        # The fresh app does not trust the fixture's host key yet (#1959). The
        # handshake (and its trust prompt) comes before authentication.
        self.accept_host_key_prompt()

        self.wait(
            lambda: "Connection failed" in self._overlay_text(),
            what="the connection-failed overlay for agent auth",
        )
        text = self._overlay_text()
        assert "ssh agent" in text.lower(), f"the overlay should name the agent failure: {text!r}"
        # The agent-auth hint carries the per-OS ssh-agent start command.
        assert "ssh-agent" in text, f"the overlay should offer the ssh-agent remedy: {text!r}"
        assert self.driver.exists("terminal-connection-retry-btn")
        assert self.find_tab(name) is not None, "the tab stays open on the failure screen"
        assert self.app.is_running(), "a missing SSH agent must not take the app down"
