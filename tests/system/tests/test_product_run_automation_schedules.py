"""Product run: schedules run automations (#5818, slice 10).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). Since slice 10 a schedule names one
automation, picked in one picker, ``schedules.json`` is version 3, and every
fired attempt links the records it produced in the single automation run
history (``runIds``).

Steps: a local-shell terminal; a recorded (typed) automation from the Macros
sidebar and a command automation from the Automations sidebar; each scheduled
every minute from its row, which opens the editor with that automation picked;
each schedule fires by itself, prints into the terminal and links its
``scheduled`` record in ``automation-runs.json``; then both are switched off.

The ``test_grade_*`` functions grade fixed records without an app and run in
the normal lane.
"""

from __future__ import annotations

import json
import time
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
from termihub_harness.product_run.automation_schedules import (
    AUTOMATION_RUNS_FILE,
    SCHEDULES_FILE,
    edit_problems,
    linked_run_problems,
    schedule_file_problems,
    schedule_row_problems,
)
from termihub_harness.product_run.automation_steps import AutomationPhaseUi
from termihub_harness.product_run.ssh_steps import SshPhaseUi

#: A 1-minute schedule fires within a minute plus a 15 s tick; allow load.
SCHEDULE_BUDGET = 150.0


# ── app-free grade tests ──────────────────────────────────────────────────
def _doc(**schedule: Any) -> dict[str, Any]:
    base = {"id": "s1", "action": {"kind": "automation", "automationId": "a1"}}
    return {"version": "3", "schedules": [{**base, **schedule}]}


def test_grade_v3_schedule_naming_the_automation_passes():
    assert schedule_file_problems(_doc(), "s1", "a1") == []


def test_grade_v2_file_and_actions_fail():
    doc = _doc(action={"kind": "macro", "macroId": "a1"})
    doc["version"] = "2"
    problems = schedule_file_problems(doc, "s1", "a1")
    assert f"{SCHEDULES_FILE} is version '2', not 3" in problems
    assert any(p.startswith("the schedule's action is") for p in problems)
    assert any("keeps a v2 action" in p for p in problems)


def test_grade_wrong_automation_and_missing_schedule_fail():
    assert schedule_file_problems(_doc(), "s1", "other") == [
        "the schedule's action is {'kind': 'automation', 'automationId': 'a1'}, "
        "not {'kind': 'automation', 'automationId': 'other'}"
    ]
    assert schedule_file_problems(_doc(), "gone", "a1") == [
        f"the schedule is not in {SCHEDULES_FILE}"
    ]
    assert schedule_file_problems([], "s1", "a1") == [f"{SCHEDULES_FILE} is not a JSON object"]


def test_grade_v2_run_id_lists_fail():
    doc = _doc(history=[{"at": "t", "outcome": "completed", "macroRunIds": ["r"]}])
    assert schedule_file_problems(doc, "s1", "a1") == ["schedule s1 keeps v2 run-id lists"]


def _run(**over: Any) -> dict[str, Any]:
    return {"id": "r1", "automationId": "a1", "origin": "scheduled", **over}


def test_grade_linked_scheduled_run_passes():
    attempt = {"outcome": "completed", "runIds": ["r1"]}
    assert linked_run_problems(attempt, [_run()], "a1") == []


def test_grade_unlinked_or_mislabelled_runs_fail():
    assert linked_run_problems(None, [], "a1") == ["no attempt recorded"]
    assert linked_run_problems({"outcome": "skipped", "message": "why"}, [], "a1") == [
        "the attempt ended 'skipped': why",
        "the attempt links no run (runIds is empty)",
    ]
    attempt = {"outcome": "completed", "runIds": ["r1", "r2"], "workflowRunIds": ["r1"]}
    assert linked_run_problems(attempt, [_run(origin="manual", automationId="b")], "a1") == [
        "the attempt carries the v2 workflowRunIds",
        "run r1 is of 'b', not 'a1'",
        "run r1 has origin 'manual', not 'scheduled'",
        f"run r2 is not in {AUTOMATION_RUNS_FILE}",
    ]


