"""Product run: an agent row tells the truth around a setup and a live shell (#5906, #5907).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The first UI review loop round (run
``20261124T080801Z``) saw the agent row show the red dot and "Reconnect"
while the setup terminal installed the agent and right after "Agent
installed" (R-002, R-006), and a connected agent's row say "No sessions.
Right-click to create one." beside its open shell tab (R-007).

The grade, against the run's native sshd:

1. while the setup installs the agent: the row reads "Installing…" (busy dot,
   the word beside the name, no action), never red / Reconnect;
2. once the setup reported success: the neutral "Not connected" with Connect;
3. after connecting and opening a shell on the agent: the shell is listed
   under the agent at once, no "No sessions" line.

The ``test_grade_*`` functions grade fixed readings without an app and run in
the normal lane.
"""

from __future__ import annotations

import sys
from typing import Any

import pytest

from termihub_harness import (
    SSH_HOST,
    AgentUi,
    ConnectionsUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.agent_deploy import (
    DEPLOY_TIMEOUT,
    AgentDeployUi,
    agent_binary,
    reap_agents_under,
)
from termihub_harness.product_run.agent_lifecycle_states import (
    INSTALLING,
    installed_row_problems,
    installing_row_problems,
    read_lifecycle_row,
    session_list_problems,
)
from termihub_harness.product_run.ssh_steps import SshPhaseUi

INSTALL_DIR = "agent-lifecycle-agent"


# ── app-free grade tests ──────────────────────────────────────────────────
def _row(**over: Any) -> dict[str, Any]:
    r = {
        "dot_class": "status-dot status-dot--disabled",
        "dot_label": "Not connected",
        "installing": None,
        "has_connect": True,
        "has_reconnect": False,
        "has_setup": False,
        "empty_text": None,
        "node_text": "",
    }
    r.update(over)
    return r


#: The R-002 / R-006 shape: the failure state of the connect that offered setup.
RED = _row(dot_class="status-dot status-dot--disconnected", dot_label="Connection failed",
           has_connect=False, has_reconnect=True)


def test_grade_installing_row():
    good = _row(dot_class="status-dot status-dot--connecting", dot_label=INSTALLING,
                installing=INSTALLING, has_connect=False)
    assert installing_row_problems(good) == []
    problems = installing_row_problems(RED)
    assert any("red" in p for p in problems)
    assert any("Reconnect" in p for p in problems)
    assert any(f"no {INSTALLING!r}" in p for p in problems)
    # The #5851 neutral "not installed" row is not "installing" either.
    setup = _row(dot_label="Agent not installed", has_connect=False, has_setup=True)
    assert any("Set up agent" in p for p in installing_row_problems(setup))


def test_grade_installed_row():
    assert installed_row_problems(_row()) == []
    problems = installed_row_problems(RED)
    assert any("red" in p for p in problems)
    assert any("no Connect" in p for p in problems)
    stuck = _row(dot_label=INSTALLING, installing=INSTALLING, has_connect=False)
    assert any("still shows" in p for p in installed_row_problems(stuck))
    setup = _row(dot_label="Agent not installed", has_connect=False, has_setup=True)
    assert any("Set up agent" in p for p in installed_row_problems(setup))


def test_grade_session_list():
    tab = "sys-pr-agent-25f6a537 · bash"
    listed = _row(node_text=f"sys-pr-agent-25f6a537 Active sessions {tab}")
    assert session_list_problems(listed, session_titles=[tab], tab_title=tab) == []
    # R-007: the open shell is missing and the row says there is none.
    old = _row(empty_text="No sessions. Right-click to create one.",
               node_text="sys-pr-agent-25f6a537 No sessions. Right-click to create one.")
    problems = session_list_problems(old, session_titles=[], tab_title=tab)
    assert any("while a shell on the agent is open" in p for p in problems)
    assert any("not the open shell" in p for p in problems)
    # Listed in the region but not rendered under the row.
    hidden = _row(node_text="sys-pr-agent-25f6a537")
    assert any("not shown under" in p
               for p in session_list_problems(hidden, session_titles=[tab], tab_title=tab))


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's sshd is POSIX-only")
class TestProductRunAgentLifecycleStates(
    ProductRunUi,
    AgentDeployUi,
    SshPhaseUi,
    AgentUi,
    SettingsUi,
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SystemTest,
):
    phase = "Agent lifecycle states"
    request_timeout = 90.0

    name = unique_name("sys-pr-agent-life")
    state: dict[str, Any] = {}

    @pytest.fixture(autouse=True)
    def _reap_agent(self, request):
        native = self.hosts.native
        if native is not None and native.session_home and not self.state.get("reaper"):
            self.state["reaper"] = True
            request.config.add_cleanup(
                lambda: reap_agents_under(native.session_home / INSTALL_DIR)
            )
        yield

    def _create_agent(self) -> dict[str, Any]:
        native = self.need_native()
        self.open_agents_sidebar()
        self.driver.click(self.NEW_AGENT)
        self.wait(lambda: self.driver.exists(self.EDITOR_NAME), what="the agent editor")
        self.driver.type(self.EDITOR_NAME, self.name)
        self.driver.type("field-host", SSH_HOST)
        self.driver.type("field-port", str(native.target.port))
        self.driver.type("field-username", native.target.username)
        self.driver.select("field-authMethod", "key")
        self.wait(lambda: self.driver.exists(self.KEY_PATH_INPUT), what="the key path field")
        self.driver.type(self.KEY_PATH_INPUT, str(native.client_key))
        self.driver.click(self.EDITOR_SAVE)
        agent = self.require_agent(self.name)
        # Install into this phase's own folder, so no earlier deploy answers.
        return self.set_agent_path(agent["id"], str(self._target()))

    def _target(self):
        return self.need_native().session_home / INSTALL_DIR / "termihub-agent"

    def test_10_installing_then_installed(self):
        with self.step(
            "agent-lifecycle.installing",
            "While the setup installs the agent, the row reads 'Installing…', never the "
            "failure state (#5906, R-002)",
            expect="#5906: the agent row with a busy (amber) dot and 'Installing…' beside the "
            "name, no Reconnect / Connect / Set up agent icon, the setup wizard running",
        ):
            binary = agent_binary()
            if binary is None:
                pytest.skip("no built agent (cargo build -p termihub-agent)")
            agent = self._create_agent()
            agent_id = agent["id"]
            self.state["agent_id"] = agent_id
            self.connect_agent(self.name)
            self.wait_connect_failure(self.name)
            self.click_failure_step(self.name, "setup")
            self.wait_setup_ready()
            self.driver.type(self.SETUP_REMOTE_PATH, str(self._target()))
            self.start_local_agent_setup(str(binary))
            row = read_lifecycle_row(self.driver, agent_id)
            running = self.driver.exists(self.SETUP_CANCEL_RUNNING)
            self.evidence(f"while installing (wizard running={running}): dot "
                          f"{row['dot_class']!r} {row['dot_label']!r}, marker "
                          f"{row['installing']!r}, reconnect={row['has_reconnect']}")
            self.shot(label=None)
            if not running and row["dot_label"] != INSTALLING:
                pytest.skip("the setup finished before the row could be read")
            problems = installing_row_problems(row)
            assert not problems, "; ".join(problems)

        with self.step(
            "agent-lifecycle.installed",
            "Once the setup reported success, the row is the neutral 'Not connected' with "
            "Connect (#5906, R-006)",
            expect="#5906: the setup tab ending in 'Agent installed …'; the agent row beside "
            "it with a grey dot and a play (Connect) icon, no red dot, no Reconnect",
        ):
            self.require("agent-lifecycle.installing")
            agent_id = self.state["agent_id"]
            self.wait(
                lambda: not self.driver.exists(self.SETUP_CANCEL_RUNNING)
                or self.driver.exists("agent-setup-error"),
                timeout=DEPLOY_TIMEOUT, interval=2.0, what="the deploy to finish",
            )
            if self.driver.exists("agent-setup-error"):
                raise AssertionError(f"setup error: {self.driver.get_text('agent-setup-error')}")
            last: list[str] = []

            def neutral() -> bool:
                nonlocal last
                last = installed_row_problems(read_lifecycle_row(self.driver, agent_id))
                return not last

            try:
                self.wait(neutral, timeout=15.0, interval=0.5, what="the neutral row")
            finally:
                row = read_lifecycle_row(self.driver, agent_id)
                self.evidence(f"after the setup: dot {row['dot_class']!r} "
                              f"{row['dot_label']!r}, connect={row['has_connect']}, "
                              f"reconnect={row['has_reconnect']}")
                self.shot(label=None)
            assert not last, "; ".join(last)

    def test_20_live_shell_is_listed(self):
        with self.step(
            "agent-lifecycle.session-listed",
            "A shell opened on the connected agent is listed under the agent at once "
            "(#5907, R-007)",
            expect="#5907: the agent's shell tab open; the agent row expanded with an 'Active "
            "sessions' section listing that shell, no 'No sessions' line",
        ):
            self.require("agent-lifecycle.installed")
            agent_id = self.state["agent_id"]
            self.dismiss_connection_error_if_present()
            self.connect_agent(self.name)
            self.wait_agent_connected(self.name, timeout=90.0)
            before = set(self.tab_ids())
            self.new_shell_session(self.name)
            tab = self.wait(lambda: next(iter(set(self.tab_ids()) - before), None),
                            what="the agent shell tab")
            title = next(t.get("title") or "" for t in self._all_tabs() if t["id"] == tab)
            self.evidence(self.echo_round_trip(tab, "PR_AGENT_LIFE_SHELL_OK"))
            self.switch_to_connections_sidebar()
            if not (self.find_agent(self.name) or {}).get("isExpanded"):
                self.driver.click(f"agent-name-{agent_id}")  # the row's toggle
            last: list[str] = []

            def listed() -> bool:
                nonlocal last
                titles = [s.get("title") or "" for s in self.agent_sessions(agent_id)]
                last = session_list_problems(read_lifecycle_row(self.driver, agent_id),
                                             session_titles=titles, tab_title=title)
                return not last

            try:
                self.wait(listed, timeout=10.0, interval=0.5, what="the shell under its agent")
            finally:
                titles = [s.get("title") for s in self.agent_sessions(agent_id)]
                self.evidence(f"tab {title!r}; agent sessions {titles}")
                self.shot(label=None)
            try:
                self.disconnect_agent(self.name)
            except Exception:  # noqa: BLE001 - best-effort tidy-up; the reaper stops the agent
                pass
            assert not last, "; ".join(last)
