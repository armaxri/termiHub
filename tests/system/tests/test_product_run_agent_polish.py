"""Product run: round-3 agent polish (#5980).

The UI review of run ``20261124T155441Z`` (surface agent, grade 4) left five
P3s (see :mod:`termihub_harness.product_run.agent_polish`):

- the update strip offers "Later" (not "Close" beside "… to close."), says
  under "Restart agent and update" that the open sessions keep running, and
  keeps each session name on one line;
- the disconnected-agent banner announces its own visible text, "Agent
  disconnected. Press Enter to resume.", never "a new session";
- agent and setup tabs grow to their full title before truncating;
- a setup tab that exited 0 shows a "Finished" check, not the red plug, and
  the status bar drops its SSH chip;
- an expanded disconnected agent says "Not connected." with no second
  Connect beside the row's own action.

The live class is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``); the ``test_grade_*`` functions run in
the normal lane.
"""

from __future__ import annotations

import sys
from typing import Any, Optional

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
from termihub_harness.product_run.agent_deploy import AgentDeployUi, reap_agents_under
from termihub_harness.product_run.agent_polish import (
    FINISHED_DOT_CLASS,
    TAB_MAX_WIDTH,
    banner_announcement_problems,
    kept_sessions_line,
    setup_tab_icon_problems,
    tab_growth_problems,
    update_strip_problems,
)
from termihub_harness.product_run.agent_rows import empty_state_problems
from termihub_harness.product_run.ssh_steps import SshPhaseUi
from termihub_harness.product_run.tab_labels import measure_tab_label

INSTALL_DIR = "agent-polish-agent"
VERSION = "99.0.0"
BANNER = "terminal-view-mode-banner"
ANNOUNCEMENT = "terminal-view-mode-announcement"
LABEL = "terminal-view-mode-label"


# ── app-free grade tests ──────────────────────────────────────────────────
def _rect(x: float, y: float, w: float, h: float) -> dict[str, float]:
    return {"x": x, "y": y, "width": w, "height": h}


def test_grade_kept_sessions_line():
    assert kept_sessions_line(1) == "Your session keeps running."
    assert kept_sessions_line(3) == "Your 3 sessions keep running."


def test_grade_update_strip_passes():
    name = {"text": "sys-pr-agent-24ef8dc4 · bash", "rect": _rect(20, 40, 180, 17)}
    assert update_strip_problems(dismiss="Later", consequence="Your session keeps running.",
                                 open_sessions=1, name_boxes=[name]) == []
    assert update_strip_problems(dismiss="Later", consequence=None, open_sessions=0) == []


def test_grade_update_strip_of_run_20261124T155441Z_fails():
    # R-003: "Close", no consequence, the name broken at " · bash)".
    broken = {"text": "sys-pr-agent-24ef8dc4 · bash", "rect": _rect(20, 40, 200, 36)}
    problems = update_strip_problems(dismiss="Close", consequence=None, open_sessions=1,
                                     name_boxes=[broken])
    assert any("want 'Later'" in p for p in problems)
    assert any("what happens to the open sessions" in p for p in problems)
    assert any("breaks across lines" in p for p in problems)


def test_grade_update_strip_wrong_consequence_fails():
    # "Ends 1 session" would be false: an agent update waits, it never cuts a session.
    problems = update_strip_problems(dismiss="Later", consequence="Ends 1 session (bash).",
                                     open_sessions=1)
    assert problems == [
        "the line under the apply button reads 'Ends 1 session (bash).', "
        "want 'Your session keeps running.'"
    ]


def test_grade_banner_announcement():
    shown = "Agent disconnected. Press Enter to resume."
    assert banner_announcement_problems(visible=shown, announcement=shown,
                                        agent_disconnected=True) == []
    plain = "Session ended. Press Enter to reconnect."
    assert banner_announcement_problems(visible=plain, announcement=plain,
                                        agent_disconnected=False) == []


def test_grade_banner_announcement_of_run_20261124T155441Z_fails():
    # R-004: the visible and the spoken text differed, and promised a new session.
    problems = banner_announcement_problems(
        visible="Agent disconnected. Press Enter to reconnect.",
        announcement="Agent disconnected. Press Enter or click Reconnect to reconnect it and "
        "start a new session.",
        agent_disconnected=True,
    )
    assert any("but announces" in p for p in problems)
    assert any("promises a new session" in p for p in problems)
    assert any("Press Enter to resume." in p for p in problems)


def _tab(width: float, scroll: float, client: float, tooltip: Optional[str] = None) -> dict:
    title = "sys-pr-agent-24ef8dc4 · bash"
    return {
        "title": title,
        "tooltip": title if tooltip is None else tooltip,
        "tab": _rect(300, 50, width, 35),
        "head": {"text": "sys-pr-agent-24ef8dc4", "scrollWidth": scroll, "clientWidth": client},
        "tail": {"text": "· bash", "scrollWidth": 40, "clientWidth": 40},
    }


