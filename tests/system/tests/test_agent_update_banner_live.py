"""Live deferred-update banner E2E (#1520, follow-up to #1352 / PR #1518).

The per-agent deferred-update banner (``AgentUpdateBanner``) renders only under a
**connected** agent (``AgentNode.tsx``: ``isConnected && <AgentUpdateBanner …>``),
so this suite drives the real ``remote-agent`` container (compose profile
``agent``, port 2211) exactly like :mod:`test_remote_agent_live` — and skips
cleanly when no container runtime or agent cross-build toolchain is available.

## Why the event has to be injected

The banner's state has exactly one producer: the ``agent-update-available``
Tauri event the desktop forwards from an agent's ``agent.update_available``
notification. A live agent raises that only from its 24h self-update timer behind
``--allow-self-update``, and it is not replayed on attach — so no click, key, or
menu can surface the banner. The ``emitEvent`` bridge verb (#1545) injects the
event through the **real** Tauri bus, so the app's own ``listen`` subscription and
the ``useAgentUpdateEvents`` folding hook still run; only the stimulus is faked,
not the path under test.

## Coverage boundary (deliberate)

Reachable here, and covered:

* a staged announcement surfaces the banner under a connected agent,
* the banner's copy carries the agent name and the offered version,
* an **unstaged** announcement folds into the store but shows no banner,
* the event alone does not surface a banner on a *disconnected* agent,
* Dismiss hides the banner, and it stays hidden for that agent.

**Apply Now is not driven here**, because neither of its outcomes is assertable
yet — both are left to the Vitest suite (``AgentUpdateBanner.test.tsx``):

* the **deferred / busy toast** (``applied: false``, N active sessions) needs the
  agent to hold a ``pending_update`` under test — blocked on #1546,
* the **applied-immediately toast** is architecturally unreachable in a live Unix
  agent: an idle apply swaps the binary and re-execs before the RPC responds.

The only branch a live agent would take today is the ``No pending update to
apply`` error, which is neither outcome the issue asks for; and toasts carry no
``data-testid``, so it could only be asserted indirectly via the async Button's
internal pending class — a brittle race not worth the coverage. Apply Now joins
this suite with #1546.
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
    unique_name,
)

pytestmark = pytest.mark.integration


@pytest.mark.usefixtures("remote_agent_fixtures")
class TestAgentUpdateBannerLive(
    AgentUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    TabsUi,
    SystemTest,
):
    """One app for the whole suite; each test creates its own uniquely-named agent."""

    NEW_VERSION = "9.9.9"

    @pytest.fixture(autouse=True)
    def _cleanup_between_tests(self):
        yield
        self.dismiss_connection_error_if_present()
        for agent in self.remote_agents():
            if agent.get("connectionState") not in (None, "disconnected"):
                self.disconnect_agent(agent["name"])
        self.close_all_tabs()
        self.switch_to_connections_sidebar()

    def _create_agent(self, label: str) -> dict:
        """Create a password-auth agent definition against the deployed-agent container."""
        name = unique_name(label)
        return self.create_remote_agent(
            name, host=SSH_HOST, port=REMOTE_AGENT_PORT, username=SSH_USERNAME
        )

    def _create_and_connect(self, label: str) -> dict:
        agent = self._create_agent(label)
        self.connect_agent(agent["name"])
        self.handle_password_prompt(SSH_PASSWORD)
        self.wait_agent_connected(agent["name"])
        return agent

    # ── surfacing ────────────────────────────────────────────────────────────────
    def test_staged_update_surfaces_banner_with_version(self):
        agent = self._create_and_connect("agent-banner-show")

        # No banner until the agent announces an update.
        assert not self.agent_update_banner_present(agent["id"])

        self.announce_agent_update(agent["id"], available_version=self.NEW_VERSION)

        text = self.wait_agent_update_banner(agent["id"])
        # The copy names the agent and the version on offer, and explains that the
        # staged binary lands on the last disconnect regardless of Apply Now.
        assert agent["name"] in text
        assert self.NEW_VERSION in text
        assert "last session disconnects" in text

        # The event folded through the real listener into the store.
        update = self.agent_update_state(agent["id"])
        assert update is not None
        assert update["availableVersion"] == self.NEW_VERSION
        assert update["staged"] is True

    def test_unstaged_update_folds_into_store_but_shows_no_banner(self):
        agent = self._create_and_connect("agent-banner-unstaged")

        # An update that is merely *available* is not yet staged on the agent, so
        # there is nothing for Apply Now to apply — the banner stays away.
        self.announce_agent_update(
            agent["id"], available_version=self.NEW_VERSION, staged=False
        )

        update = self.wait(
            lambda: self.agent_update_state(agent["id"]),
            what="the unstaged update to fold into the store",
        )
        assert update["staged"] is False
        self.wait_no_agent_update_banner(agent["id"])

    def test_disconnected_agent_shows_no_banner(self):
        # The banner hangs off a connected agent's row; a stale announcement for an
        # agent that is not connected must not resurrect it.
        agent = self._create_agent("agent-banner-offline")

        self.announce_agent_update(agent["id"], available_version=self.NEW_VERSION)

        self.wait(
            lambda: self.agent_update_state(agent["id"]),
            what="the update to fold into the store",
        )
        self.wait_no_agent_update_banner(agent["id"])

    # ── dismiss ──────────────────────────────────────────────────────────────────
    def test_dismiss_hides_banner_and_it_stays_hidden(self):
        agent = self._create_and_connect("agent-banner-dismiss")
        self.announce_agent_update(agent["id"], available_version=self.NEW_VERSION)
        self.wait_agent_update_banner(agent["id"])

        self.dismiss_agent_update_banner(agent["id"])

        # Dismissal is per-agent and sticky: re-announcing the same staged update
        # must not nag the user again.
        self.announce_agent_update(agent["id"], available_version=self.NEW_VERSION)
        self.wait_no_agent_update_banner(agent["id"])
