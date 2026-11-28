"""Product run: one run picker and one running-automation badge (#5818, slice 5).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). Since slice 5 one run picker replaces
the macro Play dialog and the workflow "Run on…" dialog, a run on several
terminals is one independent run per terminal, and one "running automation"
badge marks every tab an automation is typing into.

Steps: two local-shell terminals; a macro that echoes ``$HOME`` run on both
from the macro row's "Run on…" (pick both, confirm the named list), both
terminals showing the expanded ``$HOME`` line; a workflow with a wait run on
both, each tab badged while it runs, one stopped from its badge while the
other completes; the picker reopening on the last choice.

The ``test_grade_*`` functions grade fixed values without an app and run in
the normal lane.
"""

from __future__ import annotations

import sys

import pytest

from termihub_harness import (
    ConnectionsUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    WorkflowUi,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.automation_steps import RUN_TARGETS, AutomationPhaseUi
from termihub_harness.product_run.run_picker import (
    badge_problems,
    home_line,
    stopped_one_problems,
    typed_on_problems,
)
from termihub_harness.product_run.ssh_steps import SshPhaseUi

#: How long the workflow's wait step holds each run, so the badges can be read.
WAIT_MS = 6000


# ── app-free grade tests ──────────────────────────────────────────────────
def test_grade_home_line_needs_an_expanded_home():
    assert home_line("$ echo M $HOME\nM /home/pr\n$ ", "M") == "M /home/pr"
    assert home_line("M C:\\Users\\pr", "M") == "M C:\\Users\\pr"
    # The literal (unexpanded) variable or another marker does not count.
    assert home_line("M $HOME", "M") == ""
    assert home_line("MX /home/pr", "M") == ""


def test_grade_typed_on_both_terminals():
    texts = {"a": "M /home/a", "b": "M /home/b"}
    assert typed_on_problems(texts, "M") == []
    assert typed_on_problems({**texts, "b": "$ echo M $HOME"}, "M") == [
        "tab b shows no 'M $HOME' line"
    ]


def test_grade_badges_match_the_running_tabs():
    assert badge_problems(["a", "b"], ["b", "a"]) == []
    assert badge_problems(["a", "c"], ["a", "b"]) == [
        "tab b has no running-automation badge",
        "tab c has a badge but runs nothing",
    ]


def test_grade_stopping_one_badge_stops_only_that_run():
    runs = [
        {"tabId": "a", "status": "completed", "startedAt": "2026-11-24T10:00:00Z"},
        {"tabId": "a", "status": "cancelled", "startedAt": "2026-11-24T10:05:00Z"},
        {"tabId": "b", "status": "completed", "startedAt": "2026-11-24T10:05:00Z"},
    ]
    assert stopped_one_problems(runs, "a", "b") == []
    assert stopped_one_problems(runs, "b", "a") == [
        "the run on tab b ended 'completed', not 'cancelled'",
        "the run on tab a ended 'cancelled', not 'completed'",
    ]
    assert stopped_one_problems([], "a", "b") == [
        "no run recorded on tab a",
        "no run recorded on tab b",
    ]


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the grade echoes a POSIX $HOME")
class TestProductRunAutomationRunPicker(
    ProductRunUi,
    SshPhaseUi,
    AutomationPhaseUi,
    WorkflowUi,
    SettingsUi,
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    SystemTest,
):
    phase = "Automation run picker"
    request_timeout = 60.0

    tag = unique_name("pr").split("-")[-1]
    ids: dict[str, str] = {}
    tabs: list[str] = []

    def _badged(self) -> list[str]:
        """The tabs that carry the running-automation badge right now."""
        return [t for t in self.tabs if self.driver.exists(f"tab-automation-badge-{t}")]

    def test_00_terminals(self):
        with self.step(
            "automation-run-picker.terminals",
            "Two local-shell terminals to run on",
            expect="two local-shell terminal tabs, both at a prompt",
        ):
            for n in (1, 2):
                name = f"pr-pick-{n}-{self.tag}"
                self.switch_to_connections_sidebar()
                self.create_local_connection(name, connect=True)
                tab = self.tab_id_of(name)
                self.wait_connected(tab)
                self.tabs.append(tab)
            self.evidence(f"tabs {self.tabs}")

    def test_10_macro_on_two_terminals(self):
        marker = f"PR_PICK_{self.tag}"
        with self.step(
            "automation-run-picker.typed",
            "A macro run on both terminals from the run picker types into each",
            expect="the run picker's confirmation naming both terminals, then both terminals "
            f"show a '{marker} /…' line with the expanded home directory",
        ):
            self.require("automation-run-picker.terminals")
            self.ids["macro"] = self.create_macro(
                f"Pick macro {self.tag}", [f"echo {marker} $HOME\\r"]
            )
            self.run_automation_on(self.ids["macro"], self.tabs)
            self.wait(
                lambda: not typed_on_problems(
                    {t: self.driver.read_terminal(t) for t in self.tabs}, marker
                ),
                timeout=30.0,
                what="the $HOME line in both terminals",
            )
            texts = {t: self.driver.read_terminal(t) for t in self.tabs}
            self.evidence(str({t: home_line(x, marker) for t, x in texts.items()}))
            problems = typed_on_problems(texts, marker)
            assert not problems, problems
            # One record per terminal, each naming its own (#5818, slice 9).
            runs = self.wait(
                lambda: (lambda r: r if len(r) >= 2 else None)(
                    self.automation_runs(self.ids["macro"])
                ),
                what="the macro's run on each terminal in the history",
            )
            assert len(runs) == 2, runs
            assert all(r.get("targetCount") == 1 for r in runs), runs
            labels = {tuple(r.get("targetLabels") or []) for r in runs}
            assert len(labels) == 2, f"both records name the same terminal: {runs}"

    def test_20_badges_and_stop_one(self):
        t = self.tag
        with self.step(
            "automation-run-picker.badges",
            "A workflow run on both terminals badges each tab; stopping one badge stops "
            "that terminal only",
            expect="both tabs carry the violet 'Running automation' badge with n/m progress "
            "while the wait step runs",
        ):
            self.require("automation-run-picker.terminals")
            self.author_workflow(
                f"Pick workflow {t}",
                [
                    ("send-command", {"step-command": f"echo PR_PICK_START_{t}"}),
                    ("wait", {"step-delay": WAIT_MS / 1000}),
                    ("send-command", {"step-command": f"echo PR_PICK_DONE_{t}"}),
                ],
            )
            self.save_workflow()
            wid = self.ids["workflow"] = self.workflow_id(f"Pick workflow {t}")
            self.run_automation_on(wid, self.tabs)
            self.wait(
                lambda: not badge_problems(self._badged(), self.tabs), what="a badge on both tabs"
            )
            labels = {
                tab: self.driver.get_attribute(f"tab-automation-badge-{tab}", "aria-label")
                for tab in self.tabs
            }
            self.evidence(str(labels))
            self.shot(label="badges")
            for label in labels.values():
                # The badge quotes the name typographically (“…”).
                assert label and label.replace("“", '"').startswith(
                    'Running automation "Pick workflow'
                ), labels

            stopped, other = self.tabs
            self.driver.click(f"tab-automation-badge-{stopped}")
            self.wait(
                lambda: not self.driver.exists(f"tab-automation-badge-{stopped}"),
                what="the stopped tab's badge to clear",
            )
            self.wait(
                lambda: not stopped_one_problems(self.automation_runs(wid), stopped, other),
                timeout=WAIT_MS / 1000 + 30.0,
                what="one canceled and one completed run",
            )
            problems = stopped_one_problems(self.automation_runs(wid), stopped, other)
            self.wait(lambda: not self._badged(), what="every badge to clear")
            done = f"PR_PICK_DONE_{t}"
            assert done in self.driver.read_terminal(other), "the other terminal did not finish"
            assert done not in self.driver.read_terminal(stopped), "the stopped one went on"
            self.evidence(f"problems {problems}")
            assert not problems, problems

    def test_30_remembers_last_choice(self):
        with self.step(
            "automation-run-picker.remembered",
            "The run picker opens on the last choice made",
            expect="the run picker with 'Pick terminals…' selected and both terminals ticked, "
            "each with a green live dot",
        ):
            self.require("automation-run-picker.badges")
            self.show_automations()
            self.automation_menu(self.ids['workflow'], "run-on")
            self.wait(lambda: self.driver.exists(RUN_TARGETS), what="the run picker")
            checked = self.driver.get_attribute("run-targets-target-pick", "data-state")
            ticked = [
                tab
                for tab in self.tabs
                if self.driver.get_attribute(f"run-targets-terminal-{tab}", "data-state")
                == "checked"
            ]
            self.shot(label="remembered")
            self.evidence(f"pick {checked}, ticked {ticked}")
            self.driver.click("run-targets-cancel")
            self.wait(lambda: not self.driver.exists(RUN_TARGETS), what="the picker to close")
            assert checked == "checked", checked
            assert ticked == self.tabs, ticked
            self.close_all_tabs()
            self.switch_to_connections_sidebar()
