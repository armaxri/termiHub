"""Live agent drop / reconnect over a harness-controlled sshd (#2476, #2512, #2480).

The missing enabler for the agent reconnect activation: no scenario existed to
drive a real agent-transport drop and assert the reconnect outcome. The desktop
app reaches agents only over SSH, so this suite stands up a throwaway loopback
``sshd`` with the ``termihub-agent`` binary reachable (:class:`LocalAgentSshd`,
the test-owned equivalent of ``scripts/dev.sh``'s dev agent), points a key-auth
agent connection at it, opens a shell session, then **kills the sshd** to sever
the transport — a genuine, prolonged drop the harness fully controls — before
bringing it back.

Because the agent's session daemon detaches from the sshd session (``setsid``),
killing the sshd severs only the *transport*: the daemon-held shell **keeps
running**. That is what makes the real requirement testable end to end — a
backend-driven re-attach must reconnect the tab to the *same live shell
instance*, not spawn a fresh one (#2512, maintainer decision).

Two lanes, differing only by the ``sessionBackendReattach`` flag:

* :class:`TestAgentReconnectClientDriven` — flag **off** (develop behavior): the
  drop surfaces (the agent leaves ``connected``) and, once the server is back and
  the agent reconnects, a fresh shell session is live again. Proves the scenario
  is valid before any product change relies on it.
* :class:`TestAgentReconnectBackendDriven` — flag **on** (the activation): the
  agent tab's reconnect is driven by the backend redrive across the prolonged
  drop, and the tab re-attaches to the **same running shell**. Asserts the real
  requirement the way the maintainer framed it:
    - a shell **variable set before the drop survives** the re-attach (a fresh
      shell would have no such variable);
    - a **running loop keeps advancing** across the drop (the process never
      paused or restarted at 0);
    - the pre-drop scrollback is **not duplicated** on re-attach — the
      end-to-end guard for the #2515 / #2518 duplicate-scrollback regression.

Agent + settings state is region-authoritative (#2227/#2409), so this suite reads
it through the projection API (the ``agents`` region) and seeds experimental
features via ``settings.json`` — the ``get_state("remoteAgents"/"settings")``
paths the older ``AgentUi``/``SettingsUi`` helpers use no longer resolve against a
projection-migrated build (see the follow-up filed from this issue). The agent
row is driven by its known seeded id (no name→id store lookup needed).

Skips cleanly when the app / agent binary is not built or no ``sshd`` is present.
The live grade is a **display-backed** run (a headless WKWebView occlusion-
throttles the long connect, so the agent never reaches ``connected`` unattended —
see #2480); it is no longer hidden behind an opt-in env var so the coordinator can
launch it directly in a foreground session.
"""

from __future__ import annotations

