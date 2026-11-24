"""Grades for the single automation store (#5818, slice 4).

Since slice 4 the macro and workflow views read and write ``automations.json``
and ``automation-runs.json`` only; the legacy ``macros.json``,
``workflows.json``, ``macro-runs.json`` and ``runs.json`` are frozen for older
builds. These pure functions grade what the live phase reads back from the
app's state and its config directory, and are tested app-free.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any, Mapping, Optional

#: The merged stores the UI writes since slice 4.
AUTOMATIONS_FILE = "automations.json"
AUTOMATION_RUNS_FILE = "automation-runs.json"
#: The frozen legacy stores, never written again.
LEGACY_FILES = ("macros.json", "workflows.json", "macro-runs.json", "runs.json")


def fingerprint(config_dir: Path, names: tuple[str, ...] = LEGACY_FILES) -> dict[str, Optional[str]]:
    """SHA-256 of each file's bytes (``None`` while absent)."""
    out: dict[str, Optional[str]] = {}
    for name in names:
        try:
            out[name] = hashlib.sha256((config_dir / name).read_bytes()).hexdigest()
        except OSError:
            out[name] = None
    return out


def frozen_problems(
    before: Mapping[str, Optional[str]], after: Mapping[str, Optional[str]]
) -> list[str]:
    """Every legacy file whose bytes changed (or that appeared or vanished)."""
    return [f"{name} was written" for name in before if before.get(name) != after.get(name)]


def _by_id(items: Any, item_id: str) -> Optional[dict[str, Any]]:
    if not isinstance(items, list):
        return None
    return next((i for i in items if isinstance(i, dict) and i.get("id") == item_id), None)


def _kinds(steps: Any) -> list[str]:
    """Every step kind, nested ones included."""
    kinds: list[str] = []
    for step in steps if isinstance(steps, list) else []:
        if not isinstance(step, dict):
            continue
        kinds.append(str(step.get("kind")))
        for key in ("then", "else", "body"):
            kinds.extend(_kinds(step.get(key)))
    return kinds


def library_problems(
    state_automations: Any, stored_automations: Any, macro_id: str, workflow_id: str
) -> list[str]:
    """The macro and the workflow saved from the old views are automations.

    ``state_automations`` is the store's ``automations`` list,
    ``stored_automations`` the ``automations`` list in ``automations.json``.
    The macro is one recorded ``type-keys`` step and no trigger; the workflow
    carries no legacy-only kind (``manual`` trigger, ``run-macro`` step).
    """
    problems: list[str] = []
    for where, items in (("the store", state_automations), (AUTOMATIONS_FILE, stored_automations)):
        macro = _by_id(items, macro_id)
        workflow = _by_id(items, workflow_id)
        if macro is None:
            problems.append(f"the macro is not in {where}")
        else:
            steps = macro.get("steps") or []
            if [s.get("kind") for s in steps if isinstance(s, dict)] != ["type-keys"]:
                problems.append(f"the macro in {where} is not one type-keys step")
            elif not (steps[0].get("chunks") or []):
                problems.append(f"the macro in {where} has no chunks")
            if macro.get("triggers"):
                problems.append(f"the macro in {where} has triggers")
        if workflow is None:
            problems.append(f"the workflow is not in {where}")
        else:
            trigger_kinds = [t.get("kind") for t in workflow.get("triggers") or [] if isinstance(t, dict)]
            if "manual" in trigger_kinds:
                problems.append(f"the workflow in {where} stores a manual trigger")
            if "run-macro" in _kinds(workflow.get("steps")):
                problems.append(f"the workflow in {where} stores a run-macro step")
    return problems


def history_problems(stored_runs: Any, macro_id: str, workflow_id: str) -> list[str]:
    """Both runs landed in ``automation-runs.json``, each in its own history.

    A macro playback carries ``targetCount`` (the Macros history shows it); a
    workflow run does not (the Workflows history shows it).
    """
    runs = [r for r in stored_runs if isinstance(r, dict)] if isinstance(stored_runs, list) else []
    problems: list[str] = []
    macro_runs = [r for r in runs if r.get("automationId") == macro_id]
    workflow_runs = [r for r in runs if r.get("automationId") == workflow_id]
    if not macro_runs:
        problems.append(f"no macro run in {AUTOMATION_RUNS_FILE}")
    elif any(r.get("targetCount") is None for r in macro_runs):
        problems.append("a macro run has no targetCount")
    if not workflow_runs:
        problems.append(f"no workflow run in {AUTOMATION_RUNS_FILE}")
    elif any(r.get("targetCount") is not None for r in workflow_runs):
        problems.append("a workflow run carries a targetCount")
    for run in macro_runs + workflow_runs:
        if run.get("status") != "completed":
            problems.append(f"run {run.get('id')} ended {run.get('status')!r}")
    return problems
