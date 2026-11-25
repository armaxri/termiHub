"""Grade the one automation editor (#5818, slice 7), without an app.

It replaced the keystroke editor and the step editor. The functions here grade
what a live run reads over the bridge; each returns a list of problems, empty
when the surface passes.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional, Sequence

#: What a user who only records and replays keys must not see without asking:
#: triggers, values to ask for, a step's fields, its failure options.
ON_REQUEST = (
    "automation-editor-when",
    "automation-editor-add-trigger",
    "automation-editor-armed",
    "automation-editor-values-toggle",
    "automation-params-add",
    "automation-editor-tags",
    "automation-editor-step-policy-0",
)
#: The footer, of a new automation and of a stored one; the last is the primary (A-021).
FOOTER = ("Cancel", "Save and run", "Save")
#: The tallest a collapsed step row may be, in CSS pixels.
MAX_ROW_PX = 48.0
#: Rounding slack for box comparisons, in CSS pixels.
EPS = 1.0

Rect = Mapping[str, float]


def disclosure_problems(shown: Sequence[str], keys_row: str, recorded: bool) -> list[str]:
    """A keys-only automation shows its keys as one line and nothing on request.

    ``shown`` are the test ids of :data:`ON_REQUEST` that exist; ``keys_row`` the
    text of its collapsed row.
    """
    problems = [f"{testid} shows unasked" for testid in shown]
    if "Type keys" not in keys_row:
        problems.append(f"the keys row reads {keys_row!r}")
    if recorded and "Recorded" not in keys_row:
        problems.append(f"the keys row does not say 'Recorded': {keys_row!r}")
    return problems


def footer_problems(labels: Sequence[str], run_in: Optional[str] = None) -> list[str]:
    """The footer's buttons, Cancel first and Save last; Save and run names its target."""
    run = "Save and run…" if run_in is None else f"Save and run in {run_in}"
    want = [FOOTER[0], run, FOOTER[2]]
    got = [label for label in labels if label in want or label.startswith(FOOTER[1])]
    return [] if got == want else [f"the footer reads {got}, not {want}"]


def layout_problems(
    window: tuple[float, float], dialog: Rect, rows: Sequence[Rect], save: Rect
) -> list[str]:
    """The dialog fits the window; its collapsed steps are one line each, in view."""
    problems = []
    if dialog["y"] < -EPS or dialog["y"] + dialog["height"] > window[1] + EPS:
        problems.append(f"the dialog {dict(dialog)} does not fit {window}")
    if dialog["x"] < -EPS or dialog["x"] + dialog["width"] > window[0] + EPS:
        problems.append(f"the dialog {dict(dialog)} is wider than {window}")
    if not rows:
        problems.append("no step rows")
    for i, row in enumerate(rows):
        if row["height"] > MAX_ROW_PX:
            problems.append(f"step {i} is {row['height']:.0f}px tall")
        if row["y"] + row["height"] > save["y"] + EPS:
            problems.append(f"step {i} is below the fold")
    return problems


def stored_keys_problems(
    automation: Optional[Mapping[str, Any]],
    data: Sequence[str],
    timing: str,
    step: int = 0,
) -> list[str]:
    """Step ``step`` types exactly ``data`` at the saved speed ``timing`` (#5820)."""
    steps = list((automation or {}).get("steps") or [])
    if len(steps) <= step or steps[step].get("kind") != "type-keys":
        return [f"step {step} is not a Type keys step: {[s.get('kind') for s in steps]}"]
    problems = []
    got = [c.get("data") for c in steps[step].get("chunks") or []]
    if got != list(data):
        problems.append(f"it types {got!r}, not {list(data)!r}")
    saved = steps[step].get("timing")
    if saved != timing:
        problems.append(f"its speed is {saved!r}, not {timing!r}")
    return problems


def trigger_problems(automation: Optional[Mapping[str, Any]], kinds: Sequence[str]) -> list[str]:
    """The stored triggers are of ``kinds``, in order (and never ``manual``)."""
    got = [t.get("kind") for t in (automation or {}).get("triggers") or []]
    return [] if got == list(kinds) else [f"the triggers are {got}, not {list(kinds)}"]


def untouched_problems(before: Optional[str], after: Optional[str]) -> list[str]:
    """Opening and saving an unchanged automation left its file's bytes alone."""
    if before is None:
        return ["automations.json was not there to compare"]
    return [] if before == after else ["saving an unchanged automation rewrote automations.json"]


def speed_problems(seconds: float, recorded_ms: int) -> list[str]:
    """An instant run takes far less time than its keys' delays add up to."""
    if seconds * 1000 < recorded_ms / 2:
        return []
    return [f"the instant run took {seconds:.1f}s; its delays add up to {recorded_ms / 1000:.1f}s"]
