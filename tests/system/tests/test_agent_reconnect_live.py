"""Live agent drop / reconnect over a harness-controlled sshd (#2476, #2480).

The missing enabler for the agent reconnect activation: no scenario existed to
drive a real agent-transport drop and assert the reconnect outcome. The desktop
app reaches agents only over SSH, so this suite stands up a throwaway loopback
``sshd`` with the ``termihub-agent`` binary reachable (:class:`LocalAgentSshd`,
the test-owned equivalent of ``scripts/dev.sh``'s dev agent), points a key-auth
agent connection at it, opens a shell session, then **kills the sshd** to sever
the transport — a genuine, prolonged drop the harness fully controls — before
bringing it back.

**Why this suite is log-based (supersedes the bridge-poll approach of #2520).**
During the prolonged agent reconnect the WKWebView occlusion-throttles, so a
bridge poll of the frontend state (``projection_state`` / ``get_state`` /
terminal reads) times out — ``command timed out after 60s`` — even though the app
reconnects fine. The app's **backend log is written by Rust and is immune to that
throttle**, so this suite asserts on it. Setup and the initial-``connected`` check
run through the bridge *pre-drop* (un-throttled); everything after the drop is a
bounded poll on ``app.read_log()`` (the harness's per-instance capture of the
app's merged stdout/stderr — see :meth:`AppInstance.read_log`), never the bridge.

The log markers this asserts on (grounded in the running binaries):

* Desktop (``agent_manager``): ``connection lost, attempting reconnect`` on the
  drop; ``initialize response received (...); marking connected`` when a
  (re)connect handshake completes; ``reconnection failed`` when a single-shot
  transport reconnect gives up while the server is down.
* Agent (forwarded into the desktop log as ``Agent <id>: stderr: ...``):
  ``Daemon spawned for session <sid>`` when a **fresh** session is created;
  ``Recovered session <sid>`` / ``Reattached to session <sid>`` when the **live**
  session is re-attached; ``Failed to recover session <sid>`` when it is lost.

Two lanes, differing only by the ``sessionBackendReattach`` flag:

* :class:`TestAgentReconnectClientDriven` — flag **off** (develop behavior): the
  drop surfaces in the log and, once the server is back and the connection is
  re-initiated, the handshake completes again. Proves the scenario is valid
  before any product change relies on it.
* :class:`TestAgentReconnectBackendDriven` — flag **on** (the activation): the
  backend redrive re-establishes the transport across the prolonged drop and
  **re-attaches the live daemon session** — the log shows ``Recovered``/
  ``Reattached`` for the same ``<sid>`` and **no** fresh ``Daemon spawned`` /
  ``Failed to recover`` for it. This is the unique end-to-end assertion: the
  desktop↔agent reconnect + live re-attach happened, process continuity intact.
  (Terminal *content* continuity — the var-survives / loop-continues output — is
  covered headlessly by the agent-integration tests, e.g.
  ``fresh_agent_recovers_daemon_session_from_dead_prior_agent`` and the #2519
  tests, and is deliberately NOT read back through the throttled bridge here.)

Agent + settings state is region-authoritative (#2227/#2409), so this suite reads
it through the projection API (the ``agents`` region) *pre-drop* and seeds
experimental features via ``settings.json``. The agent row is driven by its known
seeded id (no name→id store lookup needed).

Skips cleanly when the app / agent binary is not built or no ``sshd`` is present.
"""

from __future__ import annotations

import json
import os
from typing import Any, Optional

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    ConfigRecoveryUi,
    LocalAgentSshd,
    LocalAgentUnavailable,
    SidebarUi,
    TabsUi,
    TerminalUi,
    SystemTest,
    unique_name,
)

pytestmark = pytest.mark.integration

AGENT_NAME = "Local Reconnect Agent"
AGENT_ID = "test-local-reconnect-agent"
AGENT_HEADER = f"agent-header-{AGENT_ID}"
CONNECTIONS = "connections.json"
SETTINGS = "settings.json"
# Remote agents live behind the experimental-features flag; seed it on so the
# Remote Agents sidebar renders (the UI reads it from the projected settings).
SETTINGS_DOC = json.dumps({"version": "1", "experimentalFeaturesEnabled": True})

CTX_CONNECT = "context-agent-connect"
CTX_DISCONNECT = "context-agent-disconnect"
CTX_NEW_SHELL = "context-agent-new-shell"

# ── backend-log markers (see the module docstring) ────────────────────────────
# Desktop-side (agent_manager), un-prefixed:
LOG_DROP = "connection lost, attempting reconnect"
LOG_HANDSHAKE = "initialize response received"  # pairs with "; marking connected"
LOG_RECONNECT_FAILED = "reconnection failed"
# Agent-side, forwarded into the desktop log as "Agent <id>: stderr: ...":
LOG_SESSION_SPAWNED = "Daemon spawned for session"  # a FRESH session was created
LOG_SESSION_RECOVER_FAIL = "Failed to recover session"  # the live session was lost

