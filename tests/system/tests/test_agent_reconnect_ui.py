"""Automated full-app agent-reconnect **UI** grade over the bridge (#2574).

This supersedes ``test_agent_reconnect_live.py`` (which asserted on the Rust
**log**, not the UI, and was gated on a scarce foreground display). It drives the
real desktop app through the complete agent-reconnect UI cycle and asserts on
what the **user sees** — the disconnect overlay, the tab list, and the terminal
buffer — read through the WebSocket bridge, never on pixels and never on the log.

**The deterministic break primitive (#2573).** The transport is severed with the
in-process ``test_sever_agent_transport`` bridge command (exposed as
:meth:`Driver.sever_agent_transport`), not the retired ``lsof``/process-title
shell drop (which false-passed in #2510/#2550) and not a clean ``disconnect_agent``
(which is a user-cancel, not a transport loss). The command drops the desktop
russh transport in-process, so the peer's sshd handler sees an abrupt EOF/RST —
a faithful analog of a real transport drop — while the setsid'd session daemon
survives and the sshd master keeps listening, so the reconnect re-adopts the
live session. It needs no operator, no root, no port lookup.

**Why this runs unattended (no display gate).** The old suite needed a
foreground display because the *client*-driven reconnect engine parked the
WKWebView's JS timers when the window was not foreground-active. That engine was
deleted (#2558) and reconnect is now **backend-driven** (#2560): the Rust I/O
task drives the whole reconnect and folds the ``session-lifecycle`` region
server-side (#2556), so the outcome cannot be webview-stalled. The frontend
overlay is a pure projection **mirror** of that region, and the test-bridge
anti-throttle (``macos_unthrottle`` — occlusion detection off + an
``NSProcessInfo`` activity assertion, engaged whenever ``TERMIHUB_TEST_BRIDGE_PORT``
is set, #2480) keeps its timers ticking headless. Every bridge poll additionally
drives the event loop. So this suite drops the ``ensure_display_backed_runner``
gate and runs on any runner that can launch the app + a loopback sshd. It stays
on the nightly ``-m integration`` lane because it needs the built app, a real
``sshd``, and the ``termihub-agent`` binary — not because it needs a display.

The grade (mirrors the retired manual checklist in
``scripts/internal/verify-agent-reconnect.sh``, now deleted):

1. connect a key-auth agent at a harness-controlled loopback sshd, open a shell,
   and start a 1 Hz counter in it;
2. **sever** the transport in-process → the SAME tab shows **Reconnecting…** (it
   must not vanish, close, or spawn a second tab);
3. the transport re-establishes over the still-listening sshd → the SAME tab
   re-attaches the SAME live session: the counter catches up **past** its
   pre-drop value (never restarts at 0) and keeps ticking, with **no duplicate
   tab** — the #2512 continuity headline;
4. the re-attached shell is **interactive** (Ctrl-C stops the counter, an echo
   round-trips);
5. a **permanent** sever (endpoint held down) **parks** in Reconnecting without
   vanishing, then settles a clean **Disconnected** via the overlay's Stop
   affordance — the anti-stranding invariant.

Skips cleanly when the app / agent binary is not built or no ``sshd`` is present.
"""

from __future__ import annotations

import json
import os
import re
import time
from typing import Optional

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    BridgeError,
    ConfigRecoveryUi,
    LocalAgentSshd,
    LocalAgentUnavailable,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration

# The ``LocalAgentSshd`` fixture only guards that an ``sshd`` *binary* is present
# (it is on the GitHub-hosted runners) — not that a full app→agent connect +
# deploy actually succeeds over it. The nightly GUI macOS runner does not yet
# stand up a working live dev-agent sshd endpoint, so the connect in
# ``_connect_and_open_shell`` times out at "agent never reaches connected" and
# hard-fails the lane (#2626 cat B; the lane itself was only just activated in
# #2618). Skip cleanly on CI until a dev-agent is provisioned there; opt back in
# by exporting ``TERMIHUB_LIVE_AGENT=1`` once the runner stands one up (closing
# the #2618 / #2579 reconnect-grade loop). On a dev box (no CI env) this always
# runs, so the grade still exercises where a live dev-agent IS available.
LIVE_AGENT_SKIP_REASON = (
    "needs a provisioned live dev-agent sshd the CI runner lacks; export "
    "TERMIHUB_LIVE_AGENT=1 once one is stood up (#2626, #2618)"
)
_ON_CI = os.environ.get("CI") == "true" or os.environ.get("GITHUB_ACTIONS") == "true"
_LIVE_AGENT_OPT_IN = os.environ.get("TERMIHUB_LIVE_AGENT") == "1"
skip_without_live_agent = pytest.mark.skipif(
    _ON_CI and not _LIVE_AGENT_OPT_IN, reason=LIVE_AGENT_SKIP_REASON
)

