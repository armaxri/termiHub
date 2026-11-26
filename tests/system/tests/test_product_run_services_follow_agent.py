"""Product run: services follow their agent when it is killed and restarted (#6053).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). A file server runs on the run's agent.
The agent's process is killed: the row reads "Not reachable" and says why. Stop
pressed while the agent is gone reads "Stopping"; once the agent is connected
again the row reads "Stopped". The server's Activity (#6028, slice 9) then lists
what happened in that order, newest first.

A tunnel on the agent follows the same way: "Not reachable" with why while the
agent is gone, and once it is back the row follows what the agent says (stopped
for an agent started over SSH, which starts fresh; running for a ``--listen``
agent that kept it).

An auto-start before the agent is connected: after a restart of the app with
the agent gone, a file server and a tunnel on it read "Waiting"; once the agent
is connected they read "Running", and what listens on their ports is the agent,
never this computer's app.

The ``test_grade_*`` functions grade fixed observations without an app and run
in the normal lane.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from typing import Any

import psutil
import pytest

from termihub_harness import (
    SSH_HOST,
    AgentUi,
    ConnectionsUi,
    EmbeddedServicesUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.agent_deploy import AgentDeployUi, reap_agents_under
from termihub_harness.product_run.ssh_steps import SshPhaseUi

INSTALL_DIR = "services-follow-agent"
#: What happened, oldest first, as Activity names the states.
FOLLOWED = ["Running", "Not reachable", "Stopping", "Stopped"]


def follow_problems(states: list[str], reason_while_gone: str) -> list[str]:
    """What is wrong with the row's states (oldest first) and its reason while gone."""
    problems: list[str] = []
    expected = ["running", "notReachable", "stopping", "stopped"]
    if states != expected:
        problems.append(f"the row went {states}, expected {expected}")
    if "agent" not in reason_while_gone.lower():
        problems.append(f"while the agent is gone the row does not say why: {reason_while_gone!r}")
    return problems


def activity_problems(lines: list[str]) -> list[str]:
    """Whether Activity's lines (newest first) hold :data:`FOLLOWED` in order."""
    words = [next((w for w in FOLLOWED if w in line), None) for line in reversed(lines)]
    seen = [w for w in words if w is not None]
    at = 0
    for word in seen:
        if at < len(FOLLOWED) and word == FOLLOWED[at]:
            at += 1
    if at < len(FOLLOWED):
        return [f"Activity misses {FOLLOWED[at]!r} after {FOLLOWED[:at]}: {lines}"]
    return []


#: Tunnel states: ``disconnected`` is the row's "Stopped".
TUNNEL_AFTER = ("disconnected", "connected")


def tunnel_follow_problems(states: list[str], reason_while_gone: str) -> list[str]:
    """What is wrong with a tunnel's states (oldest first) across a killed agent."""
    problems: list[str] = []
    if states[:2] != ["connected", "notReachable"]:
        problems.append(f"the tunnel went {states[:2]}, expected ['connected', 'notReachable']")
    after = states[2] if len(states) > 2 else None
    if after not in TUNNEL_AFTER:
        problems.append(f"after the reconnect the tunnel reads {after!r}, not stopped or running")
    if "agent" not in reason_while_gone.lower():
        problems.append(f"while the agent is gone the tunnel does not say why: {reason_while_gone!r}")
    return problems


def auto_start_problems(
    waiting: dict[str, str | None],
    running: dict[str, str | None],
    listeners: dict[str, dict[str, bool]],
) -> list[str]:
    """Grade auto-starts across a late agent.

    ``waiting`` and ``running`` map each service to its status before and after
    the agent connects; ``listeners`` maps it to who listens on its port once it
    runs: ``{"agent": …, "app": …}``.
    """
    problems: list[str] = []
    for service, status in waiting.items():
        if status != "waiting":
            problems.append(f"{service} reads {status!r} before its agent connects, not 'waiting'")
    want = {"server": "running", "tunnel": "connected"}
    for service, status in running.items():
        if status != want.get(service):
            problems.append(f"{service} reads {status!r} once its agent is connected")
    for service, who in listeners.items():
        if who.get("app"):
            problems.append(f"this computer's app listens on {service}'s port")
        if not who.get("agent"):
            problems.append(f"the agent does not listen on {service}'s port")
    return problems