def _edited(**over: Any) -> dict[str, Any]:
    return {
        "id": "s1", "name": "Nightly", "description": "Checks the hosts",
        "action": {"kind": "automation", "automationId": "a1", "legacySource": "macro"},
        "targets": {"kind": "connections", "connectionIds": ["c2", "c1"]},
        "missedRuns": "run-once", "connectIfNeeded": True, "enabled": True,
        "confirmedAt": "t", "history": [{"runIds": ["r1", "r2"]}],
        "updatedAt": "u", "futureFlag": 1, **over,
    }


def test_grade_rename_that_keeps_everything_passes():
    after = _edited(name="Renamed", updatedAt="later")
    assert edit_problems(_edited(), after, {"name": "Renamed"}) == []


def test_grade_each_lost_field_fails():
    for key in _edited():
        if key in ("id", "name", "updatedAt"):
            continue
        after = _edited(name="Renamed")
        del after[key]
        problems = edit_problems(_edited(), after, {"name": "Renamed"})
        assert len(problems) == 1 and problems[0].startswith(f"{key} is None"), (key, problems)


def test_grade_edit_that_did_not_take_or_lost_the_schedule_fails():
    assert edit_problems(_edited(), _edited(), {"name": "Renamed"}) == [
        "name is 'Nightly', not 'Renamed'"
    ]
    assert edit_problems(_edited(), None, {}) == [f"the schedule is not in {SCHEDULES_FILE}"]
    assert edit_problems(_edited(), _edited(new=1), {}) == ["new is 1, not None"]


def _row_problems(schedule: dict[str, Any], **texts: str) -> list[str]:
    lines = {
        "status": "Next run tomorrow 02:00",
        "rule": "Daily at 02:00",
        "what": "Backup on db-1",
        "last": "",
        **texts,
    }
    return schedule_row_problems(lines, schedule, automation_name="Backup", targets="db-1")


def test_grade_row_that_answers_everything_passes():
    assert _row_problems({"enabled": True}) == []
    assert _row_problems({"enabled": False}, status="Off until you switch it on") == []
    ran = {"enabled": False, "lastResult": {"outcome": "completed"}}
    assert _row_problems(ran, status="Off", last="Last run completed (today 02:00)") == []
    missed = {"enabled": True, "lastResult": {"outcome": "skipped"}}
    text = "Last run missed: termiHub was closed or the computer was asleep (due today 02:00)"
    assert _row_problems(missed, last=text) == []


