"""Full-app deferred agent update with a REAL binary swap (#4083, the #1352 journey).

``test_agent_update_apply_now_live.py`` drives Apply Now → *deferred* against the
armed ``remote-agent-pending-update`` container, but that agent can never apply:
its staged path does not exist. This suite closes the chain end to end against
``remote-agent-update-swap`` (compose profile ``agent``, port 2218):

    banner → Apply Now while busy (deferred) → close the last tab
           → the agent really swaps its binary and re-execs
           → reconnect → version badge + the persistent session re-attached

## How a release-built agent can apply a test-staged update

The container agent is a release musl build with ``--features test-hooks``. The
image's ``update-swap`` target stages a copy of that agent with a trailer
appended (different bytes and SHA-256, still a launchable agent), signs it the
way release CI does but with the committed TEST-ONLY key
(``agent/keys/test-only/``), and arms the env hook with the staged path and
digest. Only a ``test-hooks`` agent trusts that key; the apply runs the unchanged
production confinement (AGT-003), digest (AGT-004) and signature (AGT-005)
gates. Shipped agents never embed the key (CI:
``scripts/internal/assert-no-test-signing-key.sh``).

## Why two agent connections

A worker counts its own sessions as busy, and a persistent session it holds (or
recovered unattached) keeps it busy, so an agent holding a persistent session
never applies. Exactly as ``agent/tests/self_update_integration.rs::
idle_auto_apply_keeps_the_hosts_persistent_sessions`` does at the agent level,
one connection (the *holder*) owns the persistent session and another (the
*applier*) owns the busy shell whose tab is the last one closed. The applier
connects first, so its startup recovery has no orphan to count. The holder
disconnects before the last tab closes, leaving its session running in its
daemon, free for the reconnect to re-attach.

## Version evidence

Both builds are the same ``CARGO_PKG_VERSION`` (a second, differently versioned
musl build is out of reach for a fixture), so the swap is asserted
**structurally**: the installed binary's SHA-256 becomes the staged one, the
applied ``pending_update`` is gone from ``state.json``, and the reconnected agent
— now running the swapped bytes — answers and renders its version badge.
"""

from __future__ import annotations

import json

import pytest

