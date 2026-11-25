"""Product run: one Automation history with unified origin labels (#5818, slice 9).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). Since slice 9 the Macros and Workflows
sidebars show one history panel: every run, macro playbacks and workflow runs
alike, newest first. A row shows the name, a status dot and the time; the run's
origin, outcome, steps and terminals open behind the row. Who started a run
reads "Run by you", "Run by hotkey", "Run by trigger", "Run by schedule" or
"Run by another automation".

Steps: a local-shell terminal; a macro and a workflow whose second step runs
that macro; the macro played from its row (one "Run by you" record) and from
the command palette (one "Run by you" record that says so), the workflow run
from its row (one record for the workflow, one "Run by another automation"
record for the macro); each new row graded at rest and opened; the history
narrowed to the macro from its row and shown in the Automations sidebar too; the
macro's history cleared after a confirmation while the workflow's run stays.

The ``test_grade_*`` functions grade fixed records without an app and run in
the normal lane.
"""

from __future__ import annotations

import sys
from typing import Any

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
from termihub_harness.product_run.automation_history import (
    ORIGIN_LABELS,
    filtered_problems,
    new_runs,
    origin_problems,
    record_problems,
    row_problems,
)
from termihub_harness.product_run.automation_steps import AutomationPhaseUi
from termihub_harness.product_run.ssh_steps import SshPhaseUi


# ── app-free grade tests ──────────────────────────────────────────────────
def _run(rid: str, automation_id: str, origin: str = "manual", **over: Any) -> dict[str, Any]:
    return {"id": rid, "automationId": automation_id, "origin": origin, **over}


def test_grade_five_unified_labels():
    assert set(ORIGIN_LABELS.values()) == {
        "Run by you",
        "Run by hotkey",
        "Run by trigger",
        "Run by schedule",
        "Run by another automation",
    }


def test_grade_new_runs_since_a_snapshot():
    stored = [_run("r3", "m"), _run("r2", "w"), _run("r1", "m")]
    assert [r["id"] for r in new_runs(stored, ["r1", "r2"])] == ["r3"]
    assert new_runs(None, []) == []


def test_grade_one_record_per_automation_with_its_origin():
    runs = [_run("r2", "w"), _run("r1", "m", "run-by-automation")]
    assert record_problems(runs, {"w": "manual", "m": "run-by-automation"}) == []


def test_grade_missing_duplicate_or_mislabeled_records_fail():
    nested_missing = [_run("r1", "w")]
    assert record_problems(nested_missing, {"w": "manual", "m": "run-by-automation"}) == [
        "0 records for m, want 1"
    ]
    twice = [_run("r1", "m"), _run("r2", "m")]
    assert record_problems(twice, {"m": "manual"}) == ["2 records for m, want 1"]
    mislabeled = [_run("r1", "m", "manual")]
    assert record_problems(mislabeled, {"m": "palette"}) == [
        "the record for m says 'manual', want 'palette'"
    ]


def test_grade_row_at_rest_shows_name_status_and_time_only():
    assert row_problems("Completed Deploy just now", "Deploy", "completed", "just now") == []
    assert row_problems("Canceled Deploy 2 min ago", "Deploy", "cancelled", "2 min ago") == []


def test_grade_row_with_settings_fails():
    problems = row_problems(
        "Completed Deploy just now 3/3 · prod-web", "Deploy", "completed", "just now"
    )
    assert any("step count" in p for p in problems)
    assert any("settings text" in p and "prod-web" in p for p in problems)
    assert any("origin" in p for p in row_problems("Deploy Run by you", "Deploy", "completed", ""))
    assert row_problems("Other just now", "Deploy", "completed", "just now")[0].startswith(
        "the row does not name"
    )


def test_grade_origin_label_when_opened():
    assert origin_problems("Run by you", "manual") == []
    assert origin_problems("Run by you · From the command palette", "palette") == []
    assert origin_problems("Run by another automation", "run-by-automation") == []
    assert origin_problems("Run by you", "palette") == ["a palette run does not say so: 'Run by you'"]
    assert origin_problems("Workflow step", "run-by-automation") == [
        "origin reads 'Workflow step', want 'Run by another automation'"
    ]
    assert origin_problems("x", "bogus") == ["unknown origin 'bogus'"]