AGENT_NAME = "Local Reconnect Agent"
AGENT_ID = "test-local-reconnect-agent"
AGENT_HEADER = f"agent-header-{AGENT_ID}"
CONNECTIONS = "connections.json"
SETTINGS = "settings.json"
# Remote agents live behind the experimental-features flag; seed it on so the
# Remote Agents sidebar group renders (the UI reads it from projected settings).
SETTINGS_DOC = json.dumps({"version": "1", "experimentalFeaturesEnabled": True})

CTX_CONNECT = "context-agent-connect"
CTX_DISCONNECT = "context-agent-disconnect"
CTX_NEW_SHELL = "context-agent-new-shell"

# Disconnect-overlay testids (see TerminalDisconnectOverlay.tsx). The overlay
# root id is shared by every variant; the variant is told apart by which control
# it renders: the reconnecting variant has the Stop button + a "Reconnecting…"
# heading, the standard disconnected variant has the Reconnect button.
OVERLAY = "terminal-disconnect-overlay"
OVERLAY_STOP = "terminal-disconnect-stop-btn"
OVERLAY_RECONNECT = "terminal-disconnect-reconnect-btn"

# A 1 Hz counter that prints ``TICK=<n>`` forever — the process whose continuity
# across the outage is the #2512 headline. ``sleep 1`` keeps it cheap; the marker
# is greppable so the buffer read can parse the current count.
COUNTER_CMD = "i=0; while true; do echo TICK=$i; i=$((i+1)); sleep 1; done"
_TICK_RE = re.compile(r"TICK=(\d+)")

# The transport retries with exponential backoff (2s, 4s, …) and the daemon
# buffers output through the outage, so recovery + catch-up is not instant.
RECOVERY_TIMEOUT = 90.0


def _agent_doc(sshd: LocalAgentSshd) -> str:
    """A v2 nested connections store carrying one key-auth agent at ``sshd``."""
    return json.dumps(
        {
            "version": "2",
            "children": [],
            "agents": [
                {
                    "id": AGENT_ID,
                    "name": AGENT_NAME,
                    "config": {
                        "host": "127.0.0.1",
                        "port": sshd.port,
                        "username": sshd.username,
                        "authMethod": "key",
                        "keyPath": sshd.client_key_path,
                        "agentPath": sshd.agent_binary_path,
                    },
                    "agentSettings": {
                        "enableMonitoring": False,
                        "enableFileBrowser": True,
                        "enableDocker": False,
                        "startingDirectory": "~",
                        "logLevel": "info",
                        "verboseTracing": False,
                        "persistentScrollbackBufferSizeMb": 1,
                    },
                }
            ],
        }
    )