def test_grade_tab_growth():
    # Whole title shown.
    assert tab_growth_problems(_tab(250, 140, 140), strip_free=600) == []
    # Truncated, but only at the max width or in a full strip.
    assert tab_growth_problems(_tab(TAB_MAX_WIDTH, 400, 280), strip_free=600) == []
    assert tab_growth_problems(_tab(180, 140, 100), strip_free=0) == []


def test_grade_tab_growth_of_run_20261124T155441Z_fails():
    # R-001: cut at 240px with the strip right of it empty.
    problems = tab_growth_problems(_tab(240, 140, 110), strip_free=700)
    assert problems == [
        "'sys-pr-agent-24ef8dc4 · bash' is truncated at 240px with 700px of the strip free"
    ]
    wrong = tab_growth_problems(_tab(250, 140, 140, tooltip="sys-pr-agent"), strip_free=600)
    assert any("not the full title" in p for p in wrong)


def test_grade_setup_tab_icon():
    finished = f"tab__state-dot {FINISHED_DOT_CLASS}"
    assert setup_tab_icon_problems(exit_code=0, dot_class=finished, dot_label="Finished",
                                   ssh_chip=False) == []
    red = "tab__state-dot tab__state-dot--disconnected"
    assert setup_tab_icon_problems(exit_code=1, dot_class=red, dot_label="Disconnected",
                                   ssh_chip=True) == []


def test_grade_setup_tab_icon_of_run_20261124T155441Z_fails():
    # R-002: the red plug and the SSH chip after "[Process exited with code 0]".
    red = "tab__state-dot tab__state-dot--disconnected"
    problems = setup_tab_icon_problems(exit_code=0, dot_class=red, dot_label="Disconnected",
                                       ssh_chip=True)
    assert len(problems) == 3
    assert any("SSH chip" in p for p in problems)
    wrong = setup_tab_icon_problems(exit_code=2, dot_class=f"x {FINISHED_DOT_CLASS}",
                                    dot_label="Finished", ssh_chip=False)
    assert wrong == ["a setup that exited 2 shows the finished check"]


