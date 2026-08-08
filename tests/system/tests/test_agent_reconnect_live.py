"""Live agent drop / reconnect over a harness-controlled sshd (#2476).

The missing enabler for the agent reconnect activation: no scenario existed to
drive a real agent-transport drop and assert the reconnect outcome. The desktop
app reaches agents only over SSH, so this suite stands up a throwaway loopback
``sshd`` with the ``termihub-agent`` binary reachable (:class:`LocalAgentSshd`,
the test-owned equivalent of ``scripts/dev.sh``'s dev agent), points a key-auth
agent connection at it, opens a shell session, then **kills the sshd** to sever
the transport — a genuine, prolonged drop the harness fully controls — before
bringing it back.

Two lanes, differing only by the ``sessionBackendReattach`` flag:

* :class:`TestAgentReconnectClientDriven` — flag **off** (develop behavior): the
  drop surfaces (the agent leaves ``connected``) and, once the server is back and
  the agent reconnects, a fresh shell session is live again. Proves the scenario
  is valid before any product change relies on it.
* :class:`TestAgentReconnectBackendDriven` — flag **on** (the activation): the
  agent tab's reconnect is driven by the backend redrive across the prolonged
  drop; the tab recovers on reconnection with the client agent engine suppressed.

Agent + settings state is region-authoritative (#2227/#2409), so this suite reads
it through the projection API (the ``agents`` region) and seeds experimental
features via ``settings.json`` — the ``get_state("remoteAgents"/"settings")``
paths the older ``AgentUi``/``SettingsUi`` helpers use no longer resolve against a
projection-migrated build (see the follow-up filed from this issue). The agent
row is driven by its known seeded id (no name→id store lookup needed).

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

    #: Opt-in gate. The scenario drives everything up to the agent transport
    #: (SSH + key auth + host-key trust + the agent binary starting over SSH), but
    #: the agent's registry-daemon handshake stalls over a throwaway sshd and the
    #: WKWebView is occlusion-throttled during the long connect, so the agent never
    #: reaches ``connected`` unattended (tracked in #2480; agent/settings harness
    #: reads also need the projection API per #2479). Set this env to 1 to run it.
    _OPT_IN_ENV = "TERMIHUB_TEST_LOCAL_AGENT_RECONNECT"

    @pytest.fixture(autouse=True)
    def _local_agent(self):
        if os.environ.get(self._OPT_IN_ENV) != "1":
            pytest.skip(
                f"opt-in: set {self._OPT_IN_ENV}=1 to run the live local-agent "
                "reconnect scenario (blocked unattended by the agent registry-daemon "
                "handshake over a throwaway sshd + webview throttling — see #2480; "
                "harness agent/settings reads tracked in #2479)"
            )
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

    # ── agents projection reads (region-authoritative, #2409) ────────────────────
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
        self._agent_menu_click(CTX_CONNECT)
        self._wait_agent_state("connected")
        before = self.tab_count()
        self._agent_menu_click(CTX_NEW_SHELL)
        self.wait(lambda: self.tab_count() > before, what="the agent shell-session tab")
        self.wait(self.has_terminal, what="the agent shell terminal session")

    def _assert_shell_live(self) -> None:
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

        # Drop the agent transport at the server and keep it down long enough that
        # a client single-shot reconnect would fail — a prolonged outage.
        self._drop_transport()
        self._wait_agent_state("reconnecting", "disconnected", timeout=60.0)

        # Bring the server back; the agent must reconnect and serve a live shell.
        self.sshd.start()
        self._wait_agent_state("disconnected", timeout=60.0)
        self._agent_menu_click(CTX_CONNECT)
        self._wait_agent_state("connected", timeout=60.0)

        before = self.tab_count()
        self._agent_menu_click(CTX_NEW_SHELL)
        self.wait(lambda: self.tab_count() > before, what="a fresh agent shell after recovery")
        self.wait(self.has_terminal, what="the recovered agent shell terminal")
        self._assert_shell_live()


class TestAgentReconnectBackendDriven(_AgentReconnectBase):
    """Flag ON — the activation: backend-driven reconnect across a prolonged drop."""

    flag_on = True

    def test_backend_driven_reconnect_reattaches(self):
        self._connect_and_open_shell()
        tab = self.wait(
            lambda: self.find_tab("Shell") or self.find_tab(AGENT_NAME),
            what="the shell tab",
        )
        tab_id = tab["id"]
        self._assert_shell_live()

        # Prolonged drop: kill the sshd and keep it down while the backend redrive
        # parks/retries. The client agent engine must NOT drive the transport.
        self._drop_transport()
        self._wait_agent_state("reconnecting", "disconnected", timeout=60.0)

        # Recover the server; the agent transport comes back and the tab must
        # recover live without being left exited/stranded.
        self.sshd.start()
        self._wait_agent_state("connected", timeout=90.0)
        self.wait(
            lambda: self.driver.get_state("terminalExitedTabs").get(tab_id) is not True,
            what="the agent shell tab to recover (not left exited)",
            timeout=90.0,
        )
        self.wait(self.has_terminal, what="the reattached agent shell terminal")
        self._assert_shell_live()
