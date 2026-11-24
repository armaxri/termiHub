"""Grades for the one Automation history panel (#5818, slice 9).

Since slice 9 there is one history, in the Automations sidebar since slice 6: every run
record from ``automation-runs.json``, rows with the name, a status dot and the
time only, and each run's origin, outcome, steps and terminals behind the row.
Who started a run reads one of five labels. These pure functions grade what the
live phase reads back from the app, and are tested app-free.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Mapping

from .grades import row_leftover_text

#: The unified origin label of every recorded origin (``historyFormat.ts``).
ORIGIN_LABELS: dict[str, str] = {
    "manual": "Run by you",
    "palette": "Run by you",
    "hotkey": "Run by hotkey",
    "on-connect": "Run by trigger",
    "on-disconnect": "Run by trigger",
    "on-output-match": "Run by trigger",
    "scheduled": "Run by schedule",
    "run-by-automation": "Run by another automation",
}

#: The outcome wording of each stored status (US spelling for ``cancelled``).
STATUS_LABELS: dict[str, str] = {
    "completed": "Completed",
    "failed": "Failed",
    "cancelled": "Canceled",
}

#: A step counter ("3/3", "2 steps", "2 of 3 steps"): never on a row at rest.
STEP_COUNT = re.compile(r"\b\d+\s*/\s*\d+\b|\b\d+\s+(?:of\s+\d+\s+)?steps?\b", re.I)


def _runs(stored: Any) -> list[dict[str, Any]]:
    return [r for r in stored if isinstance(r, dict)] if isinstance(stored, list) else []


def new_runs(stored: Any, before_ids: Iterable[str]) -> list[dict[str, Any]]:
    """The runs recorded since ``before_ids`` was taken, in stored order."""
    seen = set(before_ids)
    return [r for r in _runs(stored) if r.get("id") not in seen]


def record_problems(runs: Any, expected: Mapping[str, str]) -> list[str]:
    """Each automation in ``expected`` has exactly one new record with its origin.

    ``runs`` are the records new to this step, ``expected`` maps an automation
    id to the origin its one record must carry.
    """
    problems: list[str] = []
    for automation_id, origin in expected.items():
        mine = [r for r in _runs(runs) if r.get("automationId") == automation_id]
        if len(mine) != 1:
            problems.append(f"{len(mine)} records for {automation_id}, want 1")
        elif mine[0].get("origin") != origin:
            problems.append(
                f"the record for {automation_id} says {mine[0].get('origin')!r}, want {origin!r}"
            )
    return problems


def row_problems(row_text: str, name: str, status: str, time_text: str) -> list[str]:
    """A history row at rest shows the name, the status and the time, nothing else."""
    problems: list[str] = []
    shown = " ".join(row_text.split())
    if name not in shown:
        problems.append(f"the row does not name {name!r}: {shown!r}")
    counts = STEP_COUNT.findall(shown)
    if counts:
        problems.append(f"the row shows a step count {counts}: {shown!r}")
    if "Run by" in shown:
        problems.append(f"the row shows its origin at rest: {shown!r}")
    left = row_leftover_text(shown, [STATUS_LABELS.get(status, status), name, time_text])
    if left:
        problems.append(f"settings text on the row: {left!r}")
    return problems


def origin_problems(shown: str, origin: str) -> list[str]:
    """A disclosed run names who started it with the unified label."""
    want = ORIGIN_LABELS.get(origin)
    if want is None:
        return [f"unknown origin {origin!r}"]
    text = " ".join(shown.split())
    if not text.startswith(want):
        return [f"origin reads {text!r}, want {want!r}"]
    if origin == "palette" and "command palette" not in text:
        return [f"a palette run does not say so: {text!r}"]
    return []


def filtered_problems(listed_ids: Iterable[str], runs: Any, automation_id: str) -> list[str]:
    """The filtered list holds exactly that automation's runs."""
    want = {r.get("id") for r in _runs(runs) if r.get("automationId") == automation_id}
    got = set(listed_ids)
    problems: list[str] = []
    if got - want:
        problems.append(f"runs of other automations listed: {sorted(got - want)}")
    if want - got:
        problems.append(f"runs of the automation missing: {sorted(want - got)}")
    return problems
