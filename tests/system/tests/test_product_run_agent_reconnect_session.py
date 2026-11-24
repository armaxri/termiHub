"""Product run: an agent tab's reconnect after a user Disconnect (#5953).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261124T122947Z`` (surface agent) saw three things after the agent was
disconnected and connected again:

* R-001: "Active sessions" listed two identical "<agent> · bash" rows while
  one tab was open. A user Disconnect detaches the agent's sessions (they keep
  running on the host), and the tab's Reconnect started a second session beside
  the first instead of resuming it.
* R-002: the tab lost its earlier output and the "connection lost" marker and
  added no reconnect line.
* R-003: the update strip said "Waits for 1 session to close." above a list of
  two sessions.

Now the tab's Reconnect resumes its own session while the agent still runs
it: one session is listed, the tab shows its earlier output and a
"— reconnected hh:mm:ss — session resumed —" line (or, when a new session had
to start, the "new remote shell" line SSH uses), and the update strip counts
and names the same sessions the list shows.

The ``test_grade_*`` functions grade fixed observations without an app and run
in the normal lane.
"""

from __future__ import annotations

import re
import sys
from typing import Any

import pytest

from termihub_harness import (
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
from termihub_harness.product_run.ssh_steps import SshPhaseUi

INSTALL_DIR = "reconnect-session-agent"
BEFORE = "PR_RESUME_BEFORE"
AFTER = "PR_RESUME_AFTER"
VERSION = "99.0.0"

#: The marker after a reconnect: resumed, or a new remote shell (#5831).
RECONNECTED = re.compile(r"— reconnected \d{2}:\d{2}:\d{2} —(?P<rest>[^\r\n]*)")
RESUMED = "session resumed"
NEW_SHELL = "new remote shell; running programs were lost"
#: "Waits for 2 sessions (a, b) to close." — the update strip's note.
WAITS_FOR = re.compile(r"Waits for (?P<n>\d+) sessions? \((?P<names>.*)\) to close\.")


def reconnect_session_problems(
    *,
    session_labels: list[str],
    open_tabs: int,
    buffer: str,
    update_note: str | None,
) -> list[str]:
    """What is wrong after an agent tab's Reconnect (#5953, R-001..R-003).

    ``session_labels`` are the agent's "Active sessions" rows, ``open_tabs`` the
    agent's open terminal tabs, ``buffer`` the tab's text after the reconnect and
    an ``echo`` of :data:`AFTER`, ``update_note`` the update strip's note (None
    when no update was raised).
    """
    problems: list[str] = []
    if len(session_labels) != len(set(session_labels)):
        problems.append(f"two sessions share a name: {session_labels}")
    if len(session_labels) > open_tabs:
        problems.append(
            f"{len(session_labels)} sessions listed for {open_tabs} open tab(s): "
            f"{session_labels}"
        )

    before_at = buffer.find(BEFORE)
    marker = list(RECONNECTED.finditer(buffer))
    if before_at < 0:
        problems.append("the tab lost its output from before the disconnect")
    if not marker:
        problems.append("no '— reconnected hh:mm:ss —' line after the reconnect")
    else:
        last = marker[-1]
        rest = last.group("rest").strip()
        if RESUMED not in rest and NEW_SHELL not in rest:
            problems.append(f"the reconnect line does not say what happened ({rest!r})")
        if 0 <= before_at and last.start() < before_at:
            problems.append("the reconnect line sits above the earlier output")
        after_at = buffer.rfind(AFTER)
        if after_at >= 0 and after_at < last.start():
            problems.append("the new output sits above the reconnect line")

    if update_note is not None:
        waits = WAITS_FOR.search(update_note)
        if not session_labels:
            if waits:
                problems.append(
                    f"the update strip waits for sessions none are listed: {update_note!r}"
                )
        elif not waits:
            problems.append(f"the update strip does not name the sessions: {update_note!r}")
        else:
            if int(waits.group("n")) != len(session_labels):
                problems.append(
                    f"the update strip counts {waits.group('n')} session(s), the list shows "
                    f"{len(session_labels)}"
                )
            named = [n.strip() for n in waits.group("names").split(",")]
            if named != session_labels:
                problems.append(f"the update strip names {named}, the list shows {session_labels}")
    return problems


# ── app-free grade tests ──────────────────────────────────────────────────
GOOD_BUFFER = (
    "bash-3.2$ echo PR_RESUME_BEFORE\r\nPR_RESUME_BEFORE\r\nbash-3.2$ \r\n"
    "— reconnected 13:31:02 — session resumed —\r\n"
    "bash-3.2$ echo PR_RESUME_AFTER\r\nPR_RESUME_AFTER\r\n"
)


def _problems(**overrides: Any) -> list[str]:
    obs: dict[str, Any] = {
        "session_labels": ["box · bash"],
        "open_tabs": 1,
        "buffer": GOOD_BUFFER,
        "update_note": "Waits for 1 session (box · bash) to close.",
    }
    obs.update(overrides)
    return reconnect_session_problems(**obs)


def test_grade_resumed_session_passes():
    assert _problems() == []


def test_grade_new_shell_marker_passes():
    buffer = GOOD_BUFFER.replace("session resumed —", NEW_SHELL)
    assert _problems(buffer=buffer) == []


def test_grade_r001_two_identical_sessions_fail():
    problems = _problems(
        session_labels=["box · bash", "box · bash"],
        update_note="Waits for 2 sessions (box · bash, box · bash) to close.",
    )
    assert any("share a name" in p for p in problems)
    assert any("2 sessions listed for 1 open tab" in p for p in problems)


def test_grade_r002_lost_scrollback_fails():
    # The run-20261124 tab: only the new shell's banner, no marker.
    problems = _problems(buffer="The default interactive shell is now zsh.\r\nPR_RESUME_AFTER\r\n")
    assert "the tab lost its output from before the disconnect" in problems
    assert "no '— reconnected hh:mm:ss —' line after the reconnect" in problems


def test_grade_marker_without_a_reason_fails():
    buffer = GOOD_BUFFER.replace(" session resumed —", "")
    assert any("does not say what happened" in p for p in _problems(buffer=buffer))


def test_grade_r003_count_disagrees_with_the_list_fails():
    problems = _problems(
        session_labels=["box · bash", "box · bash 2"],
        open_tabs=2,
        update_note="Waits for 1 session to close.",
    )
    assert any("does not name the sessions" in p for p in problems)
    problems = _problems(
        session_labels=["box · bash", "box · bash 2"],
        open_tabs=2,
        update_note="Waits for 1 session (box · bash) to close.",
    )
    assert any("counts 1 session(s), the list shows 2" in p for p in problems)


def test_grade_numbered_sessions_pass():
    assert _problems(
        session_labels=["box · bash", "box · bash 2"],
        open_tabs=2,
        update_note="Waits for 2 sessions (box · bash, box · bash 2) to close.",
    ) == []


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's sshd is POSIX-only")
class TestProductRunAgentReconnectSession(
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
    phase = "Agent reconnect session"
    request_timeout = 90.0

    name = unique_name("pr-agent-resume")
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

    def _session_labels(self, agent_id: str) -> list[str]:
        """The agent's "Active sessions" rows as the sidebar labels them."""
        return [
            self.driver.get_text(f"agent-session-label-{s.get('sessionId')}").strip()
            for s in self.agent_sessions(agent_id)
        ]

    def test_10_reconnect_resumes_the_session(self):
        with self.step(
            "agent.reconnect-session",
            "After Disconnect and Connect, the agent tab's Reconnect resumes its own "
            "session: one session listed, the earlier output kept, a reconnected line, "
            "and the update strip naming the same sessions (#5953)",
            expect="the agent tab with its PR_RESUME_BEFORE output, a grey '— reconnected "
            "hh:mm:ss — session resumed —' line and PR_RESUME_AFTER below it; 'Active "
            "sessions' with one '<agent> · bash' row; the update strip 'Waits for 1 session "
            "(<agent> · bash) to close.'",
        ):
            agent = self.deploy_and_connect_agent(self.name, install_dir=INSTALL_DIR)
            agent_id = agent["id"]
            before = set(self.tab_ids())
            self.new_shell_session(self.name)
            tab = self.wait(lambda: next(iter(set(self.tab_ids()) - before), None),
                            what="the agent shell tab")
            self.evidence(self.echo_round_trip(tab, BEFORE))

            self.switch_to_connections_sidebar()
            self.disconnect_agent(self.name)
            self.wait(lambda: self.agent_connection_state(self.name) != "connected",
                      timeout=30.0, what="the agent to disconnect")
            self.connect_agent(self.name)
            self.wait_agent_connected(self.name, timeout=90.0)

            self.switch_to_tab(tab)
            if self.driver.exists("terminal-view-mode-reconnect-btn"):
                self.driver.click("terminal-view-mode-reconnect-btn")
            self.evidence(self.echo_round_trip(tab, AFTER))
            buffer = self.driver.read_terminal(tab)

            self.switch_to_connections_sidebar()
            self.announce_agent_update(agent_id, available_version=VERSION)
            self.wait_agent_update_banner(agent_id)
            note = self.driver.get_text(f"{self.UPDATE_BANNER_NOTE}-{agent_id}").strip()
            labels = self._session_labels(agent_id)
            self.shot(label="after-reconnect")
            self.evidence(f"sessions {labels}; update note {note!r}")
            self.evidence(f"tab tail: {buffer[-400:]!r}")
            problems = reconnect_session_problems(
                session_labels=labels, open_tabs=1, buffer=buffer, update_note=note
            )
            self.dismiss_agent_update_banner(agent_id)
            assert not problems, problems
        self.close_all_tabs()
        try:
            if self.agent_connection_state(self.name) == "connected":
                self.disconnect_agent(self.name)
        except Exception:  # noqa: BLE001 - best-effort tidy-up; the reaper stops the agent
            pass
