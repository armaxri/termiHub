"""Live remote-agent success path — the deployed-agent E2E (#995).

Follow-up from #974: :mod:`test_remote_agent` covers the flows reachable without
a deployed agent (create / error dialog / setup wizard against the no-agent
password container). This module covers the **success path**, which needs a
remote host with the ``termihub-agent`` binary actually installed — the
``remote-agent`` container (compose profile ``agent``, port 2211), whose image
bakes in a freshly-built agent binary (see ``remote_agent_fixtures`` /
``stage_remote_agent_binary``).

These are the ``pending`` describes the old ``infrastructure/remote-agent.test.js``
never implemented:

* **connect a live agent and see its available shells** (folder expands to real
  capabilities),
* **create a shell session under a connected agent** (a working terminal tab),
* **reconnect and re-attach persistent sessions** (a persistent session survives
  the SSH connection dropping and reappears on reconnect),
* the **connect / disconnect / new-session / edit / delete context menu** against
  a *connected* agent.

The suite skips cleanly when no container runtime is available or the agent
cross-build toolchain is missing (see ``remote_agent_fixtures``).
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    AgentUi,
    PasswordPromptUi,
    REMOTE_AGENT_PORT,
    SSH_HOST,
    SSH_PASSWORD,
    SSH_USERNAME,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration


@pytest.mark.usefixtures("remote_agent_fixtures")
class TestRemoteAgentLive(
    AgentUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    TabsUi,
    TerminalUi,
    SystemTest,
):
    """One app for the whole suite; each test creates its own uniquely-named agent."""

    @pytest.fixture(autouse=True)
    def _cleanup_between_tests(self):
        yield
        # Disconnect any agent still connected (frees the SSH + agent handshake),
        # dismiss a leftover error dialog, and clear the tab slate.
        self.dismiss_connection_error_if_present()
        for agent in self.remote_agents():
            if agent.get("connectionState") not in (None, "disconnected"):
                self.disconnect_agent(agent["name"])
        self.close_all_tabs()
        self.switch_to_connections_sidebar()

    def _create_and_connect(self, label: str) -> dict:
        """Create a password-auth agent against the deployed-agent container and connect."""
        name = unique_name(label)
        agent = self.create_remote_agent(
            name, host=SSH_HOST, port=REMOTE_AGENT_PORT, username=SSH_USERNAME
        )
        self.connect_agent(name)
        self.handle_password_prompt(SSH_PASSWORD)
        self.wait_agent_connected(name)
        return agent

    # ── connect + capabilities ───────────────────────────────────────────────────
    def test_connect_shows_available_shells(self):
        agent = self._create_and_connect("agent-live-connect")
        # A connected agent reports its shells, which the sidebar folder renders as
        # the "New Shell Session" targets.
        shells = self.agent_available_shells(agent["name"])
        assert shells, "connected agent reported no available shells"

    # ── child shell session ──────────────────────────────────────────────────────
    def test_create_shell_session_opens_terminal(self):
        agent = self._create_and_connect("agent-live-shell")
        before = self.tab_count()
        self.new_shell_session(agent["name"])
        # A remote-session tab opens and its terminal goes live over the agent.
        self.wait(lambda: self.tab_count() > before, what="the new shell-session tab")
        self.wait(self.has_terminal, what="the agent shell terminal session")
        marker = unique_name("agent-echo")
        self.run_command(f"echo {marker}")
        assert marker in self.wait_for_output(marker)

    # ── persistent session survives reconnect ────────────────────────────────────
    def test_reconnect_reattaches_persistent_session(self):
        agent = self._create_and_connect("agent-live-persist")
        definition = self.create_agent_definition(
            agent["name"], unique_name("persist-shell"), persistent=True
        )
        self.start_persistent_session(definition["id"])
        self.wait_persistent_running(agent["id"], definition["id"])

        # Drop the agent connection (the persistent session keeps running in the
        # remote agent daemon), then reconnect.
        self.disconnect_agent(agent["name"])
        self.wait(
            lambda: self.agent_connection_state(agent["name"]) == "disconnected",
            what=f"agent {agent['name']!r} to disconnect",
        )
        self.connect_agent(agent["name"])
        self.handle_password_prompt(SSH_PASSWORD)
        self.wait_agent_connected(agent["name"])

        # The survivor session is re-listed for the agent, linked to its definition
        # so it can be re-attached.
        session = self.wait(
            lambda: next(
                (
                    s
                    for s in self.agent_sessions(agent["id"])
                    if s.get("definitionId") == definition["id"]
                ),
                None,
            ),
            what="the persistent session to be re-listed after reconnect",
        )
        assert session["definitionId"] == definition["id"]

    # ── connected-agent context menu ─────────────────────────────────────────────
    def test_connected_agent_context_menu(self):
        agent = self._create_and_connect("agent-live-menu")
        name = agent["name"]

        # Connected: the menu offers disconnect / refresh / new-session / edit /
        # delete, and hides the disconnected-only connect / setup entries.
        self.open_agent_menu(name, sentinel=self.CTX_DISCONNECT)
        for item in (
            self.CTX_DISCONNECT,
            self.CTX_REFRESH,
            self.CTX_NEW_SHELL,
            self.CTX_NEW_CONNECTION,
            self.CTX_EDIT,
            self.CTX_DELETE,
        ):
            assert self.driver.exists(item), f"connected agent menu missing {item}"
        assert not self.driver.exists(self.CTX_CONNECT)
        assert not self.driver.exists(self.CTX_SETUP)

        # Disconnect via the menu, then the disconnected menu offers connect / setup
        # again while edit / delete persist across both states.
        self.disconnect_agent(name)
        self.wait(
            lambda: self.agent_connection_state(name) == "disconnected",
            what=f"agent {name!r} to disconnect",
        )
        self.open_agent_menu(name, sentinel=self.CTX_CONNECT)
        for item in (self.CTX_CONNECT, self.CTX_SETUP, self.CTX_EDIT, self.CTX_DELETE):
            assert self.driver.exists(item), f"disconnected agent menu missing {item}"
        assert not self.driver.exists(self.CTX_DISCONNECT)