import json
import os
import re
import uuid
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

    def _open_shell_tab_id(self) -> str:
        """Connect the agent, open a shell, and return the shell tab's id."""
        self._connect_and_open_shell()
        tab = self.wait(
            lambda: self.find_tab("Shell") or self.find_tab(AGENT_NAME),
            what="the agent shell tab",
        )
        return tab["id"]

    def _assert_shell_live(self) -> None:
        marker = unique_name("agent-echo")
        self.run_command(f"echo {marker}")
        assert marker in self.wait_for_output(marker)

    def _drop_transport(self) -> None:
        """Kill the sshd (and its session children) — a genuine transport drop."""
        self.sshd.stop()
        assert not self.sshd.is_listening()

    # ── tab-targeted shell I/O (survives the re-attach re-focus) ──────────────────
    def _type(self, tab_id: str, command: str) -> None:
        """Send a command line to a specific tab, retrying while it registers.

        Targets the tab by id (not the active-tab default) so a shell the
        re-attach may not have re-focused still receives input; a failed send
        transmits nothing, so the retry never double-sends.
        """
        self.wait(
            lambda: (self.driver.terminal_input(command, tab_id) or True),
            what="the shell session to accept input",
        )

    def _read(self, tab_id: str) -> str:
        """The full logical-line buffer (viewport + scrollback) of a tab."""
        return self.driver.read_terminal(tab_id)

    def _wait_output(self, tab_id: str, needle: str, *, timeout: float = 30.0) -> str:
        return self.wait(
            lambda: (lambda t: t if needle in t else None)(self._read(tab_id)),
            timeout=timeout,
            what=f"{needle!r} in the shell output",
        )

    def _count_in_terminal(self, tab_id: str, needle: str) -> int:
        return self._read(tab_id).count(needle)

    def _max_counter(self, tab_id: str, prefix: str) -> Optional[int]:
        """Highest ``<prefix>=<n>`` value currently in the tab's buffer, or None."""
        vals = [int(m) for m in re.findall(rf"{re.escape(prefix)}=(\d+)", self._read(tab_id))]
        return max(vals) if vals else None

    def _drop_and_reattach(self, tab_id: str) -> None:
        """Sever the transport, restore it, and wait for a backend-driven re-attach.

        The prolonged drop parks the backend redrive; on restore the agent
        transport comes back and the tab must recover **live** (re-attached to the
        same daemon-held session), never left exited/stranded.
        """
        self._drop_transport()
        self._wait_agent_state("reconnecting", "disconnected", timeout=60.0)
        self.sshd.start()
        self._wait_agent_state("connected", timeout=90.0)
        self.wait(
            lambda: self.driver.get_state("terminalExitedTabs").get(tab_id) is not True,
            what="the agent shell tab to re-attach (not left exited)",
            timeout=90.0,
        )
        self.wait(
            lambda: bool(self._read(tab_id).strip()),
            what="the re-attached shell terminal to be readable",
            timeout=90.0,
        )


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
        """The basic requirement: the tab recovers live (not left exited)."""
        self._connect_and_open_shell()
        tab = self.wait(
            lambda: self.find_tab("Shell") or self.find_tab(AGENT_NAME),
            what="the shell tab",
        )
        tab_id = tab["id"]
        self._assert_shell_live()

        # Prolonged drop: kill the sshd and keep it down while the backend redrive
        # parks/retries. The client agent engine must NOT drive the transport.
        self._drop_and_reattach(tab_id)
        self.wait(self.has_terminal, what="the reattached agent shell terminal")
        self._assert_shell_live()

    def test_shell_variable_survives_reattach(self):
        """A variable set before the drop is still set after the re-attach.

        The truest proof it is the *same* shell instance: a freshly-minted shell
        would echo an empty ``MYVAR``.
        """
        tab_id = self._open_shell_tab_id()
        value = f"live{uuid.uuid4().hex[:8]}"
        self._type(tab_id, f"MYVAR={value}")
        # Prove it is set in the pre-drop shell (the output line carries the
        # expanded value; the typed command line shows the literal ``$MYVAR``).
        self._type(tab_id, "echo PRE-$MYVAR-END")
        self._wait_output(tab_id, f"PRE-{value}-END")

        self._drop_and_reattach(tab_id)

        # After the backend-driven re-attach the same shell answers, so the
        # variable is still set.
        self._type(tab_id, "echo VARWAS-$MYVAR-END")
        assert f"VARWAS-{value}-END" in self._wait_output(tab_id, f"VARWAS-{value}-END")

    def test_running_loop_continues_across_reattach(self):
        """A running loop keeps advancing across the drop — never paused/restarted.

        Starts a self-incrementing loop in the live shell, notes the last counter
        value before the drop, then after re-attach asserts the counter is past
        that value (the daemon-held process kept ticking, it did not restart at 0)
        and keeps advancing (it is genuinely live, not a frozen replay).
        """
        tab_id = self._open_shell_tab_id()
        tick = f"TCK{uuid.uuid4().hex[:8]}"
        self._type(
            tab_id,
            f"i=0; while true; do echo {tick}=$i; i=$((i+1)); sleep 0.3; done",
        )
        # Let it run a few seconds so the pre-drop value is unambiguously non-zero
        # (a restarted-from-0 shell could not reach it fast after re-attach).
        self.wait(
            lambda: (self._max_counter(tab_id, tick) or -1) >= 5,
            what="the loop to emit several ticks before the drop",
            timeout=30.0,
        )
        before = self._max_counter(tab_id, tick)
        assert before is not None and before >= 5

        self._drop_and_reattach(tab_id)

        # The counter has advanced past the pre-drop value (continued, not reset)…
        resumed = self.wait(
            lambda: (lambda m: m if m is not None and m > before else None)(
                self._max_counter(tab_id, tick)
            ),
            what=f"the loop counter to advance past {before} after re-attach",
            timeout=60.0,
        )
        # …and keeps advancing (the process is live, not a stalled buffer replay).
        self.wait(
            lambda: (self._max_counter(tab_id, tick) or -1) > resumed,
            what="the loop counter to keep advancing after re-attach",
            timeout=30.0,
        )

    def test_no_duplicate_scrollback_on_reattach(self):
        """Pre-drop scrollback is not duplicated on re-attach (#2515 / #2518).

        Emits a unique marker whose *output* is the needle while the typed command
        text is not (adjacent quoted string literals concatenate, so the literal
        never contains the contiguous needle) — so a buffer count reflects real
        emissions only. The duplicate-scrollback regression would replay the local
        scrollback on re-attach and make the marker appear twice.
        """
        tab_id = self._open_shell_tab_id()
        tok = uuid.uuid4().hex[:8]
        needle = f"SCROLL{tok}END"
        self._type(tab_id, f'printf "%s\\n" "SCROLL{tok}""END"')
        self._wait_output(tab_id, needle)
        assert self._count_in_terminal(tab_id, needle) == 1, "marker should appear once pre-drop"

        self._drop_and_reattach(tab_id)

        # Land fresh output after the re-attach, so any faulty scrollback replay
        # would already have happened by the time we count…
        live = uuid.uuid4().hex[:8]
        self._type(tab_id, f'printf "%s\\n" "AFT""{live}"')
        self._wait_output(tab_id, f"AFT{live}")
        # …then the pre-drop marker must still appear exactly once.
        assert self._count_in_terminal(tab_id, needle) == 1, (
            "pre-drop scrollback marker duplicated on re-attach "
            "(regression of #2515 / #2518)"
        )
