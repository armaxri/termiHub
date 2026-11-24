"""Product run: round-2 UI-review polish (#5956).

The UI review of run ``20261124T122947Z`` left P3 polish on surfaces that
otherwise reached grade 4 (see
:mod:`termihub_harness.product_run.round2_polish`):

- reopen: the coalesced toast names the closed tabs (first three, then
  "+N more") and, like every undo offer, uses the neutral info style;
- ssh: the security popover shows the key's file name (full path on hover)
  under a sentence-case "Connection security" title;
- agent: tab titles keep the agent name whole and the " · <shell>" suffix
  visible; the setup summary reads "Agent v0.1.0 (develop) installed at …";
  the built-in connection is "Default shell".

The live grade here covers the reopen toast (local shells, no servers). The
SSH popover, agent tab and agent connection grades run inside their own
product-run steps (``status-bar.ssh.chip``, ``agent.shell.name``), which
import the same functions. The live class is hand-triggered only
(``scripts/internal/product-run.sh``; deselected without ``--product-run``);
the ``test_grade_*`` functions run in the normal lane.
"""

from __future__ import annotations

import sys
from typing import Any

import pytest

from termihub_harness import (
    ConnectionsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.grades import SETUP_INSTALLED_LINE
from termihub_harness.product_run.reopen_toast import expected_message
from termihub_harness.product_run.round2_polish import (
    agent_tab_label_problems,
    default_shell_name_problems,
    expected_description,
    key_file_name,
    reopen_names_problems,
    ssh_popover_problems,
    undo_toast_style_problems,
)

REOPEN_TOAST = "reopen-tab-toast"
TOAST_REGION = "toast-region"
#: More closes than the toast lists by name, so "+N more" shows.
CLOSES = 5


# ── app-free grade tests ──────────────────────────────────────────────────
def test_grade_description_lists_three_names_then_a_count():
    assert expected_description(["web"]) is None
    assert expected_description(["a", "b"]) == "a, b"
    assert expected_description(["a", "b", "c"]) == "a, b, c"
    assert expected_description(["a", "b", "c", "d", "e"]) == "a, b, c +2 more"


def test_grade_reopen_names():
    closed = ["a", "b", "c", "d"]
    assert reopen_names_problems(["Closed 4 tabs", "a, b, c +1 more", "Reopen all"], closed) == []
    # R-015: only the count, no names.
    problems = reopen_names_problems(["Closed 4 tabs", "Reopen all"], closed)
    assert problems and "a, b, c +1 more" in problems[0]
    # A single close is named in the title; no name line wanted.
    assert reopen_names_problems(["Closed “web”"], ["web"]) == []


def test_grade_undo_toast_style():
    assert undo_toast_style_problems("info") == []
    # R-016: the green success style.
    assert undo_toast_style_problems("success") == [
        "the reopen undo toast uses the 'success' style, want 'info'"
    ]


def test_grade_key_file_name():
    assert key_file_name("/Users/me/run/sshd/keys/pr_ed25519") == "pr_ed25519"
    assert key_file_name("C:\\Users\\me\\.ssh\\id_rsa") == "id_rsa"
    assert key_file_name("id_ed25519") == "id_ed25519"


def test_grade_ssh_popover_passes_sentence_case_and_file_name():
    path = "/Users/me/run/sshd/keys/pr_ed25519"
    assert ssh_popover_problems("Connection security", "none", "key pr_ed25519", path, path) == []


def test_grade_ssh_popover_of_run_20261124T122947Z_fails():
    # R-024 and the full-path row the review saw.
    path = "/Users/me/run/sshd/keys/pr_ed25519"
    problems = ssh_popover_problems("Connection security", "uppercase", f"key {path}", "", path)
    assert any("text-transform 'uppercase'" in p for p in problems)
    assert any("want 'key pr_ed25519'" in p for p in problems)
    assert any("tooltip" in p for p in problems)


def _box(text: str, scroll: float = 50.0, client: float = 50.0) -> dict[str, Any]:
    return {"text": text, "scrollWidth": scroll, "clientWidth": client}


def test_grade_agent_tab_keeps_name_and_shell():
    tab = {
        "title": "sys-pr-agent-8829f19f · bash",
        "head": _box("sys-pr-agent-8829f19f", scroll=150, client=140),
        "tail": _box(" · bash"),
    }
    assert agent_tab_label_problems(tab) == []


def test_grade_agent_tab_cut_in_the_middle_fails():
    # R-005: the old split kept 'f · bash' and ellipsized 'sys-pr-agent-8829f19'.
    tab = {
        "title": "sys-pr-agent-8829f19f · bash",
        "head": _box("sys-pr-agent-8829f19"),
        "tail": _box("f · bash"),
    }
    problems = agent_tab_label_problems(tab)
    assert any("want the name" in p for p in problems)
    assert any("want '· bash'" in p for p in problems)
    clipped = {**tab, "head": _box("sys-pr-agent-8829f19f"), "tail": _box(" · bash", 40, 20)}
    assert agent_tab_label_problems(clipped) == [
        "'sys-pr-agent-8829f19f · bash': the shell suffix '· bash' is clipped"
    ]


def test_grade_default_shell_name():
    assert default_shell_name_problems(["Default shell", "My serial"]) == []
    assert default_shell_name_problems(["Default Shell"]) == [
        "the agent's built-in connection reads 'Default Shell', want 'Default shell'"
    ]
    assert default_shell_name_problems([])[0].startswith("the agent lists no 'Default shell'")


def test_grade_setup_summary_reads_version_and_branch_flat():
    # R-006: "Agent installed (v0.1.0 (branch: develop)) at …" nested parentheses.
    tail = " installed at ~/.local/bin/termihub-agent. You can close this tab."
    assert SETUP_INSTALLED_LINE.match("Agent v0.1.0 (develop)" + tail)
    assert SETUP_INSTALLED_LINE.match("Agent v0.1.0" + tail)
    assert not SETUP_INSTALLED_LINE.match(
        "Agent installed (v0.1.0 (branch: develop)) at ~/.local/bin/termihub-agent. "
        "You can close this tab."
    )
    assert not SETUP_INSTALLED_LINE.match("Agent v0.1.0 (branch: develop)" + tail)


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the grade exits a POSIX shell")
class TestProductRunRound2Polish(
    ProductRunUi, TerminalUi, TabsUi, SidebarUi, ConnectionsUi, SystemTest
):
    phase = "Round-2 polish"
    request_timeout = 90.0

    def _toast_texts(self) -> list[str]:
        if not self.driver.exists(TOAST_REGION):
            return []
        items = self.driver.measure_element(TOAST_REGION, "text")["items"]
        return [i["text"] for i in items if i["visible"] and i["text"]]

    def _exited_tab(self, name: str) -> str:
        before = set(self.tab_ids())
        self.create_local_connection(name, connect=True)
        tab = self.wait(
            lambda: next(
                (
                    t["id"]
                    for t in self._all_tabs()
                    if t["id"] not in before and t.get("title") == name
                ),
                None,
            ),
            what=f"the {name!r} terminal",
        )
        self.switch_to_tab(tab)
        self.wait(lambda: self.driver.read_terminal(tab).strip(), what="the prompt")
        self.run_command("exit")
        self.wait(lambda: self.terminal_session_exited(tab), what=f"the {name!r} shell to exit")
        return tab

    def test_10_reopen_toast_names_and_style(self):
        with self.step(
            "round2.reopen.names",
            f"Closing {CLOSES} tabs shows one info-style toast naming the first three, "
            "then '+2 more' (#5956)",
            expect=f"a neutral (not green) toast 'Closed {CLOSES} tabs' over the line "
            "'<a>, <b>, <c> +2 more' and a 'Reopen all' button",
        ):
            self.switch_to_connections_sidebar()
            names = [unique_name("pr-polish") for _ in range(CLOSES)]
            tabs = [self._exited_tab(n) for n in names]
            self.wait(
                lambda: not any(t.startswith("Closed") for t in self._toast_texts()),
                timeout=15.0,
                what="no earlier reopen toast",
            )
            for tab in tabs:
                self.close_tab(tab)
            want = expected_message(names)
            texts = self.wait(
                lambda: (lambda t: t if want in t else None)(self._toast_texts()),
                timeout=5.0,
                what=f"the {want!r} toast",
            )
            toast_type = self.driver.get_attribute(REOPEN_TOAST, "data-type")
            self.shot()
            self.evidence(f"toast texts {texts}; data-type {toast_type!r}")
            problems = reopen_names_problems(texts, names)
            problems += undo_toast_style_problems(toast_type)
            assert not problems, problems
        self.close_all_tabs()
