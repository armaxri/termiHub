"""Product run: agent rows give the name the width and name their next step (#5851).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261123T215628Z`` saw agent names cut short by a text "Connect" button
(R-015, R-047), a description indented unlike connection descriptions
(R-047), a connected agent's four bare icons over "No sessions. Right-click to
create one." (R-013), the Remote agents section left collapsed after saving a
new agent (R-081), and a red error triangle with focus on Close for the
routine "agent not installed yet" first run (R-094, R-095).

The grade, against the run's native sshd:

1. a fresh agent with a long name and a description: the name shows in full,
   every action beside it is an icon, the description starts under the name;
2. with Remote agents collapsed, saving a new agent expands the section and
   shows the agent's row;
3. connecting an agent whose host has no agent yet: the dialog names the host,
   shows an info icon and Enter runs Set up agent; the row stays neutral
   ("Agent not installed", Set up agent), its empty line names the host;
4. a connected agent with nothing saved: "+" and one "…" menu (New folder,
   Disconnect, Shutdown in it), and "No connections yet. New connection".

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
    unique_name,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.agent_deploy import AgentDeployUi, reap_agents_under
from termihub_harness.product_run.agent_rows import (
    connected_actions_problems,
    empty_state_problems,
    not_installed_dialog_problems,
    not_installed_row_problems,
    read_agent_row,
    row_width_problems,
)
from termihub_harness.product_run.ssh_steps import SshPhaseUi

REMOTE_AGENTS_TOGGLE = "connection-list-remote-agents-toggle"
INSTALL_DIR = "agent-rows-agent"


# ── app-free grade tests ──────────────────────────────────────────────────
def _box(x: float, width: float, *, scroll: float | None = None, text: str = "") -> dict[str, Any]:
    return {
        "rect": {"x": x, "y": 4.0, "width": width, "height": 18.0},
        "scrollWidth": scroll if scroll is not None else width,
        "clientWidth": width,
        "text": text,
    }


def _button(label: str, text: str = "") -> dict[str, Any]:
    return {"label": label, "text": text, "visible": True}


NAME = "sys-pr-agent-5d5f-rows"


def _row(**over: Any) -> dict[str, Any]:
    r = {
        "name": _box(40.0, 150.0, text=NAME),
        "description": None,
        "buttons": [_button("Connect")],
        "dot_class": "status-dot status-dot--disabled",
        "dot_label": "Not connected",
        "empty_text": "Not connected.",
        "has_reconnect": False,
        "has_setup": False,
        "has_more": False,
    }
    r.update(over)
    return r


def test_grade_full_name_and_icon_actions_pass():
    assert row_width_problems(_row(), NAME) == []
    described = _row(description=_box(40.0, 120.0, text="Lab bench"))
    assert row_width_problems(described, NAME) == []


def test_grade_text_button_cutting_the_name_fails():
    # The R-015 shape: a worded "Connect" takes a third of the row, the name ellipsizes.
    old = _row(name=_box(40.0, 90.0, scroll=150.0, text=NAME),
               buttons=[_button("Connect", "Connect")])
    problems = row_width_problems(old, NAME)
    assert any("cut short" in p for p in problems)
    assert any("text buttons" in p for p in problems)


def test_grade_too_many_icons_and_misaligned_description_fail():
    # R-013 / R-047: four bare icons, and a description indented by a guess.
    crowded = _row(
        buttons=[_button(x) for x in ("New folder", "New connection", "Disconnect", "Shutdown")],
        description=_box(52.0, 120.0, text="Lab bench"),
    )
    problems = row_width_problems(crowded, NAME)
    assert any("4 buttons" in p for p in problems)
    assert any("description starts +12px" in p for p in problems)


def test_grade_empty_states():
    assert empty_state_problems("No connections yet. New connection", state="connected") == []
    old = empty_state_problems("No sessions. Right-click to create one.", state="connected")
    assert any("right-click" in p for p in old)
    assert any("'New connection' link" in p for p in old)
    ok = "The agent is not installed on build-01 yet. Set up agent"
    assert empty_state_problems(ok, state="not-installed", host="build-01") == []
    vague = empty_state_problems("Not installed. Set up agent", state="not-installed",
                                 host="build-01")
    assert any("name the host" in p for p in vague)
    assert empty_state_problems(None, state="disconnected") != []
    # #5980: one connect affordance, the row's action; no second link.
    assert empty_state_problems("Not connected.", state="disconnected") == []
    assert empty_state_problems("Not connected. Connect", state="disconnected") != []


def test_grade_not_installed_row():
    neutral = _row(dot_label="Agent not installed", has_setup=True)
    assert not_installed_row_problems(neutral) == []
    # The R-095 shape: red dot + Reconnect for an expected first run.
    red = _row(dot_class="status-dot status-dot--disconnected", dot_label="Connection failed",
               has_reconnect=True)
    problems = not_installed_row_problems(red)
    assert any("red" in p for p in problems)
    assert any("Reconnect" in p for p in problems)
    assert any("no 'Set up agent'" in p for p in problems)


def test_grade_not_installed_dialog():
    good = {"title": "Agent not installed on build-01", "icon": "info", "primary": "Set up agent"}
    assert not_installed_dialog_problems(good, host="build-01", enter_opens_setup=True) == []
    # R-094 / R-095: no host, a red triangle, focus on Close.
    old = {"title": "Agent not installed", "icon": "alert", "primary": "Set up agent"}
    problems = not_installed_dialog_problems(old, host="build-01", enter_opens_setup=False)
    assert any("name the host" in p for p in problems)
    assert any("info" in p for p in problems)
    assert any("does not start on" in p for p in problems)


def test_grade_connected_actions():
    row = _row(buttons=[_button("New connection"), _button(f"More actions for {NAME}")])
    entries = ["New folder", "Refresh sessions", "Disconnect (detach)", "Shutdown (stop remote)"]
    assert connected_actions_problems(row, entries) == []
    four = _row(buttons=[_button(x) for x in
                         ("New folder", "New connection", "Disconnect (detach)", "Shutdown")])
    problems = connected_actions_problems(four, [])
    assert any("no '…' menu" in p for p in problems)
    assert any("bare icons" in p for p in problems)
    assert any("lacks 'Disconnect (detach)'" in p for p in problems)


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's sshd is POSIX-only")
class TestProductRunAgentRows(
    ProductRunUi,
    AgentDeployUi,
    SshPhaseUi,
    AgentUi,
    SettingsUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SystemTest,
):
    phase = "Agent rows"
    request_timeout = 90.0

    tag = unique_name("ar").split("-")[-1]
    state: dict[str, Any] = {}

    @pytest.fixture
    def _reap_agent(self, request):
        native = self.hosts.native
        if native is not None and native.session_home:
            request.config.add_cleanup(
                lambda: reap_agents_under(native.session_home / INSTALL_DIR)
            )
        yield

    def _create(self, name: str, **kw: Any) -> dict[str, Any]:
        native = self.need_native()
        return self.create_remote_agent(
            name, host=SSH_HOST, port=native.target.port,
            username=native.target.username, auth_method="key", **kw,
        )

    def _expand(self, agent_id: str) -> None:
        """Expand the (content-free) agent until its empty line shows."""
        empty = f"agent-empty-{agent_id}"
        if not self.driver.exists(empty):
            self.driver.click(f"agent-name-{agent_id}")  # the row's toggle
        self.wait(lambda: self.driver.exists(empty), what="the agent's empty line")

    def test_10_name_gets_the_width(self):
        with self.step(
            "agent-rows.name-width",
            "A fresh agent's long name shows in full; Connect is an icon; the description "
            "starts under the name (#5851, R-015, R-047)",
            expect="#5851: Remote agents: the 'sys-pr-agent-…-long-name' row shows the whole "
            "name, a grey dot and a play icon at the end; 'Lab bench' muted directly under "
            "the name's first letter",
        ):
            name = f"sys-pr-agent-{self.tag}-long-name"
            agent = self._create(name, description="Lab bench")
            self.state["fresh"] = agent["id"]
            self.wait(lambda: self.driver.exists(f"agent-name-{agent['id']}"), what="the row")
            row = read_agent_row(self.driver, agent["id"])
            self.evidence(f"name {row['name']}, description {row['description']}, "
                          f"buttons {row['buttons']}")
            self.shot(label=None)
            problems = row_width_problems(row, name)
            assert not problems, "; ".join(problems)

    def test_20_save_reveals_the_agent(self):
        with self.step(
            "agent-rows.reveal",
            "Saving a new agent expands a collapsed Remote agents and shows its row "
            "(#5851, R-081)",
            expect="#5851: Remote agents expanded right after Save, the new 'Reveal agent …' "
            "row visible in the sidebar",
        ):
            self.open_agents_sidebar()
            if self.driver.get_attribute(REMOTE_AGENTS_TOGGLE, "aria-expanded") == "true":
                self.driver.click(REMOTE_AGENTS_TOGGLE)
            self.wait(
                lambda: self.driver.get_attribute(REMOTE_AGENTS_TOGGLE, "aria-expanded")
                == "false",
                what="Remote agents to collapse",
            )
            agent = self._create(f"Reveal agent {self.tag}")
            node = f"agent-node-{agent['id']}"
            shown = self.wait(
                lambda: self.driver.exists(node)
                and self.driver.measure_element(node)["rect"]["height"] > 0,
                timeout=10.0, what="the new agent's row",
            )
            expanded = self.driver.get_attribute(REMOTE_AGENTS_TOGGLE, "aria-expanded")
            self.evidence(f"Remote agents aria-expanded={expanded!r}; row shown {bool(shown)}")
            self.shot(label=None)
            assert expanded == "true", "Remote agents stayed collapsed after saving an agent"

    def test_30_not_installed_is_a_next_step(self):
        with self.step(
            "agent-rows.not-installed",
            "An agent whose host has no agent yet: a neutral row with Set up agent and no "
            "dialog opened by itself; its Details opens a neutral dialog naming the host, "
            "starting on Set up agent (#5851, R-094, R-095, #6184)",
            expect="#5851: the dialog 'Agent not installed on 127.0.0.1' (opened from the "
            "row's Details) with a blue info icon (no red triangle) and Set up agent focused; "
            "then the row with a grey dot, an upload icon and 'The agent is not installed on "
            "… yet. Set up agent'",
        ):
            native = self.need_native()
            name = f"Missing agent {self.tag}"
            agent = self._create(name)
            # A path with no agent behind it, whatever an earlier phase installed.
            missing = native.session_home / "agent-rows-missing" / "termihub-agent"
            self.set_agent_path(agent["id"], str(missing))
            self.connect_agent(name)
            self.wait_connect_failure(name)
            # #6184: the row says it; no dialog opens by itself.
            auto_opened = self.connection_error_present()
            title = self.open_connect_failure_details(name)
            dialog = {
                "title": title.strip(),
                "icon": self.driver.get_attribute("connection-error-icon", "data-icon"),
                "primary": (self.driver.get_text(self.ERROR_SETUP_AGENT).strip()
                            if self.driver.exists(self.ERROR_SETUP_AGENT) else None),
            }
            self.shot(label="dialog")
            # Enter on the initial focus: Set up agent opens the wizard, Close would not.
            self.driver.press_key("Enter")
            opened = bool(self.wait(lambda: self.driver.exists(self.SETUP_CANCEL),
                                    timeout=10.0, what="the setup wizard"))
            self.evidence(f"dialog {dialog}; Enter opened setup: {opened}")
            if opened:
                self.cancel_agent_setup()
            self.dismiss_connection_error_if_present()
            problems = not_installed_dialog_problems(dialog, host=SSH_HOST,
                                                     enter_opens_setup=opened)
            if auto_opened:
                problems.append("the error dialog opened by itself after the connect (#6184)")

            self._expand(agent["id"])
            row = read_agent_row(self.driver, agent["id"])
            self.evidence(f"row dot {row['dot_class']!r} {row['dot_label']!r}; "
                          f"empty {row['empty_text']!r}")
            self.shot(label="row")
            problems += not_installed_row_problems(row)
            problems += empty_state_problems(row["empty_text"], state="not-installed",
                                             host=SSH_HOST)
            assert not problems, "; ".join(problems)

    def test_40_connected_agent_actions(self, _reap_agent):
        with self.step(
            "agent-rows.connected",
            "A connected agent shows '+' and one '…' menu; with nothing saved, 'No "
            "connections yet. New connection' (#5851, R-013)",
            expect="#5851: the connected 'Rows connected …' row with a green dot, '+' and '…' "
            "at the end of the name line; under it 'No connections yet. New connection' as a "
            "link; the open '…' menu lists New folder, Refresh sessions, Running sessions, "
            "Disconnect (detach), Shutdown (stop remote)",
        ):
            agent = self.deploy_and_connect_agent(f"Rows connected {self.tag}",
                                                  install_dir=INSTALL_DIR)
            agent_id = agent["id"]
            self._expand(agent_id)
            row = read_agent_row(self.driver, agent_id)
            self.evidence(f"buttons {row['buttons']}; empty {row['empty_text']!r}")
            self.shot(label="row")
            self.driver.click(f"agent-more-{agent_id}")
            menu = f"agent-more-menu-{agent_id}"
            self.wait(lambda: self.driver.exists(menu), what="the '…' menu")
            entries = [i["text"] for i in self.driver.measure_element(menu, "text")["items"]
                       if i.get("visible", True)]
            self.evidence(f"'…' menu: {entries}")
            self.shot(label="menu")
            self.driver.press_key("Escape")
            problems = connected_actions_problems(row, entries)
            problems += empty_state_problems(row["empty_text"], state="connected")
            problems += row_width_problems(row, agent["name"])
            try:
                self.disconnect_agent(agent["name"])
            except Exception:  # noqa: BLE001 - best-effort tidy-up; the reaper stops the agent
                pass
            assert not problems, "; ".join(problems)