from termihub_harness import (
    REMOTE_AGENT_PENDING_VERSION,
    REMOTE_AGENT_UPDATE_SWAP_PORT,
    SSH_HOST,
    SSH_PASSWORD,
    SSH_USERNAME,
    AgentUi,
    ContainerControl,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration

#: Where the image installs the agent the desktop launches (POSIX default path).
INSTALLED_AGENT = "/home/testuser/.local/bin/termihub-agent"
#: The signed update the ``update-swap`` image stages (inside the agent's own
#: ``<config>/updates`` staging root, so AGT-003 confinement accepts it).
STAGED_AGENT = "/home/testuser/.config/termihub-agent/updates/termihub-agent-swap-test"
#: The agent's shared state file (holds ``update.pending_update``).
AGENT_STATE = "/home/testuser/.config/termihub-agent/state.json"


def _sha256(container: ContainerControl, path: str) -> str:
    """SHA-256 (hex) of ``path`` inside the container."""
    return container.exec("sha256sum", path).split()[0]


def _pending_update(container: ContainerControl) -> object:
    """``update.pending_update`` from the agent's ``state.json`` (``None`` if absent)."""
    raw = container.exec("cat", AGENT_STATE)
    return (json.loads(raw).get("update") or {}).get("pending_update")


@pytest.mark.usefixtures("remote_agent_update_swap_fixtures")
class TestAgentUpdateRealSwapLive(
    AgentUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    TabsUi,
    TerminalUi,
    SystemTest,
):
    """Apply Now → last tab closed → real swap → reconnect, against the swap container."""

    @pytest.fixture(autouse=True)
    def _cleanup_between_tests(self):
        yield
        self.dismiss_connection_error_if_present()
        for agent in self.remote_agents():
            if agent.get("connectionState") not in (None, "disconnected"):
                self.disconnect_agent(agent["name"])
        self.close_all_tabs()
        self.switch_to_connections_sidebar()

    def _create_and_connect(self, label: str) -> dict:
        """Create a password-auth agent against the swap container and connect it."""
        agent = self.create_remote_agent(
            unique_name(label),
            host=SSH_HOST,
            port=REMOTE_AGENT_UPDATE_SWAP_PORT,
            username=SSH_USERNAME,
        )
        self._connect(agent["name"])
        return agent

    def _connect(self, name: str) -> None:
        self.connect_agent(name)
        self.handle_password_prompt(SSH_PASSWORD)
        self.wait_agent_connected(name)

    def _disconnect(self, name: str) -> None:
        if self.agent_connection_state(name) not in (None, "disconnected"):
            self.disconnect_agent(name)
        self.wait(
            lambda: self.agent_connection_state(name) == "disconnected",
            what=f"agent {name!r} to disconnect",
        )

    def _agent_version(self, name: str) -> str:
        capabilities = self.require_agent(name).get("capabilities") or {}
        version = capabilities.get("agentVersion")
        assert version, f"connected agent {name!r} reported no agentVersion"
        return version

    def test_apply_now_then_last_tab_close_really_swaps_and_reattaches(
        self, remote_agent_update_swap_fixtures: ContainerControl
    ):
        container = remote_agent_update_swap_fixtures
        installed_before = _sha256(container, INSTALLED_AGENT)
        staged = _sha256(container, STAGED_AGENT)
        assert staged != installed_before, "the staged update must differ from the installed agent"

        # The applier connects first (see the module docstring), then the holder
        # starts the persistent session that must survive the swap.
        applier = self._create_and_connect("swap-applier")
        holder = self._create_and_connect("swap-holder")
        version_before = self._agent_version(holder["name"])
        definition = self.create_agent_definition(
            holder["name"], unique_name("swap-persist"), persistent=True
        )
        self.start_persistent_session(definition["id"])
        self.wait_persistent_running(holder["id"], definition["id"])

        # Busy applier: a live shell session holds up an immediate apply.
        before = self.tab_count()
        self.new_shell_session(applier["name"])
        self.wait(lambda: self.tab_count() > before, what="the applier's shell tab")
        self.wait(self.has_terminal, what="the applier's shell session to go live")

        # Banner → Apply Now → deferred (the hook's on-attach announcement is
        # dropped by the desktop handshake, so the banner is surfaced through the
        # real listener — see test_agent_update_apply_now_live.py).
        self.announce_agent_update(applier["id"], available_version=REMOTE_AGENT_PENDING_VERSION)
        self.wait_agent_update_banner(applier["id"])
        self.apply_agent_update_now(applier["id"])
        self.wait(
            lambda: self.agent_update_dismissed(applier["id"]),
            what="the deferred Apply Now to dismiss the banner",
        )
        assert self.has_terminal(), "the deferred request must not tear down the busy session"
        assert _sha256(container, INSTALLED_AGENT) == installed_before, (
            "a deferred update must not swap while a session is busy"
        )

        # The holder lets go of its persistent session (it keeps running in its
        # daemon), then the applier's last tab closes: the applier goes idle and
        # applies the signed update for real.
        self._disconnect(holder["name"])
        self.close_all_tabs()
        self.wait(
            lambda: _sha256(container, INSTALLED_AGENT) == staged,
            what="the agent to swap the staged binary in on the last tab close",
            timeout=60.0,
        )

        # Reconnect onto the swapped binary. The applier's old transport was
        # re-execed underneath the desktop, so it is reconnected fresh too.
        self._disconnect(applier["name"])
        self._connect(holder["name"])

        # The swapped agent answers and renders its version badge; it is the same
        # build version (see the module docstring), now running the staged bytes.
        badge = f"agent-version-badge-{holder['id']}"
        self.wait(lambda: self.driver.exists(badge), what="the agent version badge")
        assert self._agent_version(holder["name"]) == version_before
        assert f"v{version_before}" in self.driver.get_text(badge)
        # The applied update is consumed: nothing pending, no banner, and the
        # armed hook stands down instead of re-staging the installed binary.
        assert _pending_update(container) is None
        assert not self.agent_update_banner_present(holder["id"])

        # The persistent session survived the swap and is re-attached.
        self.wait(
            lambda: any(
                s.get("definitionId") == definition["id"]
                for s in self.agent_sessions(holder["id"])
            ),
            what="the persistent session to be re-listed after the swap",
        )
        self.wait_persistent_running(holder["id"], definition["id"])
        before = self.tab_count()
        self.open_persistent_definition(definition["id"])
        self.wait(lambda: self.tab_count() > before, what="the re-attached persistent tab")
        self.wait(self.has_terminal, what="the re-attached persistent session")
        marker = unique_name("swap-survivor")
        self.run_command(f"echo {marker}")
        assert marker in self.wait_for_output(marker)
