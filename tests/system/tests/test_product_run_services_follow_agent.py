"""Product run: services follow their agent when it is killed and restarted (#6053).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). A file server runs on the run's agent.
The agent's process is killed: the row reads "Not reachable" and says why. Stop
pressed while the agent is gone reads "Stopping"; once the agent is connected
again the row reads "Stopped". The server's Activity (#6028, slice 9) then lists
what happened in that order, newest first.

Not covered here yet: a tunnel on the agent, and an auto-start before the agent
is connected (both in #6053's scope; left open on the issue).

The ``test_grade_*`` functions grade fixed observations without an app and run
in the normal lane.
"""

from __future__ import annotations

import sys
import tempfile
from typing import Any

import pytest

from termihub_harness import (
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
            agent = self.deploy_and_connect_agent(self.name, install_dir=INSTALL_DIR)
            root = tempfile.mkdtemp(prefix="pr-follow-")
            server_name = unique_name("pr-agent-files")
            self.open_new_editor("http")
            self.fill_editor(server_name, root=root, port=self.free_port())
            self.driver.select("server-dialog-runloc", f"agent:{agent['id']}")
            self.driver.click(self.DIALOG_SAVE)
            server_id = self.require_server(server_name)["id"]
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
        self.close_all_tabs()
        try:
            self.open_services_sidebar()
            self.cleanup_all_servers()
            self.switch_to_connections_sidebar()
            if self.agent_connection_state(self.name) == "connected":
                self.disconnect_agent(self.name)
        except Exception:  # noqa: BLE001 - best-effort tidy-up; the reaper stops the agent
            pass
