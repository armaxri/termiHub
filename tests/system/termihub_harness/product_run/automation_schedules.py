"""Grades for schedules v3: schedules run automations (#5818, slice 10).

Since slice 10 a schedule's action names one automation
(``{kind: "automation", automationId}``), ``schedules.json`` is version 3, and
each attempt links the automation run-history records it produced as
``runIds``. These pure functions grade what the live phase reads back from the
app's state and its config directory, and are tested app-free.
"""

from __future__ import annotations

from typing import Any, Optional

#: The schedules store and the single run history it links into.
SCHEDULES_FILE = "schedules.json"
AUTOMATION_RUNS_FILE = "automation-runs.json"
#: The v2 keys that must not survive in a v3 file.
LEGACY_ACTION_KEYS = ("macroId", "workflowId")
LEGACY_RUN_KEYS = ("macroRunIds", "workflowRunIds")


def _by_id(items: Any, item_id: str) -> Optional[dict[str, Any]]:
    if not isinstance(items, list):
        return None
    return next((i for i in items if isinstance(i, dict) and i.get("id") == item_id), None)


def schedule_file_problems(doc: Any, schedule_id: str, automation_id: str) -> list[str]:
    """``schedules.json`` is v3 and the schedule runs ``automation_id``.

    ``doc`` is the parsed file. No schedule keeps a v2 action kind or a v2
    run-id list.
    """
    if not isinstance(doc, dict):
        return [f"{SCHEDULES_FILE} is not a JSON object"]
    problems: list[str] = []
    if str(doc.get("version")) != "3":
        problems.append(f"{SCHEDULES_FILE} is version {doc.get('version')!r}, not 3")
    schedules = doc.get("schedules")
    schedule = _by_id(schedules, schedule_id)
    if schedule is None:
        problems.append(f"the schedule is not in {SCHEDULES_FILE}")
    else:
        action = schedule.get("action")
        expected = {"kind": "automation", "automationId": automation_id}
        if action != expected:
            problems.append(f"the schedule's action is {action!r}, not {expected!r}")
    for s in schedules if isinstance(schedules, list) else []:
        if not isinstance(s, dict):
            continue
        action = s.get("action") if isinstance(s.get("action"), dict) else {}
        if any(key in action for key in LEGACY_ACTION_KEYS):
            problems.append(f"schedule {s.get('id')} keeps a v2 action {action!r}")
        attempts = list(s.get("history") or []) + [s.get("lastResult") or {}]
        if any(isinstance(a, dict) and any(k in a for k in LEGACY_RUN_KEYS) for a in attempts):
            problems.append(f"schedule {s.get('id')} keeps v2 run-id lists")
    return problems


#: What an edit may change besides the fields the user touched.
EDIT_STAMPS = ("updatedAt",)


def edit_problems(before: Any, after: Any, changed: dict[str, Any]) -> list[str]:
    """An edit changed exactly ``changed`` of the stored schedule (#5983).

    ``before`` and ``after`` are the schedule as ``schedules.json`` holds it.
    Every other key, also one this build does not know, must be as it was: the
    description, "Connect if not connected", the targets, the confirmation, the
    missed-run policy and the links to runs.
    """
    if not isinstance(before, dict) or not isinstance(after, dict):
        return [f"the schedule is not in {SCHEDULES_FILE}"]
    problems: list[str] = []
    for key in sorted(set(before) | set(after) | set(changed)):
        if key in EDIT_STAMPS:
            continue
        expected = changed[key] if key in changed else before.get(key)
        if after.get(key) != expected:
            problems.append(f"{key} is {after.get(key)!r}, not {expected!r}")
    return problems


def linked_run_problems(attempt: Any, stored_runs: Any, automation_id: str) -> list[str]:
    """A fired attempt links its records in the single automation run history.

    The attempt completed and names at least one ``runIds`` entry; each id is
    a run of ``automation_id`` in ``automation-runs.json`` with origin
    ``scheduled``.
    """
    if not isinstance(attempt, dict):
        return ["no attempt recorded"]
    problems: list[str] = []
    if attempt.get("outcome") != "completed":
        problems.append(f"the attempt ended {attempt.get('outcome')!r}: {attempt.get('message')}")
    for key in LEGACY_RUN_KEYS:
        if key in attempt:
            problems.append(f"the attempt carries the v2 {key}")
    run_ids = attempt.get("runIds")
    if not isinstance(run_ids, list) or not run_ids:
        problems.append("the attempt links no run (runIds is empty)")
        return problems
    runs = [r for r in stored_runs if isinstance(r, dict)] if isinstance(stored_runs, list) else []
    for run_id in run_ids:
        run = _by_id(runs, str(run_id))
        if run is None:
            problems.append(f"run {run_id} is not in {AUTOMATION_RUNS_FILE}")
            continue
        if run.get("automationId") != automation_id:
            problems.append(f"run {run_id} is of {run.get('automationId')!r}, not {automation_id!r}")
        if run.get("origin") != "scheduled":
            problems.append(f"run {run_id} has origin {run.get('origin')!r}, not 'scheduled'")
    return problems


def schedule_row_problems(
    texts: dict[str, str],
    schedule: dict[str, Any],
    *,
    automation_name: str,
    targets: str,
) -> list[str]:
    """What is wrong with a schedule's row (#6024): it must say whether it is on and
    when it next runs, its rule, what it runs where, and how the last run ended.

    ``texts`` are the row's lines by name (``status``, ``rule``, ``what``, ``last``);
    a line the row lacks is absent or empty.
    """
    problems: list[str] = []
    status = texts.get("status", "")
    if schedule.get("enabled"):
        if not (status.startswith("Next run ") or status == "Running now"):
            problems.append(f"a schedule that is on reads {status!r}, not its next run")
    elif status not in ("Off", "Off until you switch it on"):
        problems.append(f"a schedule that is off reads {status!r}")
    if not texts.get("rule"):
        problems.append("the row does not say the rule")
    what = f"{automation_name} on {targets}"
    if texts.get("what") != what:
        problems.append(f"the row says {texts.get('what')!r}, not {what!r}")
    last = texts.get("last", "")
    if schedule.get("lastResult"):
        if not last.startswith("Last run "):
            problems.append(f"the row does not say how the last run ended: {last!r}")
        elif (schedule["lastResult"].get("outcome") == "completed") != (
            last.startswith(("Last run completed", "Last run left some out"))
        ):
            problems.append(f"the last run reads {last!r}")
    elif last:
        problems.append(f"a schedule that never ran says {last!r}")
    for text in texts.values():
        for word in ("Disabled", "Enabled", "Armed", "playback"):
            if word.lower() in text.lower():
                problems.append(f"{word!r} is on the row: {text!r}")
    return problems
