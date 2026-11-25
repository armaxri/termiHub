"""Grade automations as files and in the command palette (#5818, slice 11).

The functions here grade exported files, what a live run reads over the bridge
and what it stores; each returns a list of problems, empty when the surface
passes. No app needed.
"""

from __future__ import annotations

import json
from typing import Any, Mapping, Optional, Sequence

IMPORT_BUTTON = "import-migration-automations-import-btn"
EXPORT_BUTTON = "import-migration-automations-export-btn"
IMPORT_DIALOG = "automation-import-dialog"
#: Stamped or chosen by the import, so never compared.
IMPORT_OWNED = ("id", "name", "createdAt", "updatedAt", "triggersEnabled", "legacy")


def export_problems(text: str, names: Sequence[str]) -> list[str]:
    """An export is one versioned list that holds every named automation."""
    try:
        file = json.loads(text)
    except ValueError as exc:
        return [f"the export is not JSON: {exc}"]
    problems = []
    if file.get("version") != 1:
        problems.append(f"the export's version is {file.get('version')!r}")
    extra = sorted(set(file) - {"version", "automations"})
    if extra:
        problems.append(f"the export also holds {extra}")
    got = [a.get("name") for a in file.get("automations") or []]
    problems += [f"{name!r} is not in the export" for name in names if name not in got]
    return problems


def _clean(value: Any) -> Any:
    """``value`` without the parts every import changes: a script file reference."""
    if isinstance(value, list):
        return [_clean(v) for v in value]
    if isinstance(value, Mapping):
        return {k: _clean(v) for k, v in value.items() if k != "sourcePath"}
    return value


def round_trip_problems(
    original: Mapping[str, Any], copy: Optional[Mapping[str, Any]]
) -> list[str]:
    """The imported copy has everything the original has, and nothing else changed."""
    if copy is None:
        return ["the automation was not imported"]
    problems = []
    for key in sorted((set(original) | set(copy)) - set(IMPORT_OWNED)):
        want, got = _clean(original.get(key)), copy.get(key)
        if want != got:
            problems.append(f"{key} is {got!r}, not {want!r}")
    return problems


def disarmed_problems(automation: Optional[Mapping[str, Any]], marker: Optional[str]) -> list[str]:
    """An imported automation with triggers is stored and shown switched off."""
    problems = []
    if (automation or {}).get("triggersEnabled") is not False:
        problems.append("it is stored armed")
    if marker is None:
        problems.append("its row shows no marker")
    elif marker.strip() != "Off":
        problems.append(f"its row reads {marker!r}, not 'Off'")
    return problems


def called_problems(
    caller: Optional[Mapping[str, Any]], callee: Optional[Mapping[str, Any]]
) -> list[str]:
    """The imported caller's Run automation steps run the imported callee."""
    steps = [s for s in (caller or {}).get("steps") or [] if s.get("kind") == "run-automation"]
    if not steps:
        return ["the caller has no Run automation step"]
    want = (callee or {}).get("id")
    return [
        f"a step runs {step.get('automationId')!r}, not the imported {want!r}"
        for step in steps
        if want is None or step.get("automationId") != want
    ]


def palette_problems(row: Optional[str], name: str, terminal: str) -> list[str]:
    """A palette row is the name and the terminal it runs in; no kind word."""
    if row is None:
        return [f"{name!r} is not found"]
    problems = []
    if not row.startswith(name):
        problems.append(f"the row reads {row!r}")
    if terminal not in row:
        problems.append(f"the row does not say it runs in {terminal!r}: {row!r}")
    for word in ("macro", "workflow"):
        if word in row.replace(name, "").lower():
            problems.append(f"the row says {word!r}")
    return problems