def test_grade_row_without_an_answer_fails():
    assert _row_problems({"enabled": True}, status="") == [
        "a schedule that is on reads '', not its next run"
    ]
    assert _row_problems({"enabled": False}, status="Disabled") == [
        "a schedule that is off reads 'Disabled'",
        "'Disabled' is on the row: 'Disabled'",
    ]
    assert _row_problems({"enabled": True}, rule="") == ["the row does not say the rule"]
    assert _row_problems({"enabled": True}, what="Backup") == [
        "the row says 'Backup', not 'Backup on db-1'"
    ]
    failed = {"enabled": True, "lastResult": {"outcome": "failed"}}
    assert _row_problems(failed) == ["the row does not say how the last run ended: ''"]
    assert _row_problems(failed, last="Last run completed (today 02:00)") == [
        "the last run reads 'Last run completed (today 02:00)'"
    ]
    assert _row_problems({"enabled": True}, last="Last run failed") == [
        "a schedule that never ran says 'Last run failed'"
    ]


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunAutomationSchedules(
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
    phase = "Automation schedules"
    request_timeout = 60.0

    tag = unique_name("pr").split("-")[-1]
    ids: dict[str, str] = {}

    def _stored(self, file_name: str) -> Any:
        try:
            return json.loads((self.config_dir / file_name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _stored_runs(self) -> list[Any]:
        doc = self._stored(AUTOMATION_RUNS_FILE)
        runs = doc.get("runs") if isinstance(doc, dict) else None
        return runs if isinstance(runs, list) else []

    def _grade_row(self, schedule_id: str, automation_name: str, label: str) -> None:
        """Grade the schedule's row in Settings -> Schedules and take its picture."""
        texts = self.schedule_row_texts(schedule_id)
        self.evidence(f"row {texts}")
        problems = schedule_row_problems(
            texts,
            self.schedule(schedule_id) or {},
            automation_name=automation_name,
            targets=f"pr-sched-local-{self.tag}",
        )
        self.shot(label=label)
        assert not problems, problems

    def _fires_and_links(self, schedule_id: str, automation_id: str, marker: str) -> None:
        """Enable the schedule, wait for its first run, grade it, switch it off."""
        tab = self.ids["tab"]
        self.set_schedule_enabled(schedule_id, True)
        started = time.monotonic()
        try:
            attempt = self.wait(
                lambda: next(iter((self.schedule(schedule_id) or {}).get("history") or []), None),
                timeout=SCHEDULE_BUDGET,
                interval=2.0,
                what="the schedule's first run",
            )
            self.evidence(f"fired after {time.monotonic() - started:.0f}s: {attempt}")
            self.wait(lambda: marker in self.driver.read_terminal(tab), what="the scheduled output")
            def linked() -> bool:
                return not linked_run_problems(attempt, self._stored_runs(), automation_id)

            self.wait(linked, what="the linked scheduled run in automation-runs.json")
            problems = linked_run_problems(attempt, self._stored_runs(), automation_id)
            assert not problems, problems
        finally:
            self.set_schedule_enabled(schedule_id, False)
        problems = schedule_file_problems(self._stored(SCHEDULES_FILE), schedule_id, automation_id)
        self.evidence(f"{SCHEDULES_FILE} problems {problems}")
        assert not problems, problems

    def test_00_terminal(self):
        with self.step(
            "automation-schedules.terminal",
            "A saved local-shell connection, connected from the sidebar",
            expect="one local-shell terminal tab at a prompt",
        ):
            name = f"pr-sched-local-{self.tag}"
            self.switch_to_connections_sidebar()
            self.create_local_connection(name)
            self.ids["conn"] = self.require_stable_connection(name)["id"]
            # A sidebar connect carries the saved connection's id, which is
            # what a schedule targets (#5257).
            self.connect_connection(name)
            self.ids["tab"] = self.tab_id_of(name)
            self.wait_connected(self.ids["tab"])
            self.evidence(self.echo_round_trip(self.ids["tab"], f"PR_SCHED_{self.tag}"))

    def test_10_typed_automation_on_a_schedule(self):
        with self.step(
            "automation-schedules.typed",
            "A recorded automation scheduled from its row fires and links its run",
            expect="Settings -> Schedules with the schedule switched off after its run; the "
            "terminal shows the scheduled echo line",
            screenshot=False,
        ):
            t = self.tag
            self.ids["typed"] = self.create_macro(f"Sched typed {t}", [f"echo PR_SCHED_T_{t}\\r"])
            sid = self.schedule_automation(self.ids["typed"], f"Typed every minute {t}", self.ids["conn"])
            self._fires_and_links(sid, self.ids["typed"], f"PR_SCHED_T_{t}")
            self._grade_row(sid, f"Sched typed {t}", "typed-off")

    def test_20_command_automation_on_a_schedule(self):
        with self.step(
            "automation-schedules.command",
            "A command automation scheduled from its row fires and links its run",
            expect="Settings -> Schedules with both schedules switched off; the terminal shows "
            "the scheduled command's output",
            screenshot=False,
        ):
            t = self.tag
            self.show_automations()
            self.author_workflow(
                f"Sched command {t}", [("send-command", {"step-command": f"echo PR_SCHED_C_{t}"})]
            )
            self.save_workflow()
            self.ids["command"] = self.workflow_id(f"Sched command {t}")
            sid = self.schedule_automation(
                self.ids["command"], f"Command every minute {t}", self.ids["conn"]
            )
            self._fires_and_links(sid, self.ids["command"], f"PR_SCHED_C_{t}")
            self._grade_row(sid, f"Sched command {t}", "command-off")
            self.close_all_tabs()
            self.switch_to_connections_sidebar()
