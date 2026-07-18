"""Live deferred-update "Apply Now" E2E (#1520, follow-up to PR #1564 / #1546).

PR #1564 delivered the banner-*surfacing* half of #1520 and deliberately left the
issue open: **Apply Now** could not be driven, because a live agent never held a
``pending_update`` under test, so ``agent.request_deferred_update`` had nothing to
defer. #1546 landed the env-gated hook that fixes exactly that — armed, an agent
stages a ``pending_update`` at startup and announces it on every attach — and this
suite is its desktop-UI consumer.

## Why a *separate* container

The hook is armed by ``TERMIHUB_AGENT_TEST_PENDING_UPDATE``, which is deliberately
**not** a CLI flag and can never appear in the desktop's SSH exec command (see
``agent/src/update/test_hook.rs``). It reaches the agent process only through
sshd's per-user environment file, which is image-baked. Arming the *shared*
``remote-agent`` container would make every connect announce an update — breaking
the banner-surfacing suite, whose gating tests assert no banner appears until they
announce one. So this drives a dedicated armed image,
``remote-agent-pending-update`` (compose profile ``agent``, port 2214), built from
the same context with ``PENDING_UPDATE_VERSION`` set.

## What is driven here, and the coverage boundary

The reachable Apply-Now outcome against a live agent is the **deferred / busy**
branch:

* the armed agent announces its staged update on attach, so the banner surfaces
  through the real ``listen`` path with **no injected event** (unlike the
  surfacing suite, which must fake the stimulus with ``emitEvent``),
* with a real shell session open the agent is busy, so "Apply Now" drives the
  live ``requestAgentDeferredUpdate`` desktop command → ``agent.request_deferred_update``
  RPC → ``applied: false`` — the one seam no other test exercises through the
  desktop UI (Vitest mocks the command; the Rust integration suites drive the RPC
  directly),
* the deferred handler dismisses the banner while **keeping** the staged update
  (it still lands on the last disconnect) and **never interrupts** the session.

The deferred branch is distinguished from a failed apply *without* reading the
toast — toasts carry no ``data-testid`` and no system test asserts one. Only the
deferred (non-error) branch dismisses the banner, so the dismissed flag plus the
retained update record is an unambiguous, testid-based signal. The toast's exact
*wording and session count* stay a Vitest case (``AgentUpdateBanner.test.tsx``),
as does the **applied-immediately** toast, which remains architecturally
unreachable live: an idle apply swaps the binary and re-execs before the RPC can
respond (and the armed hook's default staged path does not exist, so an idle apply
would fail rather than succeed anyway).
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    REMOTE_AGENT_PENDING_PORT,
    REMOTE_AGENT_PENDING_VERSION,
    SSH_HOST,
    SSH_PASSWORD,
    SSH_USERNAME,
    AgentUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    unique_name,
)

pytestmark = pytest.mark.integration


@pytest.mark.usefixtures("remote_agent_pending_fixtures")
class TestAgentUpdateApplyNowLive(
    AgentUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    TabsUi,
    SystemTest,
):
    """Drive the banner's deferred Apply-Now path against the armed agent container."""

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
        """Create a password-auth agent against the armed container and connect it."""
        name = unique_name(label)
        agent = self.create_remote_agent(
            name, host=SSH_HOST, port=REMOTE_AGENT_PENDING_PORT, username=SSH_USERNAME
        )
        self.connect_agent(agent["name"])
        self.handle_password_prompt(SSH_PASSWORD)
        self.wait_agent_connected(agent["name"])
        return agent

    def test_apply_now_defers_while_a_session_is_busy(self):
        agent = self._create_and_connect("agent-apply-now-deferred")

        # The armed agent announces its staged update on attach (#1546 hook), so
        # the banner surfaces through the real listener without any injected event.
        text = self.wait_agent_update_banner(agent["id"])
        assert REMOTE_AGENT_PENDING_VERSION in text
        update = self.agent_update_state(agent["id"])
        assert update is not None
        assert update["staged"] is True

        # Make the agent busy: an open shell session holds up an immediate apply,
        # so "Apply Now" is forced down the deferred branch.
        before = self.tab_count()
        self.new_shell_session(agent["name"])
        self.wait(lambda: self.tab_count() > before, what="the new shell-session tab")
        self.wait(
            lambda: len(self.agent_sessions(agent["id"])) >= 1,
            what="the agent to report an active session",
        )

        # Apply Now → live requestAgentDeferredUpdate command → the agent's
        # request_deferred_update RPC. Busy, so it defers (applied: false).
        self.apply_agent_update_now(agent["id"])

        # The deferred handler dismisses the banner (an errored apply would leave
        # it up), so the dismissed flag going true is the proof the deferred RPC
        # round-tripped through the desktop end to end.
        self.wait(
            lambda: self.agent_update_dismissed(agent["id"]),
            what="the deferred Apply Now to dismiss the banner",
        )
        self.wait_no_agent_update_banner(agent["id"])

        # Deferred keeps the staged update — it still lands on the last disconnect
        # — and never interrupts the active session.
        assert self.agent_update_state(agent["id"]) is not None
        assert (
            len(self.agent_sessions(agent["id"])) >= 1
        ), "the deferred request must not tear down the busy session"