# ── app-free grade tests ──────────────────────────────────────────────────
WHY = "Its agent is offline. It may still run there; termiHub cannot tell."


def test_grade_followed_passes():
    assert follow_problems(["running", "notReachable", "stopping", "stopped"], WHY) == []


def test_grade_a_row_that_stays_running_fails():
    problems = follow_problems(["running", "running", "running", "stopped"], "")
    assert any("the row went" in p for p in problems)
    assert any("does not say why" in p for p in problems)


def test_grade_activity_in_order_passes():
    lines = ["2:21 Stopped", "2:20 Stopping", "2:19 Not reachable Its agent…", "2:18 Running"]
    assert activity_problems(lines + ["2:17 Starting"]) == []


def test_grade_activity_out_of_order_fails():
    lines = ["2:21 Not reachable", "2:20 Stopped", "2:19 Stopping", "2:18 Running"]
    assert activity_problems(lines)


def test_grade_activity_missing_a_state_fails():
    assert activity_problems(["2:21 Stopped", "2:18 Running"]) == [
        "Activity misses 'Not reachable' after ['Running']: ['2:21 Stopped', '2:18 Running']"
    ]


def test_grade_tunnel_followed_to_stopped_or_running_passes():
    assert tunnel_follow_problems(["connected", "notReachable", "disconnected"], WHY) == []
    assert tunnel_follow_problems(["connected", "notReachable", "connected"], WHY) == []


def test_grade_tunnel_still_running_while_gone_fails():
    problems = tunnel_follow_problems(["connected", "connected", "connected"], WHY)
    assert problems == [
        "the tunnel went ['connected', 'connected'], expected ['connected', 'notReachable']"
    ]


def test_grade_tunnel_stuck_after_reconnect_fails():
    problems = tunnel_follow_problems(["connected", "notReachable", "notReachable"], "")
    assert "after the reconnect the tunnel reads 'notReachable', not stopped or running" in problems
    assert any("does not say why" in p for p in problems)


GOOD_LISTENERS = {"server": {"agent": True, "app": False}, "tunnel": {"agent": True, "app": False}}


def test_grade_auto_start_waits_then_runs_on_the_agent_passes():
    waiting = {"server": "waiting", "tunnel": "waiting"}
    running = {"server": "running", "tunnel": "connected"}
    assert auto_start_problems(waiting, running, GOOD_LISTENERS) == []


def test_grade_auto_start_that_fails_or_runs_here_fails():
    waiting = {"server": "error", "tunnel": "waiting"}
    running = {"server": "running", "tunnel": "waiting"}
    listeners = {"server": {"agent": False, "app": True}, "tunnel": {"agent": True, "app": False}}
    assert auto_start_problems(waiting, running, listeners) == [
        "server reads 'error' before its agent connects, not 'waiting'",
        "tunnel reads 'waiting' once its agent is connected",
        "this computer's app listens on server's port",
        "the agent does not listen on server's port",
    ]


def listening_ports(pids: list[int]) -> set[int]:
    """The TCP ports the processes ``pids`` listen on (own processes only)."""
    ports: set[int] = set()
    for pid in pids:
        try:
            conns = psutil.Process(pid).net_connections(kind="tcp")
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
        ports |= {c.laddr.port for c in conns if c.status == psutil.CONN_LISTEN}
    return ports


