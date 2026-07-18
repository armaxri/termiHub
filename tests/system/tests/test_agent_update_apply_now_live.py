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

## Two independent pieces, and why the banner is still injected

Driving Apply Now's deferred branch live needs **two** things, and the armed
container provides only the second:

1. **A surfaced banner.** The #1546 hook does emit ``agent.update_available`` on
   attach — but the *desktop* drops it: that notification arrives during the
   ``initialize`` handshake, and the connect path classifies every pre-initialize
   message as skip-and-discard (``agent_manager.rs`` → ``HandshakeOutcome::Skip``)
   to avoid misreading a notification as the init response. So the banner is
   surfaced the same proven way as the surfacing suite — ``emitEvent`` through the
   real ``listen`` path (the store fold is what the banner renders from). In
   production this handshake-window drop is moot: the real trigger is the 24h
   self-update timer, which never fires in the sub-second handshake.
2. **A real ``pending_update`` on the live agent.** This is the armed container's
   job (the #1546 hook, delivered via sshd's per-user environment). Without it,
   "Apply Now" — which sends no binary and consumes the agent's staged update —
   would get ``NoPendingUpdate`` and error, not defer.

## What is driven here, and the coverage boundary

With both in place, the reachable Apply-Now outcome against a live agent is the
**deferred / busy** branch:

* with a real shell session open the agent is busy, so "Apply Now" drives the
  live ``requestAgentDeferredUpdate`` desktop command → ``agent.request_deferred_update``
  RPC → ``applied: false`` — the one seam no other test exercises through the
  desktop UI (Vitest mocks the command; the Rust integration suites drive the RPC
  directly), and it defers against the agent's *real* staged update, not a faked one,
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
    TerminalUi,
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
    TerminalUi,
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

        # Make the agent busy first: a live shell session on the agent holds up an
        # immediate apply, so "Apply Now" is forced down the deferred branch. A live
        # terminal is the signal the session is established over the agent (the
        # ephemeral shell is the agent's active-session count, not the desktop's
        # `agentSessions` store, which tracks only registered/persistent sessions).
        before = self.tab_count()
        self.new_shell_session(agent["name"])
        self.wait(lambda: self.tab_count() > before, what="the new shell-session tab")
        self.wait(self.has_terminal, what="the agent shell terminal session to go live")

        # Surface the banner through the real listener (see the module docstring on
        # why the hook's on-attach notification is dropped by the desktop handshake).
        # The armed agent independently holds the *real* pending_update that makes
        # the Apply Now RPC below defer rather than error.
        self.announce_agent_update(
            agent["id"], available_version=REMOTE_AGENT_PENDING_VERSION
        )
        text = self.wait_agent_update_banner(agent["id"])
        assert REMOTE_AGENT_PENDING_VERSION in text
        update = self.agent_update_state(agent["id"])
        assert update is not None
        assert update["staged"] is True

        # Apply Now → live requestAgentDeferredUpdate command → the agent's
        # request_deferred_update RPC. Busy + a real staged update, so it defers
        # (applied: false) against the agent's genuine pending_update.
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
        # — and never interrupts the busy session (its terminal stays live).
        assert self.agent_update_state(agent["id"]) is not None
        assert (
            self.has_terminal()
        ), "the deferred request must not tear down the busy session"