@skip_without_live_agent
class TestAgentReconnectUi(TabsUi, TerminalUi, ConfigRecoveryUi, SidebarUi, SystemTest):
    """The full agent-reconnect UI cycle, driven by the #2573 in-process sever."""

    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT

    @pytest.fixture(autouse=True)
    def _local_agent(self):
        try:
            sshd = LocalAgentSshd()
        except LocalAgentUnavailable as exc:
            pytest.skip(str(exc))
        sshd.start()
        self.sshd = sshd

        def _seed() -> None:
            self.write_config(CONNECTIONS, _agent_doc(sshd))
            self.write_config(SETTINGS, SETTINGS_DOC)

        # Relaunch so the app loads the seeded agent + experimental flag.
        self.restart_app(between=_seed)
        self.switch_to_connections_sidebar()
        self.wait(lambda: self.driver.exists(AGENT_HEADER), what="the seeded agent row")
        try:
            yield
        finally:
            self.sshd.cleanup()  # reap first so it never leaks on a slow teardown
            try:
                self._agent_menu_click(CTX_DISCONNECT)
            except Exception:
                pass
            try:
                self.close_all_tabs()
            except Exception:
                pass

    # ── agent row driving (by known id) ──────────────────────────────────────────
    def _agent_menu_click(self, action: str) -> None:
        def opened() -> bool:
            if not self.driver.exists(AGENT_HEADER):
                return False
            self.driver.context_menu(AGENT_HEADER)
            return self.driver.exists(action)

        self.wait(opened, what=f"the agent context menu with {action}")
        self.driver.click(action)

    def _agent_connection_state(self) -> Optional[str]:
        """The seeded agent's ``connectionState`` from the projected agents region.

        Region-authoritative (#2409): connectedness is read from the same
        projection the sidebar renders, never from a log. Returns ``None`` until
        the region lists the agent.
        """
        try:
            cache = self.projection_region_cache("agents")
        except BridgeError:
            return None
        agents = cache.get("agents")
        if not isinstance(agents, list):
            return None
        for agent in agents:
            if isinstance(agent, dict) and agent.get("id") == AGENT_ID:
                state = agent.get("connectionState")
                return state if isinstance(state, str) else None
        return None

    # ── terminal buffer helpers ──────────────────────────────────────────────────
    def _max_tick(self, tab_id: str) -> Optional[int]:
        """Highest ``TICK=<n>`` currently in ``tab_id``'s buffer, or None."""
        try:
            text = self.driver.read_terminal(tab_id)
        except BridgeError:
            return None
        values = [int(m) for m in _TICK_RE.findall(text)]
        return max(values) if values else None

    def _wait_tick_at_least(self, tab_id: str, minimum: int, *, timeout: float) -> int:
        """Wait until the counter in ``tab_id`` has reached ``>= minimum``."""
        return self.wait(
            lambda: (lambda v: v if v is not None and v >= minimum else None)(
                self._max_tick(tab_id)
            ),
            timeout=timeout,
            what=f"the counter in tab {tab_id} to reach {minimum}",
        )

    # ── shared steps ─────────────────────────────────────────────────────────────
    def _connect_and_open_shell(self) -> str:
        """Connect the agent, open a shell tab, and return the shell tab id.

        Connectedness is read from the projected agents region (region-
        authoritative), then a shell is opened via the agent context menu. The
        new tab is identified as the one that appears — that id anchors every
        later same-tab / no-duplicate-tab assertion.
        """
        self._agent_menu_click(CTX_CONNECT)
        self.wait(
            lambda: self._agent_connection_state() == "connected",
            timeout=60.0,
            what="the agent to reach connectionState=connected",
        )
        before_ids = set(self.tab_ids())
        self._agent_menu_click(CTX_NEW_SHELL)
        new_ids = self.wait(
            lambda: (lambda extra: extra if extra else None)(set(self.tab_ids()) - before_ids),
            what="the agent shell-session tab to open",
        )
        assert len(new_ids) == 1, f"expected exactly one new shell tab, got {new_ids}"
        shell_tab = next(iter(new_ids))
        # Wait for the shell to be a readable terminal with a prompt.
        self.wait(
            lambda: bool((self.driver.read_terminal(shell_tab) or "").strip()),
            what="the agent shell terminal to become readable",
        )
        return shell_tab

    def _assert_reconnecting(self, shell_tab: str, *, timeout: float) -> None:
        """Assert the overlay is in its **Reconnecting** variant on the same tab.

        The reconnecting variant is the one carrying the Stop button and a
        "Reconnecting…" heading. The tab must still exist (not vanish/close).
        """

        def reconnecting() -> bool:
            if not self.driver.exists(OVERLAY_STOP):
                return False
            try:
                heading = self.driver.get_text(OVERLAY)
            except BridgeError:
                return False
            return "Reconnecting" in heading

        self.wait(reconnecting, timeout=timeout, what="the tab to show the Reconnecting overlay")
        assert shell_tab in self.tab_ids(), "the agent tab vanished instead of showing Reconnecting"

    # ── the grade ────────────────────────────────────────────────────────────────
    def test_agent_reconnect_ui_cycle(self):
        shell_tab = self._connect_and_open_shell()

        # Start the counter and let it clearly run before the drop. The freshly
        # opened shell is the active tab, but switch to it explicitly so the
        # counter command lands there deterministically.
        self.switch_to_tab(shell_tab)
        self.run_command(COUNTER_CMD)
        before = self._wait_tick_at_least(shell_tab, 3, timeout=30.0)
        agent_tab_count = self.tab_count()

        # ── SEVER (recoverable): in-process transport break, sshd left listening.
        assert self.sshd.is_listening(), "sshd must be up for the recoverable sever"
        severed = self.driver.sever_agent_transport(AGENT_ID)
        assert severed, "sever_agent_transport reported no live agent to sever"

        # The SAME tab must show Reconnecting (the transport retries after a >=2s
        # backoff, so this window is reliably observable), never vanish or dup.
        self._assert_reconnecting(shell_tab, timeout=30.0)
        assert self.tab_count() == agent_tab_count, "a tab appeared/closed during the drop"

        # ── RE-ATTACH: the SAME live session continues on the SAME tab. The daemon
        # buffered the counter through the outage, so it catches up PAST the
        # pre-drop value (never restarts at 0) and keeps ticking.
        after = self._wait_tick_at_least(shell_tab, before + 1, timeout=RECOVERY_TIMEOUT)
        assert after > before, f"counter did not advance past the pre-drop value ({after} <= {before})"
        # No duplicate tab, no second connection: the shell tab is the same one.
        assert shell_tab in self.tab_ids(), "the original agent shell tab is gone after reconnect"
        assert self.tab_count() == agent_tab_count, "a duplicate agent tab was created on reconnect"
        # The overlay clears once the session is re-attached.
        self.wait(
            lambda: not self.driver.exists(OVERLAY_STOP),
            timeout=RECOVERY_TIMEOUT,
            what="the Reconnecting overlay to clear after re-attach",
        )

        # ── INTERACTIVE after re-attach: Ctrl-C stops the foreground counter, then
        # an echo round-trips in the SAME tab (manual step 7).
        self.driver.terminal_input("\x03", tab_id=shell_tab)  # SIGINT breaks the loop
        # The loop is stopped once the count stabilises across two reads.
        self.wait(
            self._counter_stopped(shell_tab), timeout=30.0, what="the counter to stop after Ctrl-C"
        )
        marker = unique_name("reattach-echo")
        self.driver.terminal_input(f"echo {marker}", tab_id=shell_tab)
        self.wait(
            lambda: marker in (self.driver.read_terminal(shell_tab) or ""),
            timeout=30.0,
            what=f"{marker!r} to echo in the re-attached shell",
        )

        # ── PERMANENT sever: hold the endpoint DOWN so the reconnect provably
        # cannot succeed, then sever. It must PARK in Reconnecting (never vanish),
        # then settle a clean Disconnected via the overlay Stop affordance.
        #
        # True 10-retry backend exhaustion (~210s) landing Disconnected on its own
        # is covered deterministically by the Rust test
        # ``permanent_transport_loss_parks_distinct_from_user_cancel`` (#2573); this
        # UI grade drives the same settle through the user-visible Stop control
        # rather than re-timing ~3.5 minutes of backoff in CI. The daemon is
        # setsid'd, so stopping the sshd does not touch it.
        self.sshd.stop()
        assert not self.sshd.is_listening(), "sshd should be down for the permanent sever"
        self.driver.sever_agent_transport(AGENT_ID)

        # Parks: Reconnecting appears and stays put (tab never vanishes) — sampled
        # across several seconds spanning multiple failing retries.
        self._assert_reconnecting(shell_tab, timeout=30.0)
        deadline = time.monotonic() + 6.0
        while time.monotonic() < deadline:
            assert self.driver.exists(OVERLAY_STOP), "the tab left Reconnecting while the endpoint was down"
            assert shell_tab in self.tab_ids(), "the agent tab vanished during the permanent outage"
            time.sleep(0.5)

        # Settle a clean Disconnected: the Stop control folds the tab to the
        # standard disconnect overlay (Reconnect button present, Stop gone).
        self.driver.click(OVERLAY_STOP)
        self.wait(
            lambda: self.driver.exists(OVERLAY_RECONNECT) and not self.driver.exists(OVERLAY_STOP),
            timeout=30.0,
            what="the tab to settle a clean Disconnected overlay",
        )
        assert shell_tab in self.tab_ids(), "the agent tab vanished instead of settling Disconnected"

    def _counter_stopped(self, tab_id: str):
        """A predicate that is true once the counter's value stops changing."""
        last = {"value": self._max_tick(tab_id), "stable": 0}

        def check() -> bool:
            current = self._max_tick(tab_id)
            if current is not None and current == last["value"]:
                last["stable"] += 1
            else:
                last["value"] = current
                last["stable"] = 0
            return last["stable"] >= 2

        return check