def agent_pids(root: Path) -> list[int]:
    """The processes whose executable lives under ``root``: this run's agent."""
    root_s = str(root.resolve())
    return [
        p.pid
        for p in psutil.process_iter(["exe"])
        if (p.info.get("exe") or "") and os.path.realpath(p.info["exe"]).startswith(root_s + os.sep)
    ]


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's sshd is POSIX-only")
class TestProductRunServicesFollowAgent(
    ProductRunUi,
    AgentDeployUi,
    SshPhaseUi,
    AgentUi,
    EmbeddedServicesUi,
    TabsUi,
    SettingsUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SystemTest,
):
    phase = "Services follow their agent"
    request_timeout = 90.0

    name = unique_name("pr-services-agent")
    state: dict[str, Any] = {}

    @pytest.fixture(autouse=True)
    def _reap_on_exit(self, request):
        native = self.hosts.native
        if native is not None and native.session_home and not self.state.get("reaper"):
            self.state["reaper"] = True
            request.config.add_cleanup(
                lambda: reap_agents_under(native.session_home / INSTALL_DIR)
            )
        yield

    def _status(self, server_id: str, want: str) -> str | None:
        return want if self.server_status(server_id) == want else None

    def _tunnel_status(self, tunnel_id: str) -> str | None:
        states = self.driver.get_state("tunnelStates") or {}
        return (states.get(tunnel_id) or {}).get("status")

    def _tunnel_is(self, tunnel_id: str, *wanted: str) -> str | None:
        status = self._tunnel_status(tunnel_id)
        return status if status in wanted else None

    def _ssh_connection(self) -> str:
        """An SSH connection to the run's sshd, for tunnels hosted on the agent."""
        if "ssh" not in self.state:
            native = self.need_native()
            name = unique_name("pr-follow-ssh")
            self.switch_to_connections_sidebar()
            self.create_ssh_connection(
                name, host=SSH_HOST, port=native.target.port, username=native.target.username,
                auth_method="key", key_path=str(native.client_key), connect=False,
            )
            self.wait(lambda: self.find_connection(name), what="the SSH connection")
            self.state["ssh"] = name
        return self.state["ssh"]

    def _agent(self) -> dict[str, Any]:
        """The run's agent, deployed and connected once for every step."""
        if "agent" not in self.state:
            self.state["agent"] = self.deploy_and_connect_agent(self.name, install_dir=INSTALL_DIR)
        agent = self.state["agent"]
        if self.agent_connection_state(self.name) != "connected":
            self.switch_to_connections_sidebar()
            self.connect_agent(self.name)
            self.wait_agent_connected(self.name, timeout=90.0)
        return agent

    def _tunnel_on_agent(self, agent_id: str, *, auto_start: bool = False) -> tuple[str, int]:
        """Save a local tunnel hosted on the agent; return its id and port."""
        native = self.need_native()
        connection = self._ssh_connection()
        name = unique_name("pr-follow-tunnel")
        port = self.free_port()
        self.open_services_sidebar()
        self.choose_new_service("tunnel-local")
        self.wait(lambda: self.driver.exists("tunnel-editor-name"), what="the tunnel editor")
        self.driver.type("tunnel-editor-name", name)
        self.driver.select("tunnel-editor-ssh-connection", connection)
        self.driver.select("tunnel-editor-host", f"agent:{agent_id}")
        self.driver.type("tunnel-editor-remote-host", "127.0.0.1")
        self.driver.type("tunnel-editor-remote-port", str(native.target.port))
        self.driver.type("tunnel-editor-local-port", str(port))
        if auto_start:
            self.driver.click("tunnel-editor-auto-start")
        self.driver.click("tunnel-editor-save")
        tunnel = self.wait(
            lambda: next(
                (t for t in self.driver.get_state("tunnels") or [] if t.get("name") == name),
                None,
            ),
            what="the tunnel",
        )
        return tunnel["id"], port

    def _server_on_agent(self, agent_id: str, *, auto_start: bool = False) -> tuple[str, int]:
        """Save a file server hosted on the agent; return its id and port."""
        root = tempfile.mkdtemp(prefix="pr-follow-")
        name = unique_name("pr-agent-files")
        port = self.free_port()
        self.open_new_editor("http")
        self.fill_editor(name, root=root, port=port)
        self.driver.select("server-dialog-runloc", f"agent:{agent_id}")
        if auto_start:
            self.driver.click("server-dialog-autostart")
        self.driver.click(self.DIALOG_SAVE)
        return self.require_server(name)["id"], port

    def test_10_killed_and_restarted(self):
        with self.step(
            "services.follow-agent",
            "A file server on an agent whose process is killed reads 'Not reachable' with "
            "why; Stop then reads 'Stopping' and, once the agent is back, 'Stopped'. Its "
            "Activity lists those states in order (#6053, #6028 slice 9)",
            expect="the row 'Not reachable' with 'Its agent is offline…', then 'Stopping', "
            "then 'Stopped'; the server's Activity tab with Stopped, Stopping, Not reachable "
            "and Running, newest first",
        ):
            native = self.need_native()
            agent = self._agent()
            server_id, _ = self._server_on_agent(agent["id"])
            self.start_server(server_id)
            states = ["running"]

            stopped = reap_agents_under(native.session_home / INSTALL_DIR)
            self.evidence(f"killed agent processes {stopped}")
            states.append(
                self.wait(lambda: self._status(server_id, "notReachable"), timeout=60.0,
                          what="the row to read Not reachable")
            )
            reason = self.driver.get_text(f"server-reason-{server_id}").strip()
            self.shot(label="not-reachable")

            self.driver.click(f"server-stop-{server_id}")
            states.append(
                self.wait(lambda: self._status(server_id, "stopping"), timeout=30.0,
                          what="the row to read Stopping")
            )
            self.shot(label="stopping")

            self.switch_to_connections_sidebar()
            self.connect_agent(self.name)
            self.wait_agent_connected(self.name, timeout=90.0)
            self.open_services_sidebar()
            states.append(
                self.wait(lambda: self._status(server_id, "stopped"), timeout=60.0,
                          what="the row to read Stopped after the reconnect")
            )
            self.shot(label="stopped")

            self.open_server_activity(server_id)
            lines = self.wait(
                lambda: (lambda e: e if e and "Stopped" in e[0] else None)(
                    self.activity_events()
                ),
                timeout=15.0,
                what="Activity to show the stop",
            )
            self.shot(label="activity")
            self.evidence(f"states {states}; reason {reason!r}; activity {lines}")
            problems = follow_problems(states, reason) + activity_problems(lines)
            assert not problems, problems

    def test_20_tunnel_killed_and_restarted(self):
        with self.step(
            "services.follow-agent-tunnel",
            "A tunnel on an agent whose process is killed reads 'Not reachable' with why; "
            "once the agent is back it follows what the agent says: stopped for an agent "
            "started over SSH, running for one that kept it (#6053)",
            expect="the tunnel row 'Not reachable' with 'Its agent is offline…', then "
            "'Stopped' (or 'Running') after the agent is connected again",
        ):
            native = self.need_native()
            agent = self._agent()
            tunnel_id, _ = self._tunnel_on_agent(agent["id"])
            self.driver.click(f"tunnel-start-{tunnel_id}")
            self.accept_all_hostkeys(timeout=15.0)
            states = [
                self.wait(lambda: self._tunnel_is(tunnel_id, "connected"), timeout=60.0,
                          what="the tunnel to run on the agent")
            ]
            self.shot(label="tunnel-running")
            stopped = reap_agents_under(native.session_home / INSTALL_DIR)
            self.evidence(f"killed agent processes {stopped}")
            states.append(
                self.wait(lambda: self._tunnel_is(tunnel_id, "notReachable"), timeout=60.0,
                          what="the tunnel to read Not reachable")
            )
            reason = self.driver.get_text(f"tunnel-reason-{tunnel_id}").strip()
            self.shot(label="tunnel-not-reachable")
            self.switch_to_connections_sidebar()
            self.connect_agent(self.name)
            self.wait_agent_connected(self.name, timeout=90.0)
            self.open_services_sidebar()
            states.append(
                self.wait(lambda: self._tunnel_is(tunnel_id, *TUNNEL_AFTER), timeout=60.0,
                          what="the tunnel to follow its agent")
            )
            self.shot(label="tunnel-followed")
            self.evidence(f"states {states}; reason {reason!r}")
            problems = tunnel_follow_problems(states, reason)
            assert not problems, problems
            if states[-1] == "connected":
                self.driver.click(f"tunnel-stop-{tunnel_id}")

    def test_30_auto_start_before_the_agent(self):
        with self.step(
            "services.follow-agent-auto-start",
            "A file server and a tunnel on an agent that start with the app read 'Waiting' "
            "while the agent is not connected and 'Running' once it is; what listens on "
            "their ports is the agent, not this computer's app (#6053)",
            expect="after the app restarts with the agent gone: both rows 'Waiting' with "
            "'Starts when its agent connects…'; after connecting the agent: both 'Running'",
        ):
            native = self.need_native()
            agent = self._agent()
            server_id, server_port = self._server_on_agent(agent["id"], auto_start=True)
            tunnel_id, tunnel_port = self._tunnel_on_agent(agent["id"], auto_start=True)
            install = native.session_home / INSTALL_DIR

            # The app starts again while the agent is gone: the auto-starts wait.
            self.restart_app(lambda: reap_agents_under(install))
            self.open_services_sidebar()
            waiting = {
                "server": self.wait(lambda: self._status(server_id, "waiting"), timeout=60.0,
                                    what="the server to wait for its agent"),
                "tunnel": self.wait(lambda: self._tunnel_is(tunnel_id, "waiting"), timeout=60.0,
                                    what="the tunnel to wait for its agent"),
            }
            self.shot(label="auto-start-waiting")

            self.switch_to_connections_sidebar()
            self.connect_agent(self.name)
            self.accept_all_hostkeys(timeout=15.0)
            self.wait_agent_connected(self.name, timeout=90.0)
            self.open_services_sidebar()
            running = {
                "server": self.wait(lambda: self._status(server_id, "running"), timeout=60.0,
                                    what="the server to run on its agent"),
                "tunnel": self.wait(lambda: self._tunnel_is(tunnel_id, "connected"),
                                    timeout=60.0, what="the tunnel to run on its agent"),
            }
            self.shot(label="auto-start-running")
            agent_ports = listening_ports(agent_pids(install))
            app_ports = listening_ports([self.app.pid] if self.app.pid else [])
            listeners = {
                service: {"agent": port in agent_ports, "app": port in app_ports}
                for service, port in (("server", server_port), ("tunnel", tunnel_port))
            }
            self.evidence(f"waiting {waiting}; running {running}; listeners {listeners}")
            problems = auto_start_problems(waiting, running, listeners)
            assert not problems, problems
            self.stop_server(server_id)
            self.driver.click(f"tunnel-stop-{tunnel_id}")

    def test_90_tidy_up(self):
        self.close_all_tabs()
        try:
            self.open_services_sidebar()
            self.cleanup_all_servers()
            # Auto-start tunnels must not wait for this agent in a later phase.
            for tunnel in self.driver.get_state("tunnels") or []:
                if tunnel.get("name", "").startswith("pr-follow-tunnel"):
                    self.driver.context_menu(f"tunnel-item-{tunnel['id']}")
                    self.driver.click(f"tunnel-ctx-delete-{tunnel['id']}")
                    self._confirm_delete()
            self.switch_to_connections_sidebar()
            if self.agent_connection_state(self.name) == "connected":
                self.disconnect_agent(self.name)
        except Exception:  # noqa: BLE001 - best-effort tidy-up; the reaper stops the agent
            pass
