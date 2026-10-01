"""Network Tools "Run on" an agent — live remote-agent case (#3692, MT-NET-19).

Picks the deployed-agent container (``remote_agent_fixtures``, compose profile
``agent``) in the Open Ports panel's "Run on" selector and asserts the listing
comes from the **agent host**, not this computer:

* run locally first, the list includes a TCP listener this module opens on the
  desktop host's loopback (proving the probe is visible to a local run);
* switched to the agent, the list is the container's socket table — it shows the
  container's ``sshd`` on ``:22`` and **not** the desktop-only probe listener.

The desktop backend records the "Run on" choice asynchronously, so the agent
listing is re-run until it reflects the new vantage (or the wait times out).

Skips cleanly when no container runtime or agent cross-build is available (see
``remote_agent_fixtures``).
"""

from __future__ import annotations

import socket
from typing import Iterator

import pytest

from termihub_harness import (
    AgentUi,
    NetworkToolsUi,
    PasswordPromptUi,
    REMOTE_AGENT_PORT,
    SSH_HOST,
    SSH_PASSWORD,
    SSH_USERNAME,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    unique_name,
)

pytestmark = pytest.mark.integration


@pytest.fixture
def desktop_probe_port() -> Iterator[int]:
    """A TCP listener on the desktop host's loopback — absent from the agent host."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", 0))
    sock.listen(8)
    try:
        yield sock.getsockname()[1]
    finally:
        sock.close()


@pytest.mark.usefixtures("remote_agent_fixtures")
class TestNetworkToolsAgentLive(
    NetworkToolsUi,
    AgentUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    TabsUi,
    SystemTest,
):
    """One app; the test connects its own uniquely-named agent."""

    @pytest.fixture(autouse=True)
    def _cleanup_between_tests(self):
        yield
        self.dismiss_connection_error_if_present()
        for agent in self.remote_agents():
            if agent.get("connectionState") not in (None, "disconnected"):
                self.disconnect_agent(agent["name"])
        self.close_all_tabs()
        self.switch_to_connections_sidebar()

    # ── MT-NET-19: Open Ports run on a remote agent ──────────────────────────────
    def test_open_ports_on_agent_lists_agent_host_ports(self, desktop_probe_port: int):
        name = unique_name("agent-open-ports")
        agent = self.create_remote_agent(
            name, host=SSH_HOST, port=REMOTE_AGENT_PORT, username=SSH_USERNAME
        )
        self.connect_agent(name)
        self.handle_password_prompt(SSH_PASSWORD)
        self.wait_agent_connected(name)

        probe = f"127.0.0.1:{desktop_probe_port}"

        # This computer (the default vantage): the desktop probe is listed.
        self.wait(
            lambda: probe in self.refresh_open_ports(),
            what=f"the desktop probe {probe} in a local open-ports listing",
        )

        # Run on the agent: the container's sshd shows, the desktop probe does not.
        self.set_tool_run_location("open-ports", agent["id"])

        def agent_listing() -> bool:
            text = self.refresh_open_ports()
            return probe not in text and ":22" in text

        self.wait(
            agent_listing,
            what="an agent-host open-ports listing (container sshd, no desktop probe)",
        )

        # Back to This computer: the desktop probe returns, so the switch — not a
        # broken local listing — is what removed it above.
        self.set_tool_run_location("open-ports", None)
        self.wait(
            lambda: probe in self.refresh_open_ports(),
            what=f"the desktop probe {probe} after switching back to This computer",
        )
