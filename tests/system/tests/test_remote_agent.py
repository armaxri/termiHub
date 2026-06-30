"""Remote-agent infrastructure — ported from ``infrastructure/remote-agent.test.js`` (#974).

Covers the remote-agent flows that are exercisable without a fully deployed
agent: creating a remote-agent definition, the connection-error feedback dialog
a failed connect raises (unreachable host, wrong password, host with no agent
binary), and the agent-setup wizard (context menu + arch-detection reaching the
setup form). Drives the real UI through the bridge against the existing
password-SSH container (port 2201) and an unreachable local port.

The original WebdriverIO suite asserted with ``if (await x.isExisting())`` guards,
so its checks passed vacuously when the dialog/menu never appeared; this port
**waits** for each dialog/menu, so the assertions are real.

Divergences from the original, by design:

* **Remote agents are created via the New Remote Agent (+) button**, not a
  "remote" connection-editor type — that type was removed, and the dedicated
  button (in the experimental Remote Agents sidebar group) is the only create
  path now.
* **The "Agent Not Installed" Setup-Agent button** (old MT-AGENT-02) is not
  asserted: connecting to the password container (no agent binary) classifies as
  a generic "Connection Failed", not the ``agent-missing`` category that renders
  that button (the categorization itself is covered by the
  ``classifyAgentError`` / ``ConnectionErrorDialog`` unit tests). This port
  asserts the real outcome — an error dialog appears and dismisses.
* **MT-AGENT-03/05/06/08** in the old suite only asserted that a selector string
  contained a substring (tautologies); the setup-dialog fields they referenced
  are covered here by :meth:`test_setup_wizard_opens_and_detects`.
* **A successful agent connect + child sessions** (old pending describes) needs a
  remote host with the agent binary deployed and is out of scope here — tracked in
  #995 (a deployed-agent Docker fixture).
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    AgentUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    SSH_HOST,
    SSH_PASSWORD,
    SSH_PASSWORD_PORT,
    SSH_USERNAME,
    SystemTest,
    TabsUi,
    unique_name,
)

pytestmark = pytest.mark.integration

# A localhost port nothing listens on — a connect attempt is refused promptly,
# so the error dialog appears without waiting out a network timeout.
UNREACHABLE_PORT = 19996


@pytest.mark.usefixtures("ssh_fixtures")
class TestRemoteAgent(
    AgentUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    TabsUi,
    SystemTest,
):
    """One app for the whole suite; each test creates its own uniquely-named agent."""

    @pytest.fixture(autouse=True)
    def _cleanup_between_tests(self):
        yield
        # Dismiss any leftover error dialog, then clear the tab slate.
        self.dismiss_connection_error_if_present()
        self.close_all_tabs()
        self.switch_to_connections_sidebar()

    # ── creation ────────────────────────────────────────────────────────────────
    def test_create_remote_agent(self):
        name = unique_name("agent-create")
        agent = self.create_remote_agent(
            name, host=SSH_HOST, port=SSH_PASSWORD_PORT, username=SSH_USERNAME
        )
        assert agent["name"] == name
        # The agent row renders for the saved id.
        self.wait(
            lambda: self.driver.exists(f"agent-node-{agent['id']}"),
            what="the agent sidebar node",
        )

    # ── connection-error feedback dialog ────────────────────────────────────────
    def test_unreachable_host_shows_error_dialog(self):
        name = unique_name("agent-unreachable")
        self.create_remote_agent(
            name, host=SSH_HOST, port=UNREACHABLE_PORT, username=SSH_USERNAME
        )
        self.connect_agent(name)
        # Password is requested before the connect attempt; answer it, then the
        # refused connection raises the error dialog.
        self.handle_password_prompt()
        title = self.wait(
            lambda: self.driver.get_text(self.ERROR_TITLE), what="the connection-error title"
        )
        assert title.strip()
        self.dismiss_connection_error()

    def test_wrong_password_shows_error_dialog(self):
        name = unique_name("agent-auth")
        self.create_remote_agent(
            name, host=SSH_HOST, port=SSH_PASSWORD_PORT, username=SSH_USERNAME
        )
        self.connect_agent(name)
        self.handle_password_prompt("definitely-the-wrong-password")
        title = self.wait(
            lambda: self.driver.get_text(self.ERROR_TITLE), what="the connection-error title"
        )
        assert title.strip()
        self.dismiss_connection_error()

    def test_missing_agent_errors_and_close_keeps_agent(self):
        # The password container accepts SSH but has no agent binary, so the
        # connect fails after auth; the dialog appears, Close dismisses it, and the
        # agent stays in the list (disconnected).
        name = unique_name("agent-missing")
        self.create_remote_agent(
            name, host=SSH_HOST, port=SSH_PASSWORD_PORT, username=SSH_USERNAME
        )
        self.connect_agent(name)
        self.handle_password_prompt(SSH_PASSWORD)

        title = self.wait(
            lambda: self.driver.get_text(self.ERROR_TITLE), what="the connection-error title"
        )
        assert title.strip()
        self.dismiss_connection_error()
        assert self.find_agent(name) is not None

    # ── setup wizard ────────────────────────────────────────────────────────────
    def test_setup_wizard_opens_and_detects(self):
        # The setup wizard appears in the agent context menu; opening it connects
        # over SSH to detect the remote architecture, then shows the setup form
        # (target arch, install path, Start Setup). Detection runs against the
        # real password container, so it reaches the "ready" form.
        name = unique_name("agent-setup")
        self.create_remote_agent(
            name, host=SSH_HOST, port=SSH_PASSWORD_PORT, username=SSH_USERNAME
        )
        self.open_agent_setup(name)
        # Detection raises the password prompt first.
        self.handle_password_prompt(SSH_PASSWORD)

        self.wait(self.setup_ready, what="the agent-setup form after arch detection", timeout=40.0)
        assert self.driver.exists(self.SETUP_REMOTE_PATH)
        assert self.driver.exists(self.SETUP_ARCH)
        self.cancel_agent_setup()