def test_grade_disconnected_row_has_one_connect():
    # R-005: the play icon and a "Connect" link for the same action.
    assert empty_state_problems("Not connected.", state="disconnected") == []
    assert empty_state_problems("Not connected. Connect", state="disconnected") != []


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's sshd is POSIX-only")
class TestProductRunAgentPolish(
    ProductRunUi,
    AgentDeployUi,
    SshPhaseUi,
    AgentUi,
    TerminalUi,
    TabsUi,
    SettingsUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SystemTest,
):
    phase = "Agent polish"
    request_timeout = 90.0

    name = unique_name("pr-agent-polish")
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

    def _strip_free(self) -> float:
        """The empty tab-strip width right of the last tab, in CSS pixels."""
        bar = self.driver.measure_element("tab-bar")["rect"]
        rights = [
            float(r["x"]) + float(r["width"])
            for r in (self.driver.measure_element(f"tab-{t}")["rect"] for t in self.tab_ids())
        ]
        return float(bar["x"]) + float(bar["width"]) - max(rights, default=float(bar["x"]))

    def _grade_tab(self, tab_id: str, title: str) -> list[str]:
        tab = measure_tab_label(self.driver, tab_id, title)
        tab["tooltip"] = self.driver.measure_element(f"tab-{tab_id}").get("title")
        free = self._strip_free()
        self.evidence(f"tab {title!r}: width {tab['tab']['width']:.0f}px, head "
                      f"{tab.get('head')}, strip free {free:.0f}px")
        return tab_growth_problems(tab, strip_free=free)

    def _grade_setup_tab(self) -> list[str]:
        """The setup tab's icon and the SSH chip, when this run opened a setup tab."""
        setup = self.find_tab(f"Setup: {self.name}")
        if setup is None:
            self.evidence("no setup tab: an agent from an earlier phase answered the connect")
            return []
        tab_id = setup["id"]
        problems = self._grade_tab(tab_id, setup.get("title") or "")
        self.switch_to_tab(tab_id)
        self.wait(lambda: self.driver.exists("agent-setup-tab-strip"), timeout=60.0,
                  what="the setup tab's finished strip")
        variant = self.driver.get_attribute("terminal-disconnect-overlay", "data-variant")
        exit_code = 0 if variant == "agent-setup-installed" else 1
        dot = f"tab-state-dot-{tab_id}"
        dot_class = self.driver.get_attribute(dot, "class") or ""
        dot_label = self.driver.get_attribute(dot, "aria-label")
        ssh_chip = self.driver.exists("status-bar-ssh")
        self.shot(label="setup-tab")
        self.evidence(f"setup tab {variant!r}: dot {dot_class!r} {dot_label!r}; "
                      f"SSH chip {ssh_chip}")
        return problems + setup_tab_icon_problems(
            exit_code=exit_code, dot_class=dot_class, dot_label=dot_label, ssh_chip=ssh_chip
        )

    def _grade_update_strip(self, agent_id: str) -> list[str]:
        self.switch_to_connections_sidebar()
        self.announce_agent_update(agent_id, available_version=VERSION)
        self.wait_agent_update_banner(agent_id)
        note_id = f"{self.UPDATE_BANNER_NOTE}-{agent_id}"
        note = self.driver.measure_element(note_id, "text")
        sessions = [
            self.driver.get_text(f"agent-session-label-{s.get('sessionId')}").strip()
            for s in self.agent_sessions(agent_id)
        ]
        names = [i for i in note.get("items", []) if (i.get("text") or "").strip() in sessions]
        line = self.driver.get_computed_style("line-height", note_id) or ""
        line_height = float(line[:-2]) if line.endswith("px") else 18.0
        consequence_id = f"agent-update-banner-consequence-{agent_id}"
        consequence = (self.driver.get_text(consequence_id)
                       if self.driver.exists(consequence_id) else None)
        dismiss = self.driver.get_text(f"{self.UPDATE_BANNER_DISMISS}-{agent_id}")
        self.shot(label="update-strip")
        self.evidence(f"note {note.get('text')!r}; names {[n.get('rect') for n in names]}; "
                      f"under apply {consequence!r}; secondary {dismiss!r}")
        problems = update_strip_problems(
            dismiss=dismiss, consequence=consequence, open_sessions=len(sessions),
            name_boxes=names, line_height=line_height,
        )
        if len(names) != len(sessions):
            problems.append(f"measured {len(names)} session names, the agent lists {sessions}")
        self.dismiss_agent_update_banner(agent_id)
        return problems

    def _grade_banner(self, tab: str) -> list[str]:
        self.switch_to_connections_sidebar()
        self.disconnect_agent(self.name)
        self.wait(lambda: self.agent_connection_state(self.name) != "connected",
                  timeout=30.0, what="the agent to disconnect")
        self.switch_to_tab(tab)
        # A user agent Disconnect puts the tab straight on the banner (#4309).
        self.wait(lambda: self.driver.exists(BANNER), timeout=20.0, what="the disconnected banner")
        # The label only: the banner's own text also holds its live region.
        visible = self.driver.get_text(LABEL).strip()
        spoken = self.wait(lambda: self.driver.get_text(ANNOUNCEMENT).strip() or None,
                           timeout=5.0, what="the banner's announcement")
        self.shot(label="banner")
        self.evidence(f"banner {visible!r}; announced {spoken!r}")
        return banner_announcement_problems(visible=visible, announcement=spoken,
                                            agent_disconnected=True)

    def _grade_fresh_row(self) -> list[str]:
        native = self.need_native()
        fresh = self.create_remote_agent(
            unique_name("pr-agent-polish-row"), host=SSH_HOST, port=native.target.port,
            username=native.target.username, auth_method="key",
        )
        agent_id = fresh["id"]
        empty = f"agent-empty-{agent_id}"
        if not self.driver.exists(empty):
            self.driver.click(f"agent-name-{agent_id}")
        self.wait(lambda: self.driver.exists(empty), what="the fresh agent's empty line")
        text = self.driver.get_text(empty).strip()
        has_action = self.driver.exists(f"agent-connect-{agent_id}")
        self.shot(label="row")
        self.evidence(f"empty line {text!r}; row Connect action {has_action}")
        problems = empty_state_problems(text, state="disconnected")
        if not has_action:
            problems.append("the disconnected agent row offers no Connect action")
        return problems

    def test_10_agent_polish(self):
        with self.step(
            "agent.polish",
            "Round-3 agent polish (#5980): tab titles shown whole, a 'Finished' check on the "
            "setup tab, 'Later' and 'Your session keeps running.' on the update strip, the "
            "banner announcing 'Press Enter to resume.', one Connect on a disconnected row",
            expect="the agent tab '<agent> · bash' and 'Setup: <agent>' untruncated with a "
            "green check on the setup tab; the update strip with Later / Restart agent and "
            "update and 'Your session keeps running.' under it; the disconnected banner "
            "'Agent disconnected. Press Enter to resume.'; a fresh agent row reading 'Not "
            "connected.' with only the row's Connect icon",
        ):
            agent = self.deploy_and_connect_agent(self.name, install_dir=INSTALL_DIR)
            agent_id = agent["id"]
            problems = self._grade_setup_tab()
            before = set(self.tab_ids())
            self.new_shell_session(self.name)
            tab = self.wait(lambda: next(iter(set(self.tab_ids()) - before), None),
                            what="the agent shell tab")
            self.switch_to_tab(tab)
            title = self.wait(
                lambda: next((t.get("title") for t in self._all_tabs() if t["id"] == tab), None),
                what="the agent tab's title",
            )
            problems += self._grade_tab(tab, title)
            self.shot(label="tabs")
            problems += self._grade_update_strip(agent_id)
            problems += self._grade_banner(tab)
            problems += self._grade_fresh_row()
            assert not problems, problems
        self.close_all_tabs()
