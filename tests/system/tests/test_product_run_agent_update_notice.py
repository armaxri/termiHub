"""Product run: the agent update notice in the narrowest sidebar (#5821).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261123T215628Z`` saw the agent's "update available" notice squeezed into
three columns inside the sidebar row: its text wrapped one word per line and
was cut off (R-001), and "Apply now" did not say what it does (R-012).

Now the row carries only a compact marker and the notice is a full-width
strip under it: "Update to v<x> available", a short note, Later and "Restart
agent and update". With session tabs open on the agent the button asks first
and names them (#5953: the sessions the agent lists); the agent does not
interrupt them, it waits for the last one to close before it restarts.

The grade deploys and connects the dev agent on the run's native sshd, shrinks
the window to its 800x600 minimum and the sidebar to its narrowest width,
raises the update through the backend's ``agent-update-available`` event (the
agent's 24 h self-update timer cannot be driven in a run) and measures the row
and the strip. It then opens a shell on the agent and checks the confirm.

The ``test_grade_*`` functions grade fixed measurements without an app and run
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
from termihub_harness.product_run.agent_update_notice import (
    APPLY_LABEL,
    agent_update_notice_problems,
    measure_agent_update_notice,
)
from termihub_harness.product_run.ssh_steps import SshPhaseUi

#: The minimum supported window.
NARROW_WINDOW = (800, 600)
#: The product run's normal window, restored afterwards.
NORMAL_WINDOW = (1280, 800)
#: ``SIDEBAR_MIN_WIDTH`` in ``src/hooks/useSidebarResize.ts``.
SIDEBAR_MIN_WIDTH = 200
SIDEBAR_HANDLE = "sidebar-resize-handle"
VERSION = "99.0.0"
INSTALL_DIR = "update-notice-agent"


# ── app-free grade tests ──────────────────────────────────────────────────
def _box(x: float, y: float, width: float, height: float) -> dict[str, float]:
    return {"x": x, "y": y, "width": width, "height": height}


def _el(rect: dict[str, float], text: str = "", *, clipped: bool = False,
        cut: bool = False) -> dict[str, Any]:
    return {
        "rect": rect,
        "text": text,
        "scrollWidth": rect["width"] + (40.0 if clipped else 0.0),
        "clientWidth": rect["width"],
        "scrollHeight": rect["height"] + (30.0 if cut else 0.0),
        "clientHeight": rect["height"],
    }


def _good() -> dict[str, Any]:
    """The #5821 layout in a 200 px sidebar: marker in the row, strip under it."""
    title = _el(_box(70, 48, 160, 34), "Update to v99.0.0 available")
    title["lineHeight"] = 17.0
    return {
        "sidebar": _box(48, 0, 200, 600),
        "row": _el(_box(48, 10, 200, 30), "pr-agent-1a2b DetachShutdown"),
        "marker": _el(_box(180, 18, 14, 14)),
        "strip": _el(_box(48, 40, 200, 110)),
        "title": title,
        "note": _el(_box(56, 86, 180, 16), "The agent restarts and reconnects."),
        "apply": _el(_box(76, 110, 164, 26), APPLY_LABEL),
    }


def _problems(m: dict[str, Any]) -> list[str]:
    return agent_update_notice_problems(m, agent_name="pr-agent-1a2b", version=VERSION)


def test_grade_marker_and_stacked_strip_pass():
    assert _problems(_good()) == []


def test_grade_one_word_per_line_fails():
    # The R-001 shape: six words on six lines in a squeezed column.
    m = _good()
    m["title"]["rect"] = _box(70, 48, 40, 102)
    assert any("wraps onto 6 lines" in p for p in _problems(m))


def test_grade_text_cut_off_fails():
    m = _good()
    m["strip"]["scrollHeight"] = 160.0
    m["note"]["rect"] = _box(56, 140, 180, 16)
    problems = _problems(m)
    assert any("cuts off" in p for p in problems)
    assert any("note runs outside" in p for p in problems)


def test_grade_prose_on_the_row_fails():
    m = _good()
    m["row"]["text"] = "pr-agent-1a2b update available (v99.0.0)"
    assert any("update prose" in p for p in _problems(m))


def test_grade_missing_or_stray_marker_fails():
    m = _good()
    m["marker"] = None
    assert "no update marker on the agent row" in _problems(m)
    m["marker"] = _el(_box(180, 60, 14, 14))
    assert any("outside the agent row" in p for p in _problems(m))


def test_grade_narrow_or_overlapping_strip_fails():
    m = _good()
    m["strip"]["rect"] = _box(100, 30, 120, 110)
    problems = _problems(m)
    assert any("120px wide" in p for p in problems)
    assert any("overlaps the agent row" in p for p in problems)


def test_grade_old_button_label_fails():
    m = _good()
    m["apply"]["text"] = "Apply now"
    assert any("'Apply now'" in p for p in _problems(m))