def test_grade_filtered_list():
    runs = [_run("r1", "m"), _run("r2", "w"), _run("r3", "m")]
    assert filtered_problems(["r1", "r3"], runs, "m") == []
    assert filtered_problems(["r1", "r2"], runs, "m") == [
        "runs of other automations listed: ['r2']",
        "runs of the automation missing: ['r3']",
    ]


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunAutomationHistory(
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
    phase = "Automation history"
    request_timeout = 60.0

    tag = unique_name("pr").split("-")[-1]
    ids: dict[str, str] = {}
    runs: list[dict[str, Any]] = []

    def _all_runs(self) -> list[dict[str, Any]]:
        return self._state_list("automationRuns")

    def _await_records(self, before: list[str], expected: dict[str, str]) -> list[dict[str, Any]]:
        """Wait for exactly the ``expected`` records since ``before``; return them."""
        fresh = self.wait(
            lambda: (lambda r: r if not record_problems(r, expected) else None)(
                new_runs(self._all_runs(), before)
            ),
            what=f"one new record each for {sorted(expected)}",
        )
        self.evidence(
            "new records: " + "; ".join(f"{r['automationId']} {r.get('origin')}" for r in fresh)
        )
        return fresh

    def _played(self, marker: str, count: int) -> None:
        tab = self.ids["tab"]
        self.wait(
            lambda: self.driver.read_terminal(tab).count(marker) >= count,
            what=f"{count}x {marker} in the terminal",
        )

    def test_00_terminal(self):
        with self.step(
            "automation-history.terminal",
            "A local-shell terminal to run on",
            expect="one local-shell terminal tab at a prompt",
        ):
            name = f"pr-hist-local-{self.tag}"
            self.switch_to_connections_sidebar()
            self.create_local_connection(name, connect=True)
            self.ids["tab"] = self.tab_id_of(name)
            self.wait_connected(self.ids["tab"])
            self.evidence(self.echo_round_trip(self.ids["tab"], f"PR_HIST_{self.tag}"))

    def test_10_runs_recorded_once_each(self):
        t = self.tag
        marker = f"PR_HIST_M_{t}"
        with self.step(
            "automation-history.records",
            "A row run, a palette run and a nested run each leave one labeled record",
            expect="the terminal shows the macro's echo three times and the workflow's once",
        ):
            self.require("automation-history.terminal")
            self.ids["macro"] = self.create_macro(f"History macro {t}", [f"echo {marker}\\r"])
            self.author_workflow(
                f"History caller {t}",
                [("send-command", {"step-command": f"echo PR_HIST_W_{t}"}), ("run-automation", {})],
            )
            self.pick_automation(1, self.ids["macro"], f"History macro {t}")
            self.save_workflow()
            self.ids["workflow"] = self.workflow_id(f"History caller {t}")
            mid, wid = self.ids["macro"], self.ids["workflow"]

            before = [r["id"] for r in self._all_runs()]
            # Each run shows the marker twice: the typed command and its output.
            self.play_macro(mid)
            self._played(marker, 2)
            fresh = self._await_records(before, {mid: "manual"})

            before = [r["id"] for r in self._all_runs()]
            self.switch_to_tab(self.ids["tab"])
            mac = sys.platform == "darwin"
            self.driver.press_key("p", meta=mac, ctrl=not mac, shift=not mac)
            self.wait(lambda: self.driver.exists("command-palette-input"), what="the palette")
            self.driver.type("command-palette-input", f"History macro {t}")
            item = f"command-palette-item-automation:{mid}"
            self.wait(lambda: self.driver.exists(item), what="the macro in the palette")
            self.driver.click(item)
            self._played(marker, 4)
            fresh += self._await_records(before, {mid: "palette"})

            before = [r["id"] for r in self._all_runs()]
            self.show_automations()
            self.run_workflow(wid)
            self._played(f"PR_HIST_W_{t}", 2)
            self._played(marker, 6)
            fresh += self._await_records(before, {wid: "manual", mid: "run-by-automation"})
            self.runs[:] = fresh

    def test_20_one_panel(self):
        with self.step(
            "automation-history.panel",
            "One history lists macro and workflow runs; rows show name, dot and time only",
            expect="the Automations sidebar's History: the four new runs, newest first, each row "
            "only the automation's name, a status dot and 'just now'; the nested run opened, "
            "showing 'Started by: Run by another automation', its steps and the terminal",
        ):
            self.require("automation-history.records")
            self.open_automation_history()
            self.wait(lambda: self.driver.exists("automation-history-list"), what="the history")
            assert not self.driver.exists("macro-history"), "the old macro history is still shown"
            for run in self.runs:
                rid = run["id"]
                toggle = f"automation-run-toggle-{rid}"
                self.wait(lambda tid=toggle: self.driver.exists(tid), what=f"the row of {rid}")
                text = self.driver.get_text(toggle)
                when = self.driver.get_text(f"automation-run-time-{rid}").strip()
                problems = row_problems(text, run["automationName"], run["status"], when)
                self.evidence(f"{rid} row {' '.join(text.split())!r}: {problems or 'ok'}")
                assert not problems, problems
            for run in self.runs:
                rid = run["id"]
                self.driver.click(f"automation-run-toggle-{rid}")
                origin_id = f"automation-run-origin-{rid}"
                self.wait(lambda oid=origin_id: self.driver.exists(oid), what=f"{rid} details")
                shown = self.driver.get_text(origin_id)
                problems = origin_problems(shown, run["origin"])
                self.evidence(f"{rid} ({run['origin']}): {shown!r}")
                assert not problems, problems
                target = self.driver.get_text(f"automation-run-target-{rid}").strip()
                assert target, f"{rid} names no terminal"
            nested = next(r for r in self.runs if r["origin"] == "run-by-automation")
            for run in self.runs:
                if run is not nested:
                    self.driver.click(f"automation-run-toggle-{run['id']}")
            self.shot(label="history-opened")

    def test_30_filter(self):
        with self.step(
            "automation-history.filter",
            "The history narrows to one automation, and × shows every run again",
            expect="the Automations sidebar's History filtered to 'History macro …' (the filter "
            "select shows its name, an × beside it), only the macro's three runs listed",
        ):
            self.require("automation-history.records")
            mid, wid = self.ids["macro"], self.ids["workflow"]
            self.show_automations()
            self.automation_menu(mid, "history")
            self.wait(lambda: self.driver.exists("automation-history-show-all"), what="the filter")
            listed = [r["id"] for r in self.runs if self.driver.exists(f"automation-run-{r['id']}")]
            problems = filtered_problems(listed, self.runs, mid)
            self.evidence(f"filtered list {listed}: {problems or 'ok'}")
            assert not problems, problems
            self.shot(label="filtered")
            self.driver.click("automation-history-show-all")
            assert not self.driver.exists("workflow-history"), "the old workflow history is shown"
            for run in self.runs:
                row = f"automation-run-{run['id']}"
                self.wait(lambda tid=row: self.driver.exists(tid), what=f"{row} unfiltered")
            assert any(r["automationId"] == wid for r in self.runs)

    def test_40_clear_one_automation(self):
        with self.step(
            "automation-history.clear",
            "Clearing the filtered history asks first and removes only that automation's runs",
            expect="a danger confirmation 'Clear the history of \"History macro …\"?' with "
            "Cancel, 'Clear all history' and a red 'Clear history'",
            screenshot=False,
        ):
            self.require("automation-history.filter")
            mid, wid = self.ids["macro"], self.ids["workflow"]
            self.open_automation_history()
            if not self.driver.exists("automation-history-show-all"):
                self.automation_menu(mid, "history")
            self.wait(lambda: self.driver.exists("automation-history-show-all"), what="the filter")
            label = self.driver.get_text("automation-history-clear").strip()
            assert label.startswith("Clear"), f"the clear action has no label: {label!r}"
            before = len(self._all_runs())
            self.driver.click("automation-history-clear")
            self.wait(
                lambda: self.driver.exists("automation-history-clear-confirm-cancel"),
                what="the confirmation",
            )
            assert self.driver.exists("automation-history-clear-confirm-alternate"), (
                "no 'Clear all history' choice while filtered"
            )
            self.shot(label="confirm")
            self.driver.click("automation-history-clear-confirm-cancel")
            self.wait(
                lambda: not self.driver.exists("automation-history-clear-confirm-cancel"),
                what="the confirmation to close",
            )
            assert len(self._all_runs()) == before, "canceling the confirmation cleared runs"
            self.driver.click("automation-history-clear")
            self.wait(
                lambda: self.driver.exists("automation-history-clear-confirm-confirm"),
                what="the confirmation",
            )
            self.driver.click("automation-history-clear-confirm-confirm")
            self.wait(
                lambda: not any(r.get("automationId") == mid for r in self._all_runs()),
                what="the macro's runs to clear",
            )
            left = [r["id"] for r in self._all_runs() if r.get("automationId") == wid]
            self.evidence(f"{before} runs before, {len(self._all_runs())} after; workflow {left}")
            assert left, "clearing the macro's history also cleared the workflow's run"
            self.wait(lambda: self.driver.exists("automation-history-empty"), what="empty state")
            self.driver.click("automation-history-show-all")
            self.close_all_tabs()
            self.switch_to_connections_sidebar()