# How long the backend redrive may take to re-establish + re-attach across a
# prolonged drop (generous — the redrive parks/retries; this is not a UI read).
RECONNECT_LOG_TIMEOUT = 180.0


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


class _AgentReconnectBase(TabsUi, TerminalUi, ConfigRecoveryUi, SidebarUi, SystemTest):
    """Shared setup: a controllable sshd + a seeded key-auth agent connection.

    Subclasses set :attr:`flag_on` to choose the ``sessionBackendReattach`` lane;
    the fixture injects the matching ``window.__TERMIHUB_*__`` global via the test
    bridge (``TERMIHUB_TEST_FLAG_*``) before the app relaunches.
    """

    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT
    flag_on: bool = False

    _FLAG_ENV = "TERMIHUB_TEST_FLAG_SESSION_BACKEND_REATTACH"

    @pytest.fixture(autouse=True)
    def _local_agent(self):
        try:
            sshd = LocalAgentSshd()
        except LocalAgentUnavailable as exc:
            pytest.skip(str(exc))
        sshd.start()
        self.sshd = sshd
        self._agents_sub: Optional[str] = None

        prev_flag = os.environ.get(self._FLAG_ENV)
        if self.flag_on:
            os.environ[self._FLAG_ENV] = "1"
        else:
            os.environ.pop(self._FLAG_ENV, None)

        def _seed() -> None:
            self.write_config(CONNECTIONS, _agent_doc(sshd))
            self.write_config(SETTINGS, SETTINGS_DOC)

        # Relaunch so the app loads the seeded agent + experimental flag + flag env.
        self.restart_app(between=_seed)
        self.switch_to_connections_sidebar()
        # The seeded experimental flag renders the Remote Agents group; its row is
        # addressable by the known id (no name→id store lookup, which is stale).
        self.wait(lambda: self.driver.exists(AGENT_HEADER), what="the seeded agent row")
        try:
            yield
        finally:
            sshd.cleanup()  # reap first so it never leaks on a slow UI teardown
            try:
                if self._agent_state() not in (None, "disconnected"):
                    self._agent_menu_click(CTX_DISCONNECT)
            except Exception:
                pass
            try:
                self.close_all_tabs()
            except Exception:
                pass
            if prev_flag is None:
                os.environ.pop(self._FLAG_ENV, None)
            else:
                os.environ[self._FLAG_ENV] = prev_flag

    # ── backend-log reads (throttle-immune — this is the whole point) ─────────────
    def _log(self) -> str:
        """The app's captured backend log (Rust stdout/stderr) so far."""
        return self.app.read_log()

    def _log_len(self) -> int:
        """A cursor into the log, so post-drop asserts ignore pre-drop lines."""
        return len(self._log())

    def _wait_log(
        self, *needles: str, since: int = 0, timeout: float = 60.0, what: str
    ) -> str:
        """Poll the log tail (from ``since``) until ANY ``needle`` appears."""
        return self.wait(
            lambda: next((n for n in needles if n in self._log()[since:]), None),
            timeout=timeout,
            what=what,
        )

    def _assert_log_absent(self, needle: str, *, since: int, what: str) -> None:
        assert needle not in self._log()[since:], (
            f"unexpected log line {needle!r} after the drop — {what}"
        )

    def _daemon_session_id(self, *, since: int = 0) -> str:
        """The daemon session id from the ``Daemon spawned for session <sid>`` log.

        Emitted by the agent when the shell's daemon-backed session is created;
        used to correlate the later ``Recovered``/``Reattached`` markers to *this*
        session. The id token follows the marker (``... session abc123 (type=…)``).
        """
        tail = self._log()[since:]
        idx = tail.find(LOG_SESSION_SPAWNED)
        assert idx != -1, "no daemon session was spawned for the opened shell"
        after = tail[idx + len(LOG_SESSION_SPAWNED):].strip()
        sid = after.split()[0] if after else ""
        assert sid, "could not parse the daemon session id from the log"
        return sid

    # ── agents projection reads (region-authoritative, #2409) — PRE-DROP ONLY ─────
    def _agents_view(self) -> list[dict[str, Any]]:
        if self._agents_sub is None:
            self._agents_sub = self.driver.projection_subscribe("agents")["subscriptionId"]
        cache = self.driver.projection_state(self._agents_sub).get("cache") or {}
        agents = cache.get("agents")
        return [a for a in agents if isinstance(a, dict)] if isinstance(agents, list) else []

    def _agent_state(self) -> Optional[str]:
        agent = next((a for a in self._agents_view() if a.get("id") == AGENT_ID), None)
        return agent.get("connectionState") if agent else None

    def _wait_agent_state(self, *states: str, timeout: float = 60.0) -> None:
        self.wait(
            lambda: self._agent_state() in states,
            what=f"agent to reach state in {states}",
            timeout=timeout,
        )

    # ── agent row driving (by known id) ──────────────────────────────────────────
    def _agent_menu_click(self, action: str) -> None:
        def opened() -> bool:
            if not self.driver.exists(AGENT_HEADER):
                return False
            self.driver.context_menu(AGENT_HEADER)
            return self.driver.exists(action)

        self.wait(opened, what=f"the agent context menu with {action}")
        self.driver.click(action)

    # ── shared steps ─────────────────────────────────────────────────────────────
    def _connect_and_open_shell(self) -> None:
        """Bridge-driven setup — runs PRE-drop, so the webview is un-throttled."""
        self._agent_menu_click(CTX_CONNECT)
        self._wait_agent_state("connected")
        before = self.tab_count()
        self._agent_menu_click(CTX_NEW_SHELL)
        self.wait(lambda: self.tab_count() > before, what="the agent shell-session tab")
        self.wait(self.has_terminal, what="the agent shell terminal session")

    def _assert_shell_live(self) -> None:
        """PRE-drop only — a round-trip through the live shell."""
        marker = unique_name("agent-echo")
        self.run_command(f"echo {marker}")
        assert marker in self.wait_for_output(marker)

    def _drop_transport(self) -> None:
        """Kill the sshd (and its session children) — a genuine transport drop."""
        self.sshd.stop()
        assert not self.sshd.is_listening()