def test_grade_clipped_button_fails():
    m = _good()
    m["apply"]["scrollWidth"] = 220.0
    assert any("label is clipped" in p for p in _problems(m))


def test_grade_missing_strip_fails():
    m = _good()
    m["strip"] = None
    assert "no update strip under the agent row" in _problems(m)


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's sshd is POSIX-only")
class TestProductRunAgentUpdateNotice(
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
    phase = "Agent update notice"
    request_timeout = 90.0

    name = unique_name("pr-agent-update")
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

    def reset_before_rerun(self) -> None:
        self._restore_layout()

    def _narrow_layout(self) -> None:
        self.state["sidebar_width"] = self.driver.get_state("sidebarWidth")
        self.driver.resize_window(*NARROW_WINDOW)
        self.driver.press_key("Home", SIDEBAR_HANDLE)
        self.wait(
            lambda: self.driver.get_state("sidebarWidth") == SIDEBAR_MIN_WIDTH,
            what="the sidebar at its narrowest width",
        )

    def _restore_layout(self) -> None:
        self.driver.resize_window(*NORMAL_WINDOW)
        width = self.state.pop("sidebar_width", None)
        current = self.driver.get_state("sidebarWidth")
        if isinstance(width, (int, float)) and isinstance(current, (int, float)):
            self.driver.drag(SIDEBAR_HANDLE, float(width) - float(current))

    def test_10_notice_in_narrow_sidebar(self):
        with self.step(
            "agent.update-notice.narrow",
            "In the narrowest sidebar at 800x600 an agent update shows as a marker on the "
            "row and a full-width strip under it (#5821)",
            expect="the 200px sidebar: the agent row with its name and a small arrow-up "
            "marker, under it a strip reading 'Update to v99.0.0 available', a short muted "
            "note, Later and 'Restart agent and update'; no word-per-line wrapping, nothing "
            "cut off",
        ):
            agent = self.deploy_and_connect_agent(self.name, install_dir=INSTALL_DIR)
            agent_id = agent["id"]
            self.state["agent_id"] = agent_id
            self._narrow_layout()
            try:
                self.announce_agent_update(agent_id, available_version=VERSION)
                self.wait_agent_update_banner(agent_id)
                m = measure_agent_update_notice(self.driver, agent_id)
                self.shot(label="narrow-notice")
                self.evidence(
                    f"sidebar {m['sidebar']}; row {m['row']['text']!r}; strip "
                    f"{(m['strip'] or {}).get('rect')}; title "
                    f"{(m['title'] or {}).get('text')!r} {(m['title'] or {}).get('rect')}"
                )
                problems = agent_update_notice_problems(
                    m, agent_name=self.name, version=VERSION
                )
                assert not problems, problems
            finally:
                self._restore_layout()

    def test_20_apply_with_open_session_asks_first(self):
        with self.step(
            "agent.update-notice.confirm",
            "With a shell open on the agent, 'Restart agent and update' asks first and "
            "names the open session (#5821)",
            expect="a dialog 'Update \"pr-agent-update-…\"?' saying 1 session is open and is "
            "not interrupted, with Cancel and 'Update when they close'",
        ):
            self.require("agent.update-notice.narrow")
            agent_id = self.state["agent_id"]
            before = set(self.tab_ids())
            self.new_shell_session(self.name)
            self.wait(lambda: set(self.tab_ids()) - before or None, what="the agent shell tab")
            self.switch_to_connections_sidebar()
            self.wait_agent_update_banner(agent_id)
            note = self.driver.get_text(f"{self.UPDATE_BANNER_NOTE}-{agent_id}")
            self.evidence(f"note: {note!r}")
            # The strip names the session the agent lists (#5953).
            assert re.fullmatch(r"Waits for 1 session \(.+\) to close\.", note.strip()), note
            self.driver.click(f"{self.UPDATE_BANNER_APPLY}-{agent_id}")
            dialog = f"{self.UPDATE_CONFIRM}-{agent_id}"
            self.wait(lambda: self.driver.exists(dialog), what="the apply confirm")
            text = self.driver.get_text(dialog)
            self.shot(label="confirm")
            self.evidence(f"confirm: {text!r}")
            assert re.search(r"1 session \(.+\) is open on this agent", text), text
            assert "not interrupted" in text, text
            self.driver.click(f"{dialog}-cancel")
            self.wait(lambda: not self.driver.exists(dialog), what="the confirm to close")
            assert self.agent_update_banner_present(agent_id), "Cancel removed the strip"
        self.close_all_tabs()
        try:
            if self.agent_connection_state(self.name) == "connected":
                self.disconnect_agent(self.name)
        except Exception:  # noqa: BLE001 - best-effort tidy-up; the reaper stops the agent
            pass