class TestAgentReconnectClientDriven(_AgentReconnectBase):
    """Flag OFF — proves the drop/reconnect scenario against develop behavior."""

    flag_on = False

    def test_drop_surfaces_and_recovers(self):
        self._connect_and_open_shell()
        self._assert_shell_live()

        # Cursor: everything asserted below must be POST-drop log content.
        offset = self._log_len()

        # Drop the agent transport at the server. The single-shot transport
        # reconnect fires immediately, then fails while the server is down — a
        # prolonged outage a client single-shot cannot ride out (flag off).
        self._drop_transport()
        self._wait_log(LOG_DROP, since=offset, timeout=60.0, what="the drop to surface in the log")
        self._wait_log(
            LOG_RECONNECT_FAILED,
            since=offset,
            timeout=60.0,
            what="the single-shot transport reconnect to give up while the server is down",
        )

        # Bring the server back and re-initiate the connection (the connect click
        # is issued while the agent is idle/disconnected, so it is un-throttled);
        # the reconnect handshake must complete again — asserted on the log.
        self.sshd.start()
        self._agent_menu_click(CTX_CONNECT)
        self._wait_log(
            LOG_HANDSHAKE,
            since=offset,
            timeout=RECONNECT_LOG_TIMEOUT,
            what="the agent handshake to complete again after the server returns",
        )


class TestAgentReconnectBackendDriven(_AgentReconnectBase):
    """Flag ON — the activation: backend-driven reconnect across a prolonged drop."""

    flag_on = True

    def test_backend_driven_reconnect_reattaches(self):
        self._connect_and_open_shell()
        self._assert_shell_live()

        # The daemon session id of the live shell — correlates the re-attach below.
        sid = self._daemon_session_id()

        # Cursor: everything asserted below must be POST-drop log content.
        offset = self._log_len()

        # Prolonged drop: kill the sshd and keep it down while the backend redrive
        # parks/retries. The drop must surface in the backend log.
        self._drop_transport()
        self._wait_log(LOG_DROP, since=offset, timeout=60.0, what="the drop to surface in the log")

        # Recover the server. With the flag on, the backend redrive re-establishes
        # the transport WITHOUT any bridge interaction — the handshake completes
        # again (throttle-immune log read, never a frontend poll).
        self.sshd.start()
        self._wait_log(
            LOG_HANDSHAKE,
            since=offset,
            timeout=RECONNECT_LOG_TIMEOUT,
            what="the backend redrive to complete the reconnect handshake",
        )

        # THE key end-to-end assertion: the LIVE daemon session was re-attached
        # (process continuity), not silently recreated. The agent forwards its
        # recovery log into the desktop log; assert the marker names *this* sid.
        self._wait_log(
            f"Recovered session {sid}",
            f"Reattached to session {sid}",
            since=offset,
            timeout=RECONNECT_LOG_TIMEOUT,
            what=f"the live agent session {sid} to be re-attached after reconnect",
        )

        # Negatives that would betray a lost/recreated session after the drop:
        #   * a FRESH "Daemon spawned for session" (== a new "Created session"), and
        #   * "Failed to recover session" (== the "session_lost" fold).
        # Neither may appear in the post-drop window if the live session survived.
        self._assert_log_absent(
            LOG_SESSION_SPAWNED,
            since=offset,
            what="the live session must be re-attached, not recreated",
        )
        self._assert_log_absent(
            LOG_SESSION_RECOVER_FAIL,
            since=offset,
            what="the live session must not be lost across the reconnect",
        )
